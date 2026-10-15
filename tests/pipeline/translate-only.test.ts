import { describe, expect, it } from "bun:test";
import { findTranslateSource } from "../../src/pipeline/translate-only";
import type { SubtitleStreamInfo } from "../../src/core/types";

const streams: SubtitleStreamInfo[] = [
	{ index: 2, codec: "hdmv_pgs_subtitle", language: "eng", title: "Full" },
	{ index: 3, codec: "ass", language: "eng", title: "Signs & Songs", isForced: true },
	{ index: 4, codec: "subrip", language: "eng", title: "SDH", isHearingImpaired: true },
	{ index: 5, codec: "ass", language: "eng", title: "Full Subtitles" },
	{ index: 6, codec: "ass", language: "ger", title: "Full Subtitles" },
];

describe("findTranslateSource", () => {
	it("picks the full text track in the requested language", () => {
		expect(findTranslateSource(streams, { language: "eng", type: "full" })?.index).toBe(5);
		expect(findTranslateSource(streams, { language: "en", type: "full" })?.index).toBe(5);
		expect(findTranslateSource(streams, { language: "deu", type: "full" })?.index).toBe(6);
	});

	it("picks SDH only when asked", () => {
		expect(findTranslateSource(streams, { language: "eng", type: "sdh" })?.index).toBe(4);
	});

	it("prefers full over SDH when any kind is allowed", () => {
		expect(findTranslateSource(streams, { language: "eng", type: "any" })?.index).toBe(5);
		expect(findTranslateSource(streams.slice(0, 3), { language: "eng", type: "any" })?.index).toBe(4);
	});

	it("returns nothing when the language or kind is missing", () => {
		expect(findTranslateSource(streams, { language: "jpn", type: "full" })).toBeUndefined();
		expect(findTranslateSource(streams, { language: "eng", type: "honorifics" })).toBeUndefined();
		expect(findTranslateSource(streams, { language: "nonsense", type: "full" })).toBeUndefined();
	});
});
