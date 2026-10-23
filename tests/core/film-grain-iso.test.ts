import { describe, expect, test } from "bun:test";
import { grainIso, isoResolution, syntheticGrainActive, syntheticGrainMode } from "../../src/core/film-grain-iso";
import { syntheticGrainArgs } from "../../src/video/film-grain-generator";

describe("ISO grain", () => {
	test("keeps ISOs regrain accepts and turns lower ones off", () => {
		expect(grainIso(400.4)).toBe(400);
		expect(grainIso(49)).toBe(0);
		expect(grainIso(0)).toBe(0);
		expect(grainIso(NaN)).toBe(0);
		expect(grainIso(10_000_000)).toBe(409600);
	});

	test("keeps the strength of settings saved before ISO grain", () => {
		expect(syntheticGrainMode({ filmGrainSyntheticStrength: 2 })).toBe("strength");
		expect(syntheticGrainMode({})).toBe("iso");
		expect(syntheticGrainActive({ filmGrainSyntheticStrength: 2 })).toBe(true);
		expect(syntheticGrainActive({ filmGrainSyntheticMode: "iso", filmGrainSyntheticStrength: 2, filmGrainSyntheticIso: 0 })).toBe(false);
		expect(syntheticGrainActive({ filmGrainSyntheticMode: "iso", filmGrainSyntheticIso: 400 })).toBe(true);
	});

	test("is for the 16:9 frame black bars were cut from", () => {
		expect(isoResolution(1920, 1080)).toEqual({ width: 1920, height: 1080 });
		expect(isoResolution(1920, 800)).toEqual({ width: 1920, height: 1080 });
		expect(isoResolution(1440, 1080)).toEqual({ width: 1920, height: 1080 });
		expect(isoResolution(3840, 1608)).toEqual({ width: 3840, height: 2160 });
	});

	test("becomes regrain generate arguments", () => {
		expect(syntheticGrainArgs("g.tbl", { iso: 400, resolution: { width: 1920, height: 1080 }, size: "fine", chroma: 0 })).toEqual([
			"regrain",
			"--progress",
			"json",
			"generate",
			"-o",
			"g.tbl",
			"-y",
			"--iso",
			"400",
			"--resolution",
			"1920x1080",
			"--size",
			"fine",
			"--chroma",
			"0",
		]);
		expect(syntheticGrainArgs("g.tbl", { strength: 0.5, size: "medium", chroma: 1 })).toContain("--strength");
	});
});
