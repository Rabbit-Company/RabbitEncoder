import { closeSync, openSync, readSync } from "fs";

export interface IvfFrame {
	/** Bytes of the temporal unit, which is one shown frame. */
	size: number;
	/** The unit starts with a key frame, where the encoder found a scene. */
	keyframe: boolean;
}

export interface IvfInfo {
	width: number;
	height: number;
	/** Frames per second as the header's rate over scale. */
	fpsNum: number;
	fpsDen: number;
	frames: IvfFrame[];
}

const OBU_SEQUENCE_HEADER = 1;
const OBU_FRAME_HEADER = 3;
const OBU_FRAME = 6;
const KEY_FRAME = 0;

function leb128(data: Uint8Array, at: number): { value: number; length: number } {
	let value = 0;
	for (let i = 0; i < 8; i++) {
		const byte = data[at + i]!;
		value += (byte & 0x7f) * 2 ** (7 * i);
		if (!(byte & 0x80)) return { value, length: i + 1 };
	}
	throw new Error("Invalid LEB128 value in an AV1 stream");
}

/**
 * Whether a temporal unit holds a key frame. A frame header's first bits say
 * so: show_existing_frame, then frame_type, unless the sequence uses the
 * reduced still picture header, where every frame is a key frame.
 */
function unitHasKeyframe(data: Uint8Array, reducedStill: { value: boolean }): boolean {
	let at = 0;
	while (at < data.length) {
		const header = data[at]!;
		const type = (header >> 3) & 0xf;
		const extension = (header >> 2) & 1;
		const hasSize = (header >> 1) & 1;
		at += 1 + extension;
		let size = data.length - at;
		if (hasSize) {
			const length = leb128(data, at);
			size = length.value;
			at += length.length;
		}
		if (type === OBU_SEQUENCE_HEADER && size > 0) reducedStill.value = ((data[at]! >> 3) & 1) === 1;
		if ((type === OBU_FRAME || type === OBU_FRAME_HEADER) && size > 0) {
			if (reducedStill.value) return true;
			const bits = data[at]!;
			const showExisting = bits >> 7;
			if (!showExisting && ((bits >> 5) & 0b11) === KEY_FRAME) return true;
		}
		at += size;
	}
	return false;
}

/** The frame size in the header of an IVF file, which an encoder writes before its first frame. */
export function readIvfSize(path: string): { width: number; height: number } | null {
	let fd: number | null = null;
	try {
		fd = openSync(path, "r");
		const header = Buffer.alloc(32);
		if (readSync(fd, header, 0, 32, 0) < 32 || header.toString("latin1", 0, 4) !== "DKIF") return null;
		return { width: header.readUInt16LE(12), height: header.readUInt16LE(14) };
	} catch {
		return null;
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

/**
 * Frame sizes and key frames of an AV1 IVF file, read without decoding it.
 * The file is read one frame at a time, since a fast pass of a long film is
 * larger than the memory Node can allocate in one buffer.
 */
export function readIvf(path: string): IvfInfo {
	const fd = openSync(path, "r");
	try {
		const header = Buffer.alloc(32);
		if (readSync(fd, header, 0, 32, 0) < 32 || header.toString("latin1", 0, 4) !== "DKIF") throw new Error(`${path} is not an IVF file`);
		const info: IvfInfo = {
			width: header.readUInt16LE(12),
			height: header.readUInt16LE(14),
			fpsNum: header.readUInt32LE(16),
			fpsDen: header.readUInt32LE(20),
			frames: [],
		};
		const reducedStill = { value: false };
		const frameHeader = Buffer.alloc(12);
		let unit = Buffer.alloc(1 << 20);
		let at = header.readUInt16LE(6);
		while (readSync(fd, frameHeader, 0, 12, at) === 12) {
			const size = frameHeader.readUInt32LE(0);
			if (size > unit.length) unit = Buffer.alloc(Math.max(size, unit.length * 2));
			if (readSync(fd, unit, 0, size, at + 12) < size) break;
			info.frames.push({ size, keyframe: unitHasKeyframe(unit.subarray(0, size), reducedStill) });
			at += 12 + size;
		}
		return info;
	} finally {
		closeSync(fd);
	}
}
