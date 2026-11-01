import { describe, expect, it } from "bun:test";
import { dialogueCues, mapCueAcrossCuts, retimeDocument, type TimeMap } from "../../src/subsearch/cues";

const cue = (startMs: number, endMs: number) => ({ startMs, endMs });

describe("mapCueAcrossCuts", () => {
	// The source has 30 s at 200 s that the target cut.
	const cutMap: TimeMap = {
		scale: 1,
		pieces: [
			{ fromMs: 0, offsetMs: 0 },
			{ fromMs: 230_000, offsetMs: -30_000 },
		],
	};
	const removed = [{ startMs: 200_000, endMs: 230_000 }];

	it("drops a cue inside the removed part", () => {
		expect(mapCueAcrossCuts(cue(210_000, 215_000), cutMap, removed)).toBeNull();
	});

	it("cuts a cue reaching into the removed part", () => {
		expect(mapCueAcrossCuts(cue(199_000, 205_000), cutMap, removed)).toEqual(cue(199_000, 200_000));
		expect(mapCueAcrossCuts(cue(228_000, 232_000), cutMap, removed)).toEqual(cue(200_000, 202_000));
	});

	it("closes the gap of a cue running across the removed part", () => {
		expect(mapCueAcrossCuts(cue(199_000, 231_000), cutMap, removed)).toEqual(cue(199_000, 201_000));
	});

	it("moves cues after the cut", () => {
		expect(mapCueAcrossCuts(cue(240_000, 241_000), cutMap, removed)).toEqual(cue(210_000, 211_000));
	});

	it("closes the gap by the pieces alone when no removed parts are given", () => {
		expect(mapCueAcrossCuts(cue(199_000, 231_000), cutMap)).toEqual(cue(199_000, 201_000));
	});

	// The target has 20 s at 200 s that the source lacks.
	const insertMap: TimeMap = {
		scale: 1,
		pieces: [
			{ fromMs: 0, offsetMs: 0 },
			{ fromMs: 200_000, offsetMs: 20_000 },
		],
	};

	it("ends a cue where footage only the target has starts", () => {
		expect(mapCueAcrossCuts(cue(199_000, 201_000), insertMap)).toEqual(cue(199_000, 200_000));
		expect(mapCueAcrossCuts(cue(199_000, 200_000), insertMap)).toEqual(cue(199_000, 200_000));
	});

	it("moves a cue starting after that footage", () => {
		expect(mapCueAcrossCuts(cue(200_000, 201_000), insertMap)).toEqual(cue(220_000, 221_000));
	});

	it("scales for a frame rate change", () => {
		const scale = 25 / 23.976;
		expect(mapCueAcrossCuts(cue(10_000, 12_000), { scale, pieces: [{ fromMs: 0, offsetMs: -500 }] })).toEqual(
			cue(Math.round(10_000 * scale - 500), Math.round(12_000 * scale - 500)),
		);
	});

	it("keeps zero-length lines unless they fall in the removed part", () => {
		expect(mapCueAcrossCuts(cue(100_000, 100_000), cutMap, removed)).toEqual(cue(100_000, 100_000));
		expect(mapCueAcrossCuts(cue(240_000, 240_000), cutMap, removed)).toEqual(cue(210_000, 210_000));
		expect(mapCueAcrossCuts(cue(210_000, 210_000), cutMap, removed)).toBeNull();
	});

	it("keeps the cue's other fields", () => {
		expect(mapCueAcrossCuts({ startMs: 240_000, endMs: 241_000, text: "Hi" }, cutMap, removed)).toEqual({ startMs: 210_000, endMs: 211_000, text: "Hi" });
	});
});

const ASS_HEAD = "[Script Info]\nTitle: x\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";

describe("retimeDocument across cuts", () => {
	const map: TimeMap = {
		scale: 1,
		pieces: [
			{ fromMs: 0, offsetMs: -7000 },
			{ fromMs: 60_000, offsetMs: -17_000 },
		],
	};
	const removed = [{ startMs: 50_000, endMs: 60_000 }];

	it("drops ASS lines in the removed part and moves the rest", () => {
		const ass =
			ASS_HEAD +
			"Dialogue: 0,0:00:10.00,0:00:12.00,Default,,0,0,0,,Before\n" +
			"Dialogue: 0,0:00:55.00,0:00:57.00,Default,,0,0,0,,Cut\n" +
			"Dialogue: 0,0:00:59.00,0:01:01.00,Sign,,0,0,0,,{\\pos(100,200)}Across\n" +
			"Comment: 0,0:01:10.00,0:01:11.00,Default,,0,0,0,,After\n";
		const out = retimeDocument({ format: "ass", content: ass }, map, undefined, { acrossCuts: true, removed }).content;
		expect(out).toContain("Dialogue: 0,0:00:03.00,0:00:05.00,Default,,0,0,0,,Before");
		expect(out).not.toContain("Cut");
		expect(out).toContain("Dialogue: 0,0:00:43.00,0:00:44.00,Sign,,0,0,0,,{\\pos(100,200)}Across");
		expect(out).toContain("Comment: 0,0:00:53.00,0:00:54.00,Default,,0,0,0,,After");
		expect(out.startsWith(ASS_HEAD.trimEnd())).toBe(true);
	});

	it("drops SRT cues in the removed part and numbers the rest again", () => {
		const srt = "1\n00:00:10,000 --> 00:00:12,000\nBefore\n\n2\n00:00:55,000 --> 00:00:57,000\nCut\n\n3\n00:01:10,000 --> 00:01:11,000\nAfter\n";
		const out = retimeDocument({ format: "srt", content: srt }, map, undefined, { acrossCuts: true, removed });
		expect(dialogueCues(out)).toEqual([
			{ startMs: 3000, endMs: 5000, text: "Before" },
			{ startMs: 53_000, endMs: 54_000, text: "After" },
		]);
		expect(out.content).toContain("2\n00:00:53,000 --> 00:00:54,000\nAfter");
	});

	it("still cuts at the video's length", () => {
		const srt = "1\n00:01:10,000 --> 00:01:20,000\nLong\n";
		const out = retimeDocument({ format: "srt", content: srt }, map, 55_000, { acrossCuts: true, removed });
		expect(dialogueCues(out)).toEqual([{ startMs: 53_000, endMs: 55_000, text: "Long" }]);
	});
});
