import { describe, expect, test } from "bun:test";
import { discLabel, discSourcePath, isDiscSource, originalName, parseDiscSource } from "../../src/bdmv/disc-source";
import { discOriginTagLines, parseMkvTagsXml } from "../../src/core/mkv-tags";

describe("disc sources", () => {
	test("a range keeps its exact times through its path", () => {
		const range = { discPath: "/input/Show S01/Disc 1", playlist: "00002", start: 1422.0213333, end: 2844.5 };
		const path = discSourcePath(range);
		expect(path).toBe("/input/Show S01/Disc 1/BDMV/PLAYLIST/00002.mpls#t=1422.0213333,2844.5");
		expect(parseDiscSource(path)).toEqual(range);
		expect(isDiscSource(path)).toBe(true);
	});

	test("files and broken ranges are not disc sources", () => {
		expect(parseDiscSource("/input/Show/Show - S01E01.mkv")).toBeNull();
		expect(parseDiscSource("/d/BDMV/PLAYLIST/00002.mpls")).toBeNull();
		expect(parseDiscSource("/d/BDMV/PLAYLIST/00002.mpls#t=20,10")).toBeNull();
		expect(isDiscSource(undefined)).toBe(false);
	});

	test("a disc is named by its folder, above a wrapper folder", () => {
		expect(discLabel("/input/Set/Disc 2")).toBe("Disc 2");
		expect(discLabel("/input/Set/Disc 2/BD_VIDEO")).toBe("Disc 2");
		expect(originalName("/input/Set/Disc 2/BDMV/PLAYLIST/00003.mpls#t=0,1420.4")).toBe("Disc 2, playlist 00003, 0:00 to 23:40");
		expect(originalName("/input/Show/Episode 1.mkv")).toBe("Episode 1.mkv");
	});
});

describe("BDMV tags", () => {
	const xml = (lines: string[]) =>
		[
			'<?xml version="1.0" encoding="UTF-8"?>',
			"<Tags><Tag>",
			"<Targets><TargetTypeValue>50</TargetTypeValue></Targets>",
			"<Simple><Name>ENCODED_BY</Name><String>Rabbit</String></Simple>",
			"<Simple>",
			"<Name>RABBIT_ENCODER</Name>",
			"<Simple><Name>VERSION</Name><String>v1.0.0</String></Simple>",
			"</Simple>",
			"<Simple><Name>SOURCE</Name><String>BDMV</String></Simple>",
			...lines,
			"</Tag></Tags>",
		].join("\n");

	test("the disc range an encode came from reads back", () => {
		const origin = { label: "Disc 1 <A&B>", playlist: "00002", start: 1422.0213333, end: 2844.5, length: 8532.1 };
		const tags = parseMkvTagsXml(xml(discOriginTagLines(origin)));
		expect(tags.disc).toEqual(origin);
		expect(tags.source).toBe("BDMV");
		expect(tags.rabbitVersion).toBe("v1.0.0");
	});

	test("an encode without the tag has no disc range", () => {
		expect(parseMkvTagsXml(xml([])).disc).toBeNull();
	});

	test("a tag with a broken range is ignored", () => {
		const lines = discOriginTagLines({ label: "Disc 1", playlist: "00002", start: 100, end: 50, length: 200 });
		expect(parseMkvTagsXml(xml(lines)).disc).toBeNull();
	});
});
