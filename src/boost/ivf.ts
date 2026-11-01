import { readFileSync } from "fs";

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

/** Frame sizes and key frames of an AV1 IVF file, read without decoding it. */
export function readIvf(path: string): IvfInfo {
	const data = new Uint8Array(readFileSync(path));
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	if (data.length < 32 || String.fromCharCode(...data.subarray(0, 4)) !== "DKIF") throw new Error(`${path} is not an IVF file`);
	const headerLength = view.getUint16(6, true);
	const info: IvfInfo = {
		width: view.getUint16(12, true),
		height: view.getUint16(14, true),
		fpsNum: view.getUint32(16, true),
		fpsDen: view.getUint32(20, true),
		frames: [],
	};
	const reducedStill = { value: false };
	let at = headerLength;
	while (at + 12 <= data.length) {
		const size = view.getUint32(at, true);
		const start = at + 12;
		if (start + size > data.length) break;
		info.frames.push({ size, keyframe: unitHasKeyframe(data.subarray(start, start + size), reducedStill) });
		at = start + size;
	}
	return info;
}
