import { describe, expect, test } from "bun:test";
import { filmGrainAlignmentScores, representativeFilmGrainWindow } from "../../src/video/film-grain-window";

describe("film grain measurement window", () => {
	test("centers a fixed 30-second window and leaves short videos intact", () => {
		expect(representativeFilmGrainWindow(600, 24000 / 1001)).toEqual({ startSeconds: 285, frames: 719 });
		expect(representativeFilmGrainWindow(45, 24)).toBeNull();
	});

	test("finds a one-frame offset despite small pixel differences", () => {
		const original = Uint8Array.from({ length: 40 }, (_, i) => Math.floor(i / 4) * 20 + (i % 4));
		const aligned = Uint8Array.from(original, (pixel) => pixel + 1);
		const shifted = Uint8Array.from({ length: 40 }, (_, i) => original[Math.min(39, i + 4)]! + 1);
		const good = filmGrainAlignmentScores(original, aligned, 4);
		const bad = filmGrainAlignmentScores(original, shifted, 4);
		expect(good.aligned).toBeLessThan(good.shiftedEarlier);
		expect(good.aligned).toBeLessThan(good.shiftedLater);
		expect(bad.shiftedEarlier).toBeLessThan(bad.aligned);
	});
});
