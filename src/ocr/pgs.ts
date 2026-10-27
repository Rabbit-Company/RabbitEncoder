import { createHash } from "crypto";

/** One subtitle as it was shown, rendered black on white for OCR. */
export interface PgsImage {
	startMs: number;
	endMs: number;
	width: number;
	height: number;
	/** Grayscale, one byte per pixel, 255 is paper. */
	pixels: Uint8Array;
	/** Same for pictures that render alike, so each is read only once. */
	hash: string;
}

const SEG_PDS = 0x14;
const SEG_ODS = 0x15;
const SEG_PCS = 0x16;
const SEG_END = 0x80;
/** Space around the text, so it does not touch the image edge. */
const PADDING = 12;
/** A subtitle still shown at the end of the stream is closed after this long. */
const LAST_CUE_MS = 4000;

interface ObjectRef {
	id: number;
	x: number;
	y: number;
	crop?: { x: number; y: number; w: number; h: number };
}

interface PgsObject {
	width: number;
	height: number;
	rle: Uint8Array[];
}

/** Decodes PGS run-length data into palette indexes. */
export function decodeRle(rle: Uint8Array, width: number, height: number): Uint8Array {
	const out = new Uint8Array(width * height);
	let i = 0;
	let x = 0;
	let y = 0;
	const put = (color: number, count: number) => {
		for (let k = 0; k < count && x < width; k++) out[y * width + x++] = color;
	};
	while (i < rle.length && y < height) {
		const b = rle[i++]!;
		if (b !== 0) {
			put(b, 1);
			continue;
		}
		const f = rle[i++] ?? 0;
		if (f === 0) {
			x = 0;
			y++;
			continue;
		}
		const long = (f & 0x40) !== 0;
		const count = long ? ((f & 0x3f) << 8) | (rle[i++] ?? 0) : f & 0x3f;
		put(f & 0x80 ? (rle[i++] ?? 0) : 0, count);
	}
	return out;
}

interface Rendered {
	width: number;
	height: number;
	pixels: Uint8Array;
	ink: number;
}

/**
 * Draws the objects of one display set. Dark ink is light text times its
 * opacity, so the usual white or yellow text turns black and its dark outline
 * blends into the white paper.
 */
function render(refs: ObjectRef[], objects: Map<number, PgsObject>, palette: Uint8Array): Rendered | null {
	const parts: Array<{ ref: ObjectRef; obj: PgsObject; indexes: Uint8Array }> = [];
	for (const ref of refs) {
		const obj = objects.get(ref.id);
		if (!obj || !obj.width || !obj.height) continue;
		const data = obj.rle.length === 1 ? obj.rle[0]! : Buffer.concat(obj.rle);
		parts.push({ ref, obj, indexes: decodeRle(data, obj.width, obj.height) });
	}
	if (!parts.length) return null;
	const box = (p: (typeof parts)[number]) => {
		const c = p.ref.crop;
		return c ? { x: p.ref.x, y: p.ref.y, w: c.w, h: c.h, sx: c.x, sy: c.y } : { x: p.ref.x, y: p.ref.y, w: p.obj.width, h: p.obj.height, sx: 0, sy: 0 };
	};
	const left = Math.min(...parts.map((p) => box(p).x));
	const top = Math.min(...parts.map((p) => box(p).y));
	const right = Math.max(...parts.map((p) => box(p).x + box(p).w));
	const bottom = Math.max(...parts.map((p) => box(p).y + box(p).h));
	const width = right - left + PADDING * 2;
	const height = bottom - top + PADDING * 2;
	const pixels = new Uint8Array(width * height).fill(255);
	let ink = 0;
	for (const p of parts) {
		const b = box(p);
		for (let y = 0; y < b.h; y++) {
			for (let x = 0; x < b.w; x++) {
				const sx = b.sx + x;
				const sy = b.sy + y;
				if (sx >= p.obj.width || sy >= p.obj.height) continue;
				const color = p.indexes[sy * p.obj.width + sx]!;
				const lum = palette[color * 2]!;
				const alpha = palette[color * 2 + 1]!;
				const value = Math.round((lum * alpha) / 255);
				if (!value) continue;
				ink += value;
				const at = (b.y - top + PADDING + y) * width + (b.x - left + PADDING + x);
				pixels[at] = Math.min(pixels[at]!, 255 - value);
			}
		}
	}
	return { width, height, pixels, ink };
}

