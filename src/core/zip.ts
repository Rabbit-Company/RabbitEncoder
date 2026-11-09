/** Minimal ZIP writer for already-compressed files such as PNG, and a reader for downloaded archives. Written entries are stored, not deflated. */

import { inflateRawSync } from "zlib";

export interface ZipEntry {
	name: string;
	data: Uint8Array;
}

/** DOS date and time of a moment, as ZIP headers store it. */
function dosDateTime(date: Date): { time: number; date: number } {
	return {
		time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
		date: (Math.max(0, date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
	};
}

export function buildZip(entries: ZipEntry[], modified = new Date()): Uint8Array<ArrayBuffer> {
	const { time, date } = dosDateTime(modified);
	const encoder = new TextEncoder();
	const locals: Uint8Array[] = [];
	const centrals: Uint8Array[] = [];
	let offset = 0;

	for (const entry of entries) {
		const name = encoder.encode(entry.name);
		const crc = Bun.hash.crc32(entry.data) >>> 0;
		const size = entry.data.length;

		const local = new Uint8Array(30 + name.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true);
		lv.setUint16(4, 20, true);
		lv.setUint16(6, 0x0800, true); // UTF-8 names
		lv.setUint16(8, 0, true); // stored
		lv.setUint16(10, time, true);
		lv.setUint16(12, date, true);
		lv.setUint32(14, crc, true);
		lv.setUint32(18, size, true);
		lv.setUint32(22, size, true);
		lv.setUint16(26, name.length, true);
		local.set(name, 30);
		locals.push(local, entry.data);

		const central = new Uint8Array(46 + name.length);
		const cv = new DataView(central.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(4, 20, true);
		cv.setUint16(6, 20, true);
		cv.setUint16(8, 0x0800, true);
		cv.setUint16(10, 0, true);
		cv.setUint16(12, time, true);
		cv.setUint16(14, date, true);
		cv.setUint32(16, crc, true);
		cv.setUint32(20, size, true);
		cv.setUint32(24, size, true);
		cv.setUint16(28, name.length, true);
		cv.setUint32(42, offset, true);
		central.set(name, 46);
		centrals.push(central);

		offset += local.length + size;
	}

	const centralSize = centrals.reduce((n, c) => n + c.length, 0);
	const end = new Uint8Array(22);
	const ev = new DataView(end.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, entries.length, true);
	ev.setUint16(10, entries.length, true);
	ev.setUint32(12, centralSize, true);
	ev.setUint32(16, offset, true);

	const out = new Uint8Array(offset + centralSize + end.length);
	let at = 0;
	for (const part of [...locals, ...centrals, end]) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

export function isZip(bytes: Uint8Array): boolean {
	return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/**
 * Reads the files of a ZIP archive that are stored or deflated, from its
 * central directory. Folders, encrypted files and other methods are skipped.
 */
export function readZip(bytes: Uint8Array, maxEntrySize = 64 * 1024 * 1024): ZipEntry[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let end = -1;
	for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
		if (view.getUint32(i, true) === 0x06054b50) {
			end = i;
			break;
		}
	}
	if (end < 0) throw new Error("Not a ZIP archive");
	const count = view.getUint16(end + 10, true);
	let at = view.getUint32(end + 16, true);
	const utf8 = new TextDecoder("utf-8");
	const latin = new TextDecoder("latin1");
	const out: ZipEntry[] = [];
	for (let n = 0; n < count && at + 46 <= bytes.length; n++) {
		if (view.getUint32(at, true) !== 0x02014b50) break;
		const flags = view.getUint16(at + 8, true);
		const method = view.getUint16(at + 10, true);
		const packed = view.getUint32(at + 20, true);
		const size = view.getUint32(at + 24, true);
		const nameLength = view.getUint16(at + 28, true);
		const skip = nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
		const local = view.getUint32(at + 42, true);
		const rawName = bytes.subarray(at + 46, at + 46 + nameLength);
		const name = (flags & 0x0800 ? utf8 : latin).decode(rawName);
		at += 46 + skip;
		if (name.endsWith("/") || flags & 0x0001 || size > maxEntrySize) continue;
		if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) continue;
		const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
		const data = bytes.subarray(start, start + packed);
		if (method === 0) out.push({ name, data: data.slice() });
		else if (method === 8) {
			try {
				out.push({ name, data: new Uint8Array(inflateRawSync(data, { maxOutputLength: maxEntrySize })) });
			} catch {}
		}
	}
	return out;
}
