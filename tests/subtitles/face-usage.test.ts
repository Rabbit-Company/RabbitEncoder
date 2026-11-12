import { describe, expect, it } from "bun:test";
import { faceUsage } from "../../src/subtitles/face-usage";

const doc = (events: string[], styles = ["Default,Noto Sans,0,0", "Italics,Noto Sans,0,-1", "Sign,Arial,-1,0"]) =>
	[
		"[Script Info]",
		"ScriptType: v4.00+",
		"",
		"[V4+ Styles]",
		"Format: Name, Fontname, Bold, Italic",
		...styles.map((s) => `Style: ${s}`),
		"",
		"[Events]",
		"Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
		...events.map((e) => `Dialogue: 0,0:00:00.00,0:00:01.00,${e}`),
	].join("\n");

const styles = (text: string, family = "noto sans") => [...(faceUsage([text]).get(family)?.styles ?? [])].sort();

describe("faceUsage", () => {
	it("reads the style's bold and italic", () => {
		expect(styles(doc(["Default,,0,0,0,,Hello", "Italics,,0,0,0,,There"]))).toEqual(["italic", "regular"]);
		expect(styles(doc(["Sign,,0,0,0,,Bold sign"]), "arial")).toEqual(["bold"]);
	});

	it("follows \\b, \\i and \\r overrides", () => {
		expect(styles(doc(["Default,,0,0,0,,a {\\b1}b {\\i1}c{\\b0} d{\\r}e"]))).toEqual(["bold", "bold italic", "italic", "regular"]);
		expect(styles(doc(["Default,,0,0,0,,{\\i1}a{\\rItalics\\i0}b"]))).toEqual(["italic", "regular"]);
	});

	it("reads weights like libass: 1 and -1 are bold, so is 600 or more", () => {
		expect(styles(doc(["Default,,0,0,0,,{\\b700}a"]))).toEqual(["bold"]);
		expect(styles(doc(["Default,,0,0,0,,{\\b400}a"]))).toEqual(["regular"]);
	});

	it("does not mistake \\blur, \\bord or \\iclip for bold or italic", () => {
		expect(styles(doc(["Default,,0,0,0,,{\\blur3\\bord2\\iclip(0,0,1,1)\\be1}a"]))).toEqual(["regular"]);
	});

	it("moves text to the family \\fn names, and back on an empty \\fn", () => {
		const usage = faceUsage([doc(["Default,,0,0,0,,a{\\fnArial}b{\\fn}c"])]);
		expect([...usage.get("arial")!.codepoints]).toEqual([0x62]);
		expect([...usage.get("noto sans")!.codepoints].sort()).toEqual([0x61, 0x63]);
	});

	it("leaves drawings and whitespace-only runs out", () => {
		const usage = faceUsage([doc(["Default,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100{\\p0}", "Default,,0,0,0,,{\\i1}   {\\i0}x"])]);
		expect([...usage.get("noto sans")!.styles]).toEqual(["regular"]);
		expect(usage.get("noto sans")!.codepoints.has("m".codePointAt(0)!)).toBe(false);
	});

	it("keeps commas in the text and turns \\h into a no-break space", () => {
		const usage = faceUsage([doc(["Default,,0,0,0,,Well,\\hno\\Nyes"])]).get("noto sans")!;
		expect(usage.codepoints.has(",".codePointAt(0)!)).toBe(true);
		expect(usage.codepoints.has(0xa0)).toBe(true);
		expect(usage.codepoints.has("N".codePointAt(0)!)).toBe(false);
	});

	it("falls back to Default for an unknown style and ignores comments", () => {
		const text = `${doc(["Missing,,0,0,0,,a"])}\nComment: 0,0:00:00.00,0:00:01.00,Italics,,0,0,0,,hidden`;
		expect(styles(text)).toEqual(["regular"]);
	});
});
