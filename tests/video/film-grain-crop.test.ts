import { describe, expect, test } from "bun:test";
import { filmGrainCropFilter, locateFilmGrainCrop, type GrayFrame } from "../../src/video/film-grain-crop";

const noise = (seed: number) => () => {
	seed = (seed * 1664525 + 1013904223) >>> 0;
	return seed / 0x100000000;
};

/** A picture with detail inside black bars, and the same picture cropped with small pixel differences. */
function pair(width: number, height: number, w: number, h: number, x: number, y: number, seed: number): { original: GrayFrame; denoised: GrayFrame } {
	const random = noise(seed);
	const original = new Uint8Array(width * height);
	for (let row = y; row < y + h; row++) {
		for (let column = x; column < x + w; column++) original[row * width + column] = 40 + Math.floor(random() * 160);
	}
	const denoised = new Uint8Array(w * h);
	for (let row = 0; row < h; row++) {
		for (let column = 0; column < w; column++) denoised[row * w + column] = original[(row + y) * width + column + x]! + Math.floor(random() * 5) - 2;
	}
	return { original: { data: original, width, height }, denoised: { data: denoised, width: w, height: h } };
}

describe("film grain crop", () => {
	test("finds a letterbox crop that is not centered", () => {
		const frames = [1, 2, 3].map((seed) => pair(160, 120, 160, 88, 0, 14, seed));
		const crop = locateFilmGrainCrop(
			frames.map((frame) => frame.original),
			frames.map((frame) => frame.denoised),
		);
		expect(crop).toEqual({ w: 160, h: 88, x: 0, y: 14 });
		expect(filmGrainCropFilter(crop!)).toBe("crop=160:88:0:14");
	});

	test("finds a crop on both axes", () => {
		const frames = [4, 5].map((seed) => pair(160, 120, 120, 90, 23, 9, seed));
		const crop = locateFilmGrainCrop(
			frames.map((frame) => frame.original),
			frames.map((frame) => frame.denoised),
		);
		expect(crop).toEqual({ w: 120, h: 90, x: 23, y: 9 });
	});

	test("returns null for flat frames and rejects a larger denoised frame", () => {
		const flat = (width: number, height: number): GrayFrame => ({ data: new Uint8Array(width * height).fill(16), width, height });
		expect(locateFilmGrainCrop([flat(160, 120)], [flat(160, 88)])).toBeNull();
		expect(() => locateFilmGrainCrop([flat(160, 88)], [flat(160, 120)])).toThrow();
	});
});
