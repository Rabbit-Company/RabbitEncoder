import { describe, expect, it } from "bun:test";
import pkg from "../../package.json";
import { restyleAssDialogueFont, stampSignature, styleSrtAss } from "../../src/subtitles/ass-style";
import { ass1080, ass4k, ass4kWithSign, ass720, assNoPlayRes, buildAss, getScriptInfo, getStyle, sampleStyle, SIGN_STYLE_LINE } from "../fixtures/ass";

describe("styleSrtAss (SRT→ASS conversion path)", () => {
	it("pins PlayRes to 1920×1080 and enables scaled borders", () => {
		const out = styleSrtAss(buildAss({ playResX: 384, playResY: 288 }), sampleStyle);
		expect(getScriptInfo(out, "PlayResX")).toBe("1920");
		expect(getScriptInfo(out, "PlayResY")).toBe("1080");
		expect(getScriptInfo(out, "ScaledBorderAndShadow")).toBe("yes");
	});

	it("writes the configured style verbatim (no scaling — values are already 1080p)", () => {
		const out = styleSrtAss(buildAss({ playResX: 384, playResY: 288 }), sampleStyle);
		const s = getStyle(out, "Default");
		expect(s.fontname).toBe("Noto Sans");
		expect(s.fontsize).toBe("64");
		expect(s.outline).toBe("3.5");
		expect(s.shadow).toBe("1");
		expect(s.marginl).toBe("80");
		expect(s.marginv).toBe("60");
	});

	it("backfills missing PlayRes / ScaledBorderAndShadow keys", () => {
		const out = styleSrtAss(assNoPlayRes(), sampleStyle);
		expect(getScriptInfo(out, "PlayResX")).toBe("1920");
		expect(getScriptInfo(out, "PlayResY")).toBe("1080");
		expect(getScriptInfo(out, "ScaledBorderAndShadow")).toBe("yes");
	});

	it("inserts a parseable Default style (after Format) when ffmpeg named the style something else", () => {
		const ass = buildAss({
			playResX: 1920,
			playResY: 1080,
			styles: ["Style: Subtitle,Arial,40,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,1,0,2,40,40,40,1"],
			events: ["Dialogue: 0,0:00:01.00,0:00:03.00,Subtitle,,0,0,0,,Hi"],
		});
		const out = styleSrtAss(ass, sampleStyle);
		expect(getStyle(out, "Default").fontname).toBe("Noto Sans");
		expect(getStyle(out, "Subtitle").fontname).toBe("Arial"); // original preserved
	});
});

describe("restyleAssDialogueFont — PlayRes-aware scaling", () => {
	it("leaves 1080p values unchanged (scale = 1)", () => {
		const s = getStyle(restyleAssDialogueFont(ass1080(), sampleStyle, true), "Default");
		expect(s.fontname).toBe("Noto Sans");
		expect(Number(s.fontsize)).toBeCloseTo(64);
		expect(Number(s.outline)).toBeCloseTo(3.5);
		expect(Number(s.shadow)).toBeCloseTo(1);
		expect(Number(s.marginl)).toBeCloseTo(80);
		expect(Number(s.marginr)).toBeCloseTo(80);
		expect(Number(s.marginv)).toBeCloseTo(60);
	});

	it("doubles every px value for a 4K (PlayResY 2160) file", () => {
		const s = getStyle(restyleAssDialogueFont(ass4k(), sampleStyle, true), "Default");
		expect(s.fontname).toBe("Noto Sans");
		expect(Number(s.fontsize)).toBeCloseTo(128);
		expect(Number(s.outline)).toBeCloseTo(7);
		expect(Number(s.shadow)).toBeCloseTo(2);
		expect(Number(s.marginl)).toBeCloseTo(160);
		expect(Number(s.marginr)).toBeCloseTo(160);
		expect(Number(s.marginv)).toBeCloseTo(120);
	});

	it("scales down for a 720p file (factor 2/3)", () => {
		const s = getStyle(restyleAssDialogueFont(ass720(), sampleStyle, true), "Default");
		expect(Number(s.fontsize)).toBeCloseTo((64 * 720) / 1080, 2);
		expect(Number(s.outline)).toBeCloseTo((3.5 * 720) / 1080, 2);
		expect(Number(s.marginl)).toBeCloseTo((80 * 1280) / 1920, 2);
		expect(Number(s.marginv)).toBeCloseTo((60 * 720) / 1080, 2);
	});

	it("does not scale unitless fields (colour, alignment, bold)", () => {
		const s = getStyle(restyleAssDialogueFont(ass4k(), sampleStyle, true), "Default");
		expect(s.primarycolour).toBe("&H00FFFFFF");
		expect(s.outlinecolour).toBe("&H0000FF00");
		expect(s.alignment).toBe("2");
		expect(s.bold).toBe("0");
	});

	it("falls back to no scaling when PlayRes is absent", () => {
		const s = getStyle(restyleAssDialogueFont(assNoPlayRes(), sampleStyle, true), "Default");
		expect(Number(s.fontsize)).toBeCloseTo(64);
		expect(Number(s.marginv)).toBeCloseTo(60);
	});
});

