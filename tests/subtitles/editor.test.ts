import { describe, expect, test } from "bun:test";
import { editSubtitleDocument, editorCues, editorFormat, effectiveEditorOffset, validateEditorEdit } from "../../src/subtitles/editor";

const srt = "1\n00:00:01,000 --> 00:00:02,000 align:start\nHello\n\n2\n00:00:04,000 --> 00:00:06,000\nTwo\nlines\n";
const ass = `[Script Info]
ScriptType: v4.00+
[V4+ Styles]
Style: Sign,Arial,40
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 2,0:00:01.00,0:00:03.00,Sign,Actor,10,20,30,,{\\pos(50,50)}Hello, world
Comment: 0,0:00:02.00,0:00:04.00,Sign,,0,0,0,,A comment
`;

describe("subtitle editor documents", () => {
	test("rewrites SRT timing lines and applies one absolute offset to original and edited cues", () => {
		const cues = editorCues(srt, "srt");
		const edit = { trackId: 2, offsetMs: 1250, cues: [{ ...cues[1]!, startMs: 4500, text: "Edited\nline" }] };
		const result = editSubtitleDocument(srt, "srt", edit);
		expect(result).toContain("00:00:02,250 --> 00:00:03,250 align:start");
		expect(editorCues(result, "srt")[1]).toMatchObject({ startMs: 5750, endMs: 7250, text: "Edited\nline" });
		expect(editSubtitleDocument(srt, "srt", edit)).toBe(result);
	});
	test("clips cues crossing zero and removes cues entirely before zero", () => {
		const cues = editorCues(editSubtitleDocument(srt, "srt", { trackId: 2, offsetMs: -1500, cues: [] }), "srt");
		expect(cues[0]).toMatchObject({ startMs: 0, endMs: 500 });
		expect(editorCues(editSubtitleDocument(srt, "srt", { trackId: 2, offsetMs: -3000, cues: [] }), "srt")).toHaveLength(1);
	});
	test("preserves ASS styles, tags, commas and actor fields while shifting dialogue and comments", () => {
		const cue = editorCues(ass, "ass")[0]!;
		const out = editSubtitleDocument(ass, "ass", { trackId: 2, offsetMs: 120, cues: [{ ...cue, text: "{\\pos(50,50)}Edited, world\nSecond line" }] });
		expect(out).toContain("Style: Sign,Arial,40");
		expect(out).toContain("Dialogue: 2,0:00:01.12,0:00:03.12,Sign,Actor,10,20,30,,{\\pos(50,50)}Edited, world\\NSecond line");
		expect(out).toContain("Comment: 0,0:00:02.12,0:00:04.12,Sign,,0,0,0,,A comment");
		expect(editSubtitleDocument(ass, "ass", { trackId: 2, offsetMs: 0, cues: [] })).toBe(ass);
	});
	test("honors reordered ASS event fields", () => {
		const source = "[Events]\nFormat: Start, End, Layer, Style, Text\nDialogue: 0:00:01.00,0:00:02.00,0,Default,Hi, there";
		expect(editSubtitleDocument(source, "ssa", { trackId: 2, offsetMs: 500, cues: [] })).toContain("Dialogue:0:00:01.50,0:00:02.50,0,Default,Hi, there");
	});
	test("offsets existing zero-length dialogue and comments without changing their duration", () => {
		const source = ass + "Dialogue: 0,0:00:05.00,0:00:05.00,Sign,,0,0,0,,{\\pos(1,1)}Dummy\nComment: 0,0:00:06.00,0:00:06.00,Sign,,0,0,0,,Comment\n";
		for (const offsetMs of [1, 300, 1000, -300]) {
			const result = editSubtitleDocument(source, "ass", { trackId: 2, offsetMs, cues: [] });
			const cue = editorCues(result, "ass")[1]!;
			expect(cue.startMs).toBe(5000 + Math.round(offsetMs / 10) * 10);
			expect(cue.endMs).toBe(cue.startMs);
			expect(cue.text).toBe("{\\pos(1,1)}Dummy");
			const commentTime = offsetMs === 1 ? "0:00:06.00" : offsetMs === 300 ? "0:00:06.30" : offsetMs === 1000 ? "0:00:07.00" : "0:00:05.70";
			expect(result).toContain(`Comment: 0,${commentTime},${commentTime},Sign,,0,0,0,,Comment`);
		}
	});
	test("allows text edits on original zero-length ASS events and rejects newly collapsed timing", () => {
		const source = ass + "Dialogue: 0,0:00:05.00,0:00:05.00,Sign,,0,0,0,,Dummy\n";
		const cue = editorCues(source, "ass")[1]!;
		expect(editSubtitleDocument(source, "ass", { trackId: 2, offsetMs: 300, cues: [{ ...cue, text: "Edited dummy" }] })).toContain(
			"0:00:05.30,0:00:05.30,Sign,,0,0,0,,Edited dummy",
		);
		expect(() => editSubtitleDocument(source, "ass", { trackId: 2, offsetMs: 300, cues: [{ ...cue, startMs: 1000, endMs: 1001 }] })).toThrow("Edited ASS cues");
		expect(() => editSubtitleDocument(ass, "ass", { trackId: 2, offsetMs: 300, cues: [{ ...editorCues(ass, "ass")[0]!, endMs: 1000 }] })).toThrow(
			"Edited ASS cues",
		);
	});
	test("preserves centisecond precision and handles cues shifted across zero", () => {
		const source = ass + "Dialogue: 0,0:00:00.00,0:00:00.00,Sign,,0,0,0,,Zero dummy\nDialogue: 0,0:00:00.00,0:00:00.01,Sign,,0,0,0,,Short cue\n";
		expect(effectiveEditorOffset(1, "ass")).toBe(0);
		expect(effectiveEditorOffset(15, "ssa")).toBe(20);
		expect(effectiveEditorOffset(1, "srt")).toBe(1);
		expect(editSubtitleDocument(source, "ass", { trackId: 2, offsetMs: 1, cues: [] })).toBe(source);
		const clipped = editSubtitleDocument(source, "ass", { trackId: 2, offsetMs: -9, cues: [] });
		expect(clipped).not.toContain("Zero dummy");
		expect(clipped).not.toContain("Short cue");
		const edited = editSubtitleDocument(ass, "ass", { trackId: 2, offsetMs: 1, cues: [{ ...editorCues(ass, "ass")[0]!, startMs: 1004, endMs: 1006 }] });
		expect(edited).toContain("0:00:01.00,0:00:01.01");
	});
	test("rejects invalid times, stale IDs, duplicate IDs, cue injection and collapsed rounded times", () => {
		const cue = editorCues(srt, "srt")[0]!;
		expect(() => validateEditorEdit({ trackId: 2, offsetMs: Infinity, cues: [] })).toThrow();
		expect(() => validateEditorEdit({ trackId: 2, offsetMs: 0, cues: [{ ...cue, endMs: 0 }] })).toThrow();
		expect(() => validateEditorEdit({ trackId: 2, offsetMs: 0, cues: [cue, cue] })).toThrow();
		expect(() => editSubtitleDocument(srt, "srt", { trackId: 2, offsetMs: 0, cues: [{ ...cue, id: 999 }] })).toThrow();
		expect(() =>
			editSubtitleDocument(srt, "srt", { trackId: 2, offsetMs: 0, cues: [{ ...cue, text: "Hi\n\n3\n00:00:04,000 --> 00:00:05,000\nInjected" }] }),
		).toThrow();
		expect(() => editSubtitleDocument(srt, "srt", { trackId: 2, offsetMs: -2000, cues: [{ ...cue, endMs: cue.startMs }] })).toThrow("Edited SRT cues");
		expect(() =>
			editSubtitleDocument(ass, "ass", { trackId: 2, offsetMs: 0, cues: [{ ...editorCues(ass, "ass")[0]!, startMs: 1000, endMs: 1001 }] }),
		).toThrow();
	});
	test("recognizes text and supported bitmap codecs", () => {
		expect(editorFormat("S_TEXT/UTF8")).toBe("srt");
		expect(editorFormat("S_HDMV/PGS")).toBe("bitmap");
		expect(editorFormat("S_VOBSUB")).toBe("bitmap");
		expect(editorFormat("S_UNKNOWN")).toBeNull();
		expect(() => editSubtitleDocument("", "bitmap", { trackId: 2, offsetMs: 0, cues: [] })).toThrow();
	});
});
