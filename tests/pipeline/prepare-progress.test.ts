import { describe, expect, it } from "bun:test";
import { ffmpegProgress, mkvtoolnixProgress, preparePhaseProgress } from "../../src/pipeline/prepare-progress";

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
});