describe("restyleAssDialogueFont — scope of changes", () => {
	it("replaces only the font when restyleAppearance is false", () => {
		const s = getStyle(restyleAssDialogueFont(ass4k(), sampleStyle, false), "Default");
		expect(s.fontname).toBe("Noto Sans"); // font always replaced
		expect(s.fontsize).toBe("40"); // appearance untouched, original kept
		expect(s.marginv).toBe("40");
		expect(s.outlinecolour).toBe("&H00FF0000");
	});

	it("never touches sign/song styles", () => {
		const out = restyleAssDialogueFont(ass4kWithSign(), sampleStyle, true);
		const sign = getStyle(out, "Signs");
		expect(sign.fontname).toBe("Comic Sans MS");
		expect(sign.fontsize).toBe("30");
		// the dialogue style in the same file is still rescaled
		expect(getStyle(out, "Default").fontname).toBe("Noto Sans");
		expect(Number(getStyle(out, "Default").fontsize)).toBeCloseTo(128);
	});

	it("returns the input unchanged when there is no dialogue style", () => {
		const noDialogue = buildAss({
			styles: ["Style: Signs,Arial,30,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,7,10,10,10,1"],
			events: [],
		});
		expect(restyleAssDialogueFont(noDialogue, sampleStyle, true)).toBe(noDialogue);
	});

	it("does not touch a sign-only track whose misleading style is named Default", () => {
		const signs = buildAss({
			playResX: 1920,
			playResY: 1080,
			events: [
				"Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\pos(100,100)}SHOP",
				"Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,{\\pos(1500,250)}STATION",
			],
		});

		expect(restyleAssDialogueFont(signs, sampleStyle, true)).toBe(signs);
	});

	it("does not rewrite an ambiguous style shared by dialogue and karaoke", () => {
		const shared = buildAss({
			events: ["Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hello", "Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,{\\k20}Song"],
		});

		expect(restyleAssDialogueFont(shared, sampleStyle, true)).toBe(shared);
	});

	it("preserves doubled PlayRes — it does NOT rewrite PlayRes (would move signs)", () => {
		const out = restyleAssDialogueFont(ass4k(), sampleStyle, true);
		expect(getScriptInfo(out, "PlayResX")).toBe("3840");
		expect(getScriptInfo(out, "PlayResY")).toBe("2160");
	});
});

describe("RabbitEncoder provenance stamp", () => {
	it("stamps the tool version into SRT→ASS output", () => {
		const out = styleSrtAss(ass1080(), sampleStyle);
		expect(getScriptInfo(out, "RabbitEncoder")).toBe(pkg.version);
	});

	it("stamps the tool version into restyled ASS output", () => {
		const out = restyleAssDialogueFont(ass4k(), sampleStyle, true);
		expect(getScriptInfo(out, "RabbitEncoder")).toBe(pkg.version);
	});

	it("does not stamp files left untouched (no dialogue style)", () => {
		const noDialogue = buildAss({ styles: [SIGN_STYLE_LINE], events: [] });
		const out = restyleAssDialogueFont(noDialogue, sampleStyle, true);
		expect(out).toBe(noDialogue);
		expect(getScriptInfo(out, "RabbitEncoder")).toBeUndefined();
	});

	it("is idempotent — re-stamping replaces rather than duplicating", () => {
		const once = stampSignature(ass1080(), "1.2.3");
		const twice = stampSignature(once, "4.5.6");
		const matches = twice.split(/\r?\n/).filter((l) => /^RabbitEncoder\s*:/i.test(l.trim()));
		expect(matches).toHaveLength(1);
		expect(getScriptInfo(twice, "RabbitEncoder")).toBe("4.5.6");
	});

	it("creates a Script Info section when one is absent", () => {
		const out = stampSignature("[V4+ Styles]\nFormat: Name\nStyle: Default,Arial\n", "9.9.9");
		expect(getScriptInfo(out, "RabbitEncoder")).toBe("9.9.9");
	});
});
