import { describe, expect, test } from "bun:test";
import { formatFilmGrainProgress, parseRegrainEvent, progressFromEvent } from "../../src/video/film-grain-progress";

describe("regrain progress", () => {
	test("reads progress events", () => {
		const event = parseRegrainEvent('{"event":"progress","frames":312,"total":720,"percent":43.333,"fps":71.5,"elapsed_seconds":4.364,"eta_seconds":786}');
		expect(event?.event).toBe("progress");
		if (event?.event !== "progress" || event.frames === undefined) return;
		expect(progressFromEvent(event)).toEqual({ frames: 312, totalFrames: 720, percent: 43, speed: "71.5 fps", eta: "13m 6s" });
	});

	test("takes the percent of the whole command from a stage of apply or remove", () => {
		const event = parseRegrainEvent(
			'{"event":"progress","stage":"verify","frames":10721,"total":172628,"percent":24.976,"fps":16000.0,"elapsed_seconds":1.0,"eta_seconds":10}',
		);
		if (event?.event !== "progress" || event.frames === undefined) throw new Error("not a progress event");
		const progress = progressFromEvent(event);
		expect(progress).toEqual({ stage: "Verifying with dav1d", frames: 10721, totalFrames: 172628, percent: 25, speed: "16000.0 fps", eta: "10s" });
		expect(formatFilmGrainProgress(progress)).toBe("Verifying with dav1d: 10,721 / 172,628 frames (16000.0 fps, ETA 10s)");
		const reading = parseRegrainEvent(
			'{"event":"progress","stage":"read","frames":5,"total":null,"percent":null,"fps":0.0,"elapsed_seconds":0.0,"eta_seconds":null}',
		);
		if (reading?.event !== "progress" || reading.frames === undefined) throw new Error("not a progress event");
		expect(progressFromEvent(reading)).toEqual({ stage: "Reading", frames: 5 });
	});

	test("handles an unknown total", () => {
		const event = parseRegrainEvent('{"event":"progress","frames":42,"total":null,"percent":null,"fps":3.25,"elapsed_seconds":1.0,"eta_seconds":null}');
		if (event?.event !== "progress" || event.frames === undefined) throw new Error("not a progress event");
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
