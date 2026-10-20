import { describe, expect, it } from "bun:test";
import { findTranslateSource, planTrackOrder, type ExistingTrack } from "../../src/pipeline/translate-only";
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

describe("planTrackOrder", () => {
	const file: ExistingTrack[] = [
		{ id: 0, type: "video" },
		{ id: 1, type: "audio", language: "jpn" },
		{ id: 2, type: "subtitles", language: "eng" },
		{ id: 3, type: "subtitles", language: "eng" },
		{ id: 4, type: "subtitles", language: "ger" },
		{ id: 5, type: "subtitles", language: "spa" },
	];

	it("puts a new language among the other languages under * by language code", () => {
		expect(planTrackOrder(file, ["dan"], ["eng", "jpn", "*"])).toBe("0:0,0:1,0:2,0:3,1:0,0:4,0:5");
		expect(planTrackOrder(file, ["slv"], ["eng", "jpn", "*"])).toBe("0:0,0:1,0:2,0:3,0:4,0:5,1:0");
	});

	it("puts a prioritized language after the existing tracks of higher priority", () => {
		expect(planTrackOrder(file, ["slv"], ["eng", "slv", "*"])).toBe("0:0,0:1,0:2,0:3,1:0,0:4,0:5");
		expect(planTrackOrder(file, ["sl"], ["slv", "eng", "*"])).toBe("0:0,0:1,1:0,0:2,0:3,0:4,0:5");
	});

	it("orders several new tracks and never moves existing ones", () => {
		expect(planTrackOrder(file, ["dan", "fre"], ["eng", "*"])).toBe("0:0,0:1,0:2,0:3,1:0,0:4,0:5,2:0");
	});

	it("appends when the file has no subtitles", () => {
		expect(planTrackOrder(file.slice(0, 2), ["slv"], ["eng", "*"])).toBe("0:0,0:1,1:0");
	});
});
