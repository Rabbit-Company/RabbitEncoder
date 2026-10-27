import { describe, expect, it } from "bun:test";
import { snapCropToStandardAspect } from "../../src/video/filters";

const HD = { width: 1920, height: 1080 };

describe("snapCropToStandardAspect", () => {
	it("trims a pillarboxed 4:3 picture with smeared edges to 1440x1080", () => {
		expect(snapCropToStandardAspect({ w: 1444, h: 1080, x: 238, y: 0 }, HD)).toEqual({ w: 1440, h: 1080, x: 240, y: 0 });
	});

	it("trims only the smeared side when the other edge is already clean", () => {
		expect(snapCropToStandardAspect({ w: 1442, h: 1080, x: 238, y: 0 }, HD)).toEqual({ w: 1440, h: 1080, x: 240, y: 0 });
		expect(snapCropToStandardAspect({ w: 1442, h: 1080, x: 240, y: 0 }, HD)).toEqual({ w: 1440, h: 1080, x: 240, y: 0 });
	});

	it("trims a pillarboxed 1.37:1 picture to 1480x1080", () => {
		expect(snapCropToStandardAspect({ w: 1482, h: 1080, x: 218, y: 0 }, HD)).toEqual({ w: 1480, h: 1080, x: 220, y: 0 });
	});

	it("trims pillarboxed pictures a few px over the narrow ratios", () => {
		for (const w of [1286, 1296, 1544, 1620, 1890]) {
			const x = Math.round((1920 - w) / 4) * 2;
			expect(snapCropToStandardAspect({ w: w + 4, h: 1080, x: x - 2, y: 0 }, HD)).toEqual({ w, h: 1080, x, y: 0 });
		}
	});

	it("trims letterboxed pictures a few rows over the wide ratios", () => {
		for (const h of [1010, 752, 696]) {
			const y = Math.round((1080 - h) / 4) * 2;
			expect(snapCropToStandardAspect({ w: 1920, h: h + 4, x: 0, y: y - 2 }, HD)).toEqual({ w: 1920, h, x: 0, y });
		}
	});

	it("trims a letterboxed picture a few rows over 2.39:1 toward the frame center", () => {
		expect(snapCropToStandardAspect({ w: 1920, h: 810, x: 0, y: 134 }, HD)).toEqual({ w: 1920, h: 804, x: 0, y: 138 });
	});

	it("leaves a rect that already sits on a standard ratio", () => {
		for (const rect of [
			{ w: 1440, h: 1080, x: 240, y: 0 },
			{ w: 1920, h: 804, x: 0, y: 138 },
			{ w: 1920, h: 816, x: 0, y: 132 },
			{ w: 1920, h: 1036, x: 0, y: 22 },
			{ w: 1920, h: 1040, x: 0, y: 20 },
			{ w: 1286, h: 1080, x: 318, y: 0 },
			{ w: 1296, h: 1080, x: 312, y: 0 },
			{ w: 1480, h: 1080, x: 220, y: 0 },
			{ w: 1544, h: 1080, x: 188, y: 0 },
			{ w: 1620, h: 1080, x: 150, y: 0 },
			{ w: 1792, h: 1080, x: 64, y: 0 },
			{ w: 1890, h: 1080, x: 16, y: 0 },
			{ w: 1920, h: 1010, x: 0, y: 36 },
			{ w: 1920, h: 960, x: 0, y: 60 },
			{ w: 1920, h: 872, x: 0, y: 104 },
			{ w: 1920, h: 800, x: 0, y: 140 },
			{ w: 1920, h: 752, x: 0, y: 164 },
			{ w: 1920, h: 696, x: 0, y: 192 },
		]) {
			expect(snapCropToStandardAspect(rect, HD)).toBe(rect);
		}
	});

	it("never grows a rect that is narrower than the standard ratio", () => {
		const rect = { w: 1434, h: 1080, x: 242, y: 0 };
		expect(snapCropToStandardAspect(rect, HD)).toBe(rect);
	});

	it("leaves a rect that is not close to any standard ratio", () => {
		const rect = { w: 1500, h: 1080, x: 210, y: 0 };
		expect(snapCropToStandardAspect(rect, HD)).toBe(rect);
	});

	it("judges the ratio in display space for anamorphic sources", () => {
		// 720x480 NTSC DVD, 32:27 pixels: 16:9 across the full width, letterboxed to 2.35:1.
		const rect = { w: 720, h: 368, x: 0, y: 56 };
		expect(snapCropToStandardAspect(rect, { width: 720, height: 480 }, { num: 32, den: 27 })).toEqual({ w: 720, h: 364, x: 0, y: 58 });
	});
});
