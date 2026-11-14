import { describe, expect, it } from "bun:test";
import { computeDisplayDimensions, hasDoubtfulWideFlag, resolvePictureSar, resolveSourceSar } from "../../src/video/aspect";

const WIDE = { num: 4, den: 3 };
const SQUARE = { num: 1, den: 1 };
const HD43 = { width: 1440, height: 1080 };

describe("hasDoubtfulWideFlag", () => {
	it("doubts any square 4:3 frame flagged 16:9", () => {
		expect(hasDoubtfulWideFlag(1440, 1080, WIDE, "Bluray")).toBe(true);
		expect(hasDoubtfulWideFlag(960, 720, WIDE, "WEBDL")).toBe(true);
		expect(hasDoubtfulWideFlag(1920, 1440, WIDE)).toBe(true);
	});

	it("trusts broadcast captures, square frames and SD anamorphic", () => {
		expect(hasDoubtfulWideFlag(1440, 1080, WIDE, "HDTV")).toBe(false);
		expect(hasDoubtfulWideFlag(1440, 1080, SQUARE, "Bluray")).toBe(false);
		expect(hasDoubtfulWideFlag(1920, 1080, SQUARE, "Bluray")).toBe(false);
		expect(hasDoubtfulWideFlag(720, 480, { num: 32, den: 27 }, "DVD")).toBe(false);
	});
});

describe("resolvePictureSar", () => {
	it("treats a full width picture as 4:3 with square pixels", () => {
		const { sar, overridden } = resolvePictureSar(HD43, WIDE, "Bluray", false);
		expect(overridden).toBe(true);
		expect(computeDisplayDimensions(1440, 1080, sar)).toEqual({ width: 1440, height: 1080 });
	});

	it("keeps the 16:9 flag when a 4:3 picture is pillarboxed inside the frame", () => {
		const { sar, overridden } = resolvePictureSar(HD43, WIDE, "Bluray", true);
		expect(overridden).toBe(false);
		expect(computeDisplayDimensions(1080, 1080, sar)).toEqual({ width: 1440, height: 1080 });
	});

	it("keeps the flag on broadcast captures", () => {
		expect(resolvePictureSar(HD43, WIDE, "HDTV", false)).toEqual({ sar: WIDE, overridden: false });
	});
});

describe("resolveSourceSar", () => {
	it("reads the flag from the SAR or derives it from the DAR", () => {
		expect(resolveSourceSar({ width: 1440, height: 1080, sampleAspectRatio: "4:3", displayAspectRatio: "16:9" })).toEqual(WIDE);
		expect(resolveSourceSar({ width: 1440, height: 1080, sampleAspectRatio: "", displayAspectRatio: "16:9" })).toEqual(WIDE);
		expect(resolveSourceSar({ width: 1920, height: 1080, sampleAspectRatio: "N/A", displayAspectRatio: "" })).toEqual(SQUARE);
	});
});
