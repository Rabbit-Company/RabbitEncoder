import { describe, expect, test } from "bun:test";
import { representativeFilmGrainWindow } from "../../src/video/film-grain-window";

describe("film grain measurement window", () => {
	test("centers a fixed 30-second window and leaves short videos intact", () => {
		expect(representativeFilmGrainWindow(600, 24000 / 1001)).toEqual({ startSeconds: 285, frames: 719 });
		expect(representativeFilmGrainWindow(45, 24)).toBeNull();
	});
});
