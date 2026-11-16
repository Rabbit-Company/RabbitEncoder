import { describe, expect, it } from "bun:test";
import { ffmpegProgress, mkvtoolnixProgress, passEtaTimer, preparePhaseProgress } from "../../src/pipeline/prepare-progress";

describe("Prepare progress", () => {
	it("reads timestamp extraction progress", () => {
		expect(mkvtoolnixProgress("#GUI#progress 59%\r")).toBe(59);
		expect(mkvtoolnixProgress("Warning: something happened")).toBeNull();
	});

	it("maps FFmpeg output time to a bounded fraction", () => {
		expect(ffmpegProgress("out_time_us=2500000", 10)).toBe(0.25);
		expect(ffmpegProgress("out_time_ms=2500000", 10)).toBe(0.25);
		expect(ffmpegProgress("out_time_us=12000000", 10)).toBe(1);
		expect(ffmpegProgress("out_time_us=-1000", 10)).toBe(0);
		expect(ffmpegProgress("frame=42", 10)).toBeNull();
		expect(ffmpegProgress("out_time_us=2500000", 0)).toBeNull();
	});

	it("keeps each phase within its part of the bar", () => {
		expect(preparePhaseProgress(10, 30, 0.5)).toBe(20);
		expect(preparePhaseProgress(10, 30, 2)).toBe(30);
	});

	it("times each pass from its own start", () => {
		let now = 0;
		const timer = passEtaTimer(() => now);
		expect(timer(0, 0, 1)).toEqual({});
		now = 60_000;
		// A tenth of the pass in a minute leaves nine minutes of it and ten of the next.
		expect(timer(0, 0.1, 1)).toEqual({ etaMs: 19 * 60_000, etaAt: 60_000 });
		now = 70_000;
		expect(timer(1, 0.5, 0)).toEqual({});
		now = 80_000;
		expect(timer(1, 0.5, 0)).toEqual({ etaMs: 10_000, etaAt: 80_000 });
	});
});
