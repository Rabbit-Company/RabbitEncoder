import { describe, expect, it } from "bun:test";
import { classifyAssLines, dialogueStyleNames, extractUsedFonts, normalizeFontName, restylableDialogueStyleNames } from "../../src/subtitles/ass-classifier";
import { buildAss, DEFAULT_STYLE_LINE, SIGN_STYLE_LINE } from "../fixtures/ass";

const OP_STYLE_LINE = "Style: OP,Arial,40,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,1,0,8,40,40,40,1";
const UNUSED_STYLE_LINE = "Style: Unused,Wingdings,40,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,1,0,5,40,40,40,1";

// A file with a dialogue style (Default), a sign style (Signs), a song style
// (OP), and an unreferenced style (Unused), plus an inline \fn override.
const mixed = buildAss({
	styles: [DEFAULT_STYLE_LINE, SIGN_STYLE_LINE, OP_STYLE_LINE, UNUSED_STYLE_LINE],
	events: [
		"Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hello world",
		"Dialogue: 0,0:00:03.00,0:00:05.00,Default,,0,0,0,,{\\fnTimes New Roman}A quote",
		"Dialogue: 0,0:00:05.00,0:00:07.00,Signs,,0,0,0,,{\\pos(100,100)}Billboard",
		"Dialogue: 0,0:00:07.00,0:00:09.00,OP,,0,0,0,,{\\k50}la {\\k30}la",
		"Dialogue: 0,0:00:09.00,0:00:11.00,Default,,0,0,0,,{\\k20}sing along",
	],
});

describe("normalizeFontName", () => {
	it("trims, lowercases, and strips a leading @ (vertical-font marker)", () => {
		expect(normalizeFontName("  @Arial  ")).toBe("arial");
		expect(normalizeFontName("Noto Sans")).toBe("noto sans");
	});
});

describe("classifyAssLines", () => {
	it("classifies each event by its style kind", () => {
		const kinds = classifyAssLines(mixed).map((l) => l.kind);
		// Default→dialogue, Default→dialogue, Signs→sign, OP→song, and the last
		// Default line is upgraded to song by its inline \k karaoke tag.
		expect(kinds).toEqual(["dialogue", "dialogue", "sign", "song", "song"]);
	});

	it("upgrades any line carrying karaoke tags to song regardless of style", () => {
		const out = classifyAssLines(
			buildAss({
				styles: [DEFAULT_STYLE_LINE],
				events: ["Dialogue: 0,0,0,Default,,0,0,0,,{\\k40}normally dialogue"],
			}),
		);
		expect(out[0]!.kind).toBe("song");
	});

	it("lets dominant positioned-sign evidence veto a misleading Default style", () => {
		const ass = buildAss({
			playResX: 1920,
			playResY: 1080,
			styles: [DEFAULT_STYLE_LINE],
			events: [
				"Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\pos(180,150)}SHOP",
				"Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,{\\pos(1550,260)}STATION",
				"Dialogue: 0,0:00:07.00,0:00:09.00,Default,,0,0,0,,{\\pos(900,580)}NOTICE",
				"Dialogue: 0,0:00:10.00,0:00:12.00,Default,,0,0,0,,Plain sign fallback",
				"Dialogue: 0,0:00:13.00,0:00:15.00,Default,,0,0,0,,Another sign",
			],
		});

		expect(classifyAssLines(ass).map((line) => line.kind)).toEqual(["sign", "sign", "sign", "sign", "sign"]);
		expect([...dialogueStyleNames(ass)]).toEqual([]);
	});

	it("does not reclassify normal dialogue because of one positioned line", () => {
		const ass = buildAss({
			playResX: 1920,
			playResY: 1080,
			styles: [DEFAULT_STYLE_LINE],
			events: [
				"Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,One",
				"Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,Two",
				"Dialogue: 0,0:00:07.00,0:00:09.00,Default,,0,0,0,,{\\pos(960,980)}Three",
				"Dialogue: 0,0:00:10.00,0:00:12.00,Default,,0,0,0,,Four",
				"Dialogue: 0,0:00:13.00,0:00:15.00,Default,,0,0,0,,Five",
			],
		});

		expect(classifyAssLines(ass).map((line) => line.kind)).toEqual(["dialogue", "dialogue", "dialogue", "dialogue", "dialogue"]);
	});

	it("lets a song-only Default style override its misleading name", () => {
		const ass = buildAss({
			styles: [DEFAULT_STYLE_LINE],
			events: ["Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\k20}Sing", "Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,{\\kf30}along"],
		});

		expect(classifyAssLines(ass).map((line) => line.kind)).toEqual(["song", "song"]);
		expect([...dialogueStyleNames(ass)]).toEqual([]);
	});

	it("ignores empty and tag-only dummy events when finding dialogue styles", () => {
		const ass = buildAss({
			styles: [DEFAULT_STYLE_LINE, SIGN_STYLE_LINE],
			events: [
				"Dialogue: 0,0:00:01.00,0:00:03.00,Default,TestResult,0,0,0,,",
				"Dialogue: 0,0:00:04.00,0:00:06.00,Default,TestResult,0,0,0,,{\\alpha&HFF&}",
				"Dialogue: 0,0:00:07.00,0:00:09.00,Signs,,0,0,0,,{\\pos(100,100)}SHOP",
			],
		});

		expect(classifyAssLines(ass).map((line) => line.kind)).toEqual(["sign"]);
		expect([...dialogueStyleNames(ass)]).toEqual([]);
		expect([...restylableDialogueStyleNames(ass)]).toEqual([]);
	});
});

