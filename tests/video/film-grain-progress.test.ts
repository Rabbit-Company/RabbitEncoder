import { describe, expect, test } from "bun:test";
import { formatFilmGrainProgress, parseRegrainEvent, progressFromEvent } from "../../src/video/film-grain-progress";

describe("regrain progress", () => {
	test("reads progress events", () => {
		const event = parseRegrainEvent('{"event":"progress","frames":312,"total":720,"percent":43.333,"fps":71.5,"elapsed_seconds":4.364,"eta_seconds":786}');
		expect(event?.event).toBe("progress");
		if (event?.event !== "progress") return;
		expect(progressFromEvent(event)).toEqual({ frames: 312, totalFrames: 720, percent: 43, speed: "71.5 fps", eta: "13m 6s" });
	});

	test("handles an unknown total", () => {
		const event = parseRegrainEvent('{"event":"progress","frames":42,"total":null,"percent":null,"fps":3.25,"elapsed_seconds":1.0,"eta_seconds":null}');
		if (event?.event !== "progress") throw new Error("not a progress event");
		expect(progressFromEvent(event)).toEqual({ frames: 42, speed: "3.3 fps" });
	});

	test("reads errors and ignores other output", () => {
		expect(parseRegrainEvent('{"event":"error","code":"misaligned","message":"off by a frame"}')).toEqual({
			event: "error",
			code: "misaligned",
			message: "off by a frame",
		});
		expect(parseRegrainEvent("[matroska @ 0x1] something")).toBeNull();
		expect(parseRegrainEvent("{broken")).toBeNull();
	});

	test("formats a step detail", () => {
		expect(formatFilmGrainProgress({ frames: 1200, totalFrames: 34000, percent: 4, speed: "41.2 fps", eta: "13m 5s" })).toBe(
			"1,200 / 34,000 frames (41.2 fps, ETA 13m 5s)",
		);
		expect(formatFilmGrainProgress({ frames: 42 })).toBe("42 frames");
	});
});
