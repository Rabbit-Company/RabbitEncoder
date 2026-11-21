import { describe, expect, test } from "bun:test";
import { trimDocument } from "../../src/subsearch/cues";

describe("ending subtitles with the video", () => {
	test("removes ASS lines after the end, cuts lines running past it and leaves the rest untouched", () => {
		const ass = [
			"[Events]",
			"Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
			"Dialogue: 0,0:23:00.00,0:23:05.50,Default,,0,0,0,,Kept",
			"Dialogue: 0,0:23:58.00,0:24:03.00,Default,,0,0,0,,Cut",
			"Dialogue: 0,0:24:10.00,0:24:12.00,Default,,0,0,0,,Removed",
			"Comment: 0,0:24:30.00,0:24:31.00,Default,,0,0,0,,Removed too",
		].join("\r\n");
		const { doc, removed, cut } = trimDocument({ format: "ass", content: ass }, 24 * 60_000 + 1_237);
		expect([removed, cut]).toEqual([2, 1]);
		expect(doc.content.split("\r\n")).toEqual([
			"[Events]",
			"Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
			"Dialogue: 0,0:23:00.00,0:23:05.50,Default,,0,0,0,,Kept",
			"Dialogue: 0,0:23:58.00,0:24:01.23,Default,,0,0,0,,Cut",
		]);
	});

	test("cuts SRT cues and leaves a track inside the video as it is", () => {
		const srt = "1\n00:00:01,000 --> 00:00:02,000\nKept\n\n2\n00:00:09,000 --> 00:00:12,000\nCut\n\n3\n00:00:11,000 --> 00:00:13,000\nRemoved\n";
		const { doc, removed, cut } = trimDocument({ format: "srt", content: srt }, 10_000);
		expect([removed, cut]).toEqual([1, 1]);
		expect(doc.content).toBe("1\n00:00:01,000 --> 00:00:02,000\nKept\n\n2\n00:00:09,000 --> 00:00:10,000\nCut\n");
		const inside = trimDocument({ format: "srt", content: srt }, 20_000);
		expect(inside.doc.content).toBe(srt);
	});
});