describe("dialogueStyleNames", () => {
	it("returns only dialogue-classified styles (signs/songs/unused excluded)", () => {
		expect([...dialogueStyleNames(mixed)].sort()).toEqual(["Default"]);
	});

	it("includes a differently-named style that is structurally identical to the baseline", () => {
		const ass = buildAss({
			styles: [
				DEFAULT_STYLE_LINE,
				// Same font/size/margins as Default, top-aligned — structurally dialogue.
				"Style: TopText,Arial,40,&H00FFFFFF,&H000000FF,&H00FF0000,&H80000000,0,0,0,0,100,100,0,0,1,1,0,8,40,40,40,1",
			],
			events: ["Dialogue: 0,0,0,Default,,0,0,0,,hi", "Dialogue: 0,0,0,TopText,,0,0,0,,up there"],
		});
		expect([...dialogueStyleNames(ass)].sort()).toEqual(["Default", "TopText"]);
	});

	it("does not let an almost-unused Default style displace the real release-specific dialogue baseline", () => {
		const mainStyle = "Style: GJM_Main_1080p,Gandhi Sans,75,&H00FFFFFF,&H000000FF,&H00000000,&HA0000000,-1,0,0,0,100,100,0,0,1,3.6,1.5,2,225,225,60,1";
		const ass = buildAss({
			styles: [DEFAULT_STYLE_LINE, mainStyle, SIGN_STYLE_LINE],
			events: [
				"Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Legacy fallback",
				"Dialogue: 0,0:00:04.00,0:00:06.00,GJM_Main_1080p,,0,0,0,,One",
				"Dialogue: 0,0:00:07.00,0:00:09.00,GJM_Main_1080p,,0,0,0,,Two",
				"Dialogue: 0,0:00:10.00,0:00:12.00,GJM_Main_1080p,,0,0,0,,Three",
				"Dialogue: 0,0:00:13.00,0:00:15.00,GJM_Main_1080p,,0,0,0,,Four",
				"Dialogue: 0,0:00:16.00,0:00:18.00,Signs,,0,0,0,,{\\pos(100,100)}SIGN",
			],
		});

		expect([...dialogueStyleNames(ass)].sort()).toEqual(["Default", "GJM_Main_1080p"]);
		expect(classifyAssLines(ass).map((line) => line.kind)).toEqual(["dialogue", "dialogue", "dialogue", "dialogue", "dialogue", "sign"]);
	});
});

describe("restylableDialogueStyleNames", () => {
	it("fails closed when a dialogue style is shared with a song or typeset event", () => {
		expect([...dialogueStyleNames(mixed)]).toEqual(["Default"]);
		expect([...restylableDialogueStyleNames(mixed)]).toEqual([]);
	});

	it("allows an isolated clip-based transition on an otherwise normal dialogue style", () => {
		const ass = buildAss({
			styles: [DEFAULT_STYLE_LINE],
			events: [
				"Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\clip(0,900,1920,1080)}One",
				"Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,Two",
				"Dialogue: 0,0:00:07.00,0:00:09.00,Default,,0,0,0,,Three",
				"Dialogue: 0,0:00:10.00,0:00:12.00,Default,,0,0,0,,Four",
				"Dialogue: 0,0:00:13.00,0:00:15.00,Default,,0,0,0,,Five",
				"Dialogue: 0,0:00:16.00,0:00:18.00,Default,,0,0,0,,Six",
			],
		});

		expect([...restylableDialogueStyleNames(ass)]).toEqual(["Default"]);
	});
});

describe("extractUsedFonts", () => {
	it("collects fonts from referenced styles plus inline \\fn overrides, normalized", () => {
		// arial (Default + OP), comic sans ms (Signs), times new roman (inline \fn).
		// Wingdings (Unused style, no events) is excluded.
		expect([...extractUsedFonts(mixed)].sort()).toEqual(["arial", "comic sans ms", "times new roman"]);
	});

	it("does not retain a font referenced only by an empty dummy event", () => {
		const ass = buildAss({
			styles: [DEFAULT_STYLE_LINE, SIGN_STYLE_LINE],
			events: ["Dialogue: 0,0:00:01.00,0:00:03.00,Default,TestResult,0,0,0,,", "Dialogue: 0,0:00:04.00,0:00:06.00,Signs,,0,0,0,,SHOP"],
		});
		expect([...extractUsedFonts(ass)]).toEqual(["comic sans ms"]);
	});
});