/** Video range luma (16 to 235) to 0 to 255. */
function fullRange(y: number): number {
	return Math.max(0, Math.min(255, Math.round(((y - 16) * 255) / 219)));
}

/**
 * Reads a PGS (.sup) stream into the subtitles it shows. Display sets that
 * show the same objects, such as a fade that only changes the palette, are
 * one subtitle, drawn with its most opaque palette.
 */
export function parsePgs(sup: Uint8Array): PgsImage[] {
	const view = Buffer.from(sup.buffer, sup.byteOffset, sup.byteLength);
	const palettes = new Map<number, Uint8Array>();
	const objects = new Map<number, PgsObject>();
	const out: PgsImage[] = [];
	let open: { startMs: number; key: string; best: Rendered } | null = null;
	let pcs: { ms: number; paletteId: number; refs: ObjectRef[] } | null = null;

	const close = (ms: number) => {
		if (!open) return;
		if (ms > open.startMs) {
			const { width, height, pixels } = open.best;
			out.push({ startMs: open.startMs, endMs: ms, width, height, pixels, hash: createHash("sha1").update(pixels).update(`${width}x${height}`).digest("hex") });
		}
		open = null;
	};

	let i = 0;
	while (i + 13 <= view.length) {
		if (view[i] !== 0x50 || view[i + 1] !== 0x47) {
			i++;
			continue;
		}
		const ms = Math.round(view.readUInt32BE(i + 2) / 90);
		const type = view[i + 10]!;
		const size = view.readUInt16BE(i + 11);
		const p = view.subarray(i + 13, i + 13 + size);
		i += 13 + size;

		if (type === SEG_PCS && p.length >= 11) {
			if (p[7]! & 0x80) objects.clear();
			const refs: ObjectRef[] = [];
			let at = 11;
			for (let n = 0; n < p[10]! && at + 8 <= p.length; n++) {
				const ref: ObjectRef = { id: p.readUInt16BE(at), x: p.readUInt16BE(at + 4), y: p.readUInt16BE(at + 6) };
				const cropped = (p[at + 3]! & 0x40) !== 0;
				if (cropped && at + 16 <= p.length)
					ref.crop = { x: p.readUInt16BE(at + 8), y: p.readUInt16BE(at + 10), w: p.readUInt16BE(at + 12), h: p.readUInt16BE(at + 14) };
				at += cropped ? 16 : 8;
				refs.push(ref);
			}
			pcs = { ms, paletteId: p[9]!, refs };
		} else if (type === SEG_PDS && p.length >= 2) {
			const palette = palettes.get(p[0]!) ?? new Uint8Array(512);
			for (let at = 2; at + 5 <= p.length; at += 5) {
				palette[p[at]! * 2] = fullRange(p[at + 1]!);
				palette[p[at]! * 2 + 1] = p[at + 4]!;
			}
			palettes.set(p[0]!, palette);
		} else if (type === SEG_ODS && p.length >= 4) {
			const id = p.readUInt16BE(0);
			const first = (p[3]! & 0x80) !== 0;
			if (first && p.length >= 11) objects.set(id, { width: p.readUInt16BE(7), height: p.readUInt16BE(9), rle: [p.subarray(11)] });
			else objects.get(id)?.rle.push(p.subarray(4));
		} else if (type === SEG_END && pcs) {
			const shown = pcs.refs.length ? render(pcs.refs, objects, palettes.get(pcs.paletteId) ?? new Uint8Array(512)) : null;
			if (!shown || !shown.ink) {
				close(pcs.ms);
			} else {
				// The objects, not their palette, say which subtitle this is.
				const key = createHash("sha1")
					.update(pcs.refs.map((r) => `${r.id}:${r.x}:${r.y}:${objects.get(r.id)?.width}x${objects.get(r.id)?.height}`).join(","))
					.update(Buffer.concat(pcs.refs.flatMap((r) => objects.get(r.id)?.rle ?? [])))
					.digest("hex");
				const current = open as { startMs: number; key: string; best: Rendered } | null;
				if (current && current.key === key) {
					if (shown.ink > current.best.ink) current.best = shown;
				} else {
					close(pcs.ms);
					open = { startMs: pcs.ms, key, best: shown };
				}
			}
			pcs = null;
		}
	}
	const last = open as { startMs: number } | null;
	if (last) close(last.startMs + LAST_CUE_MS);
	return out;
}
