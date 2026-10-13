import { describe, expect, test } from "bun:test";
import { formatFilmGrainProgress, parseFilmGrainProgress } from "../../src/video/film-grain-progress";

describe("grav1synth progress", () => {
	test("reads the latest colored frame count, speed, and ETA", () => {
		const output =
			"\x1b[2K\x1b[1m 12%\x1b[0m  12/100 (\x1b[1m3.50 fps\x1b[0m, eta 25s)\r" + "\x1b[2K\x1b[1m 24%\x1b[0m  24/100 (\x1b[1m4.00 fps\x1b[0m, eta 19s)";
		expect(parseFilmGrainProgress(output)).toEqual({ frames: 24, totalFrames: 100, percent: 24, speed: "4.00 fps", eta: "19s" });
	});

	test("reports processed frames when the source has no known total", () => {
		expect(parseFilmGrainProgress("[bar]  42 frames (1.25 s/fr)")).toEqual({ frames: 42, speed: "1.25 s/fr" });
	});

	test("ignores final log messages that mention frames", () => {
		expect(parseFilmGrainProgress("INFO grav1synth > Computed diff for 120 frames")).toBeNull();
	});

	test("formats a step detail with and without a known total", () => {
		expect(formatFilmGrainProgress({ frames: 1200, totalFrames: 34000, percent: 4, speed: "41.20 fps", eta: "13m" })).toBe(
			`${(1200).toLocaleString()} / ${(34000).toLocaleString()} frames (41.20 fps, ETA 13m)`,
		);
		expect(formatFilmGrainProgress({ frames: 42 })).toBe("42 frames");
	});
});
