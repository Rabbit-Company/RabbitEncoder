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
