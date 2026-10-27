/** A bitmap with light text on a transparent background, as PGS subtitles carry it. */
export interface PgsBitmap {
	width: number;
	height: number;
	/** Luma 0 to 255 per pixel. */
	luma: Uint8Array;
	/** Opacity 0 to 255 per pixel. */
	alpha: Uint8Array;
}

export interface PgsCue {
	startMs: number;
	endMs: number;
	bitmap: PgsBitmap;
	/** Also show it at half opacity first, as a fade in does with a palette update. */
	fadeIn?: boolean;
}

function segment(ms: number, type: number, payload: Buffer): Buffer {
	const header = Buffer.alloc(13);
	header.write("PG");
	header.writeUInt32BE(Math.round(ms * 90), 2);
	header[10] = type;
	header.writeUInt16BE(payload.length, 11);
	return Buffer.concat([header, payload]);
}

const u16 = (n: number) => Buffer.from([n >> 8, n & 255]);

/** Palette index 0 is transparent, the rest are 8 luma by 8 opacity levels. */
function quantize(b: PgsBitmap): Uint8Array {
	const out = new Uint8Array(b.width * b.height);
	for (let i = 0; i < out.length; i++) {
		const a = b.alpha[i]! >> 5;
		out[i] = a === 0 ? 0 : 1 + (b.luma[i]! >> 5) * 8 + a;
	}
	return out;
}

function palette(id: number, alphaScale: number): Buffer {
	const entries: number[] = [id, 0];
	for (let l = 0; l < 8; l++)
		for (let a = 1; a < 8; a++)
			entries.push(1 + l * 8 + a, Math.round(16 + ((l * 32 + 16) * 219) / 255), 128, 128, Math.round(((a * 32 + 16) * alphaScale) / 1));
	return Buffer.from(entries.map((v) => Math.min(255, v)));
}

function rle(indexes: Uint8Array, width: number, height: number): Buffer {
	const out: number[] = [];
	for (let y = 0; y < height; y++) {
		let x = 0;
		while (x < width) {
			const color = indexes[y * width + x]!;
			let run = 1;
			while (x + run < width && indexes[y * width + x + run] === color && run < 16383) run++;
			if (color !== 0 && run <= 2) for (let k = 0; k < run; k++) out.push(color);
			else if (color === 0) out.push(0, ...(run < 64 ? [run] : [0x40 | (run >> 8), run & 255]));
			else out.push(0, ...(run < 64 ? [0x80 | run] : [0xc0 | (run >> 8), run & 255]), color);
			x += run;
		}
		out.push(0, 0);
	}
	return Buffer.from(out);
}

/** Builds a PGS (.sup) stream that shows every cue at the bottom of a 1080p frame. */
export function buildPgs(cues: PgsCue[]): Buffer {
	const parts: Buffer[] = [];
	let number = 0;
	const composition = (ms: number, state: number, paletteUpdate: boolean, x: number, y: number, show: boolean) =>
		segment(
			ms,
			0x16,
			Buffer.concat([
				u16(1920),
				u16(1080),
				Buffer.from([0x10]),
				u16(number++),
				Buffer.from([state, paletteUpdate ? 0x80 : 0, 0, show ? 1 : 0]),
				...(show ? [u16(0), Buffer.from([0, 0]), u16(x), u16(y)] : []),
			]),
		);
	for (const cue of cues) {
		const { width, height } = cue.bitmap;
		const x = Math.round((1920 - width) / 2);
		const y = 1080 - height - 60;
		const data = rle(quantize(cue.bitmap), width, height);
		const window = segment(cue.startMs, 0x17, Buffer.concat([Buffer.from([1, 0]), u16(x), u16(y), u16(width), u16(height)]));
		const object = segment(
			cue.startMs,
			0x15,
			Buffer.concat([
				u16(0),
				Buffer.from([0, 0xc0]),
				Buffer.from([(data.length + 4) >> 16, ((data.length + 4) >> 8) & 255, (data.length + 4) & 255]),
				u16(width),
				u16(height),
				data,
			]),
		);
		const shownAt = cue.fadeIn ? cue.startMs + 200 : cue.startMs;
		if (cue.fadeIn)
			parts.push(
				composition(cue.startMs, 0x80, false, x, y, true),
				window,
				segment(cue.startMs, 0x14, palette(0, 0.4)),
				object,
				segment(cue.startMs, 0x80, Buffer.alloc(0)),
			);
		parts.push(
			cue.fadeIn ? composition(shownAt, 0x00, true, x, y, true) : composition(shownAt, 0x80, false, x, y, true),
			...(cue.fadeIn ? [] : [window]),
			segment(shownAt, 0x14, palette(0, 1)),
			...(cue.fadeIn ? [] : [object]),
			segment(shownAt, 0x80, Buffer.alloc(0)),
			composition(cue.endMs, 0x00, false, 0, 0, false),
			segment(cue.endMs, 0x80, Buffer.alloc(0)),
		);
	}
	return Buffer.concat(parts);
}
