import { describe, expect, test } from "bun:test";
import { pairOriginalSources } from "../../src/video/source-pairing";

describe("pairOriginalSources", () => {
	test("matches a season by episode number across different release names", () => {
		const pairs = pairOriginalSources(
			["/denoised/Show.S01E01.denoised.mkv", "/denoised/Show.S01E02.denoised.mkv"],
			["/originals/Other.Name.S01E02.mkv", "/originals/Other.Name.S01E01.mkv"],
		);
		expect(pairs.map((p) => p.sourcePath)).toEqual(["/originals/Other.Name.S01E01.mkv", "/originals/Other.Name.S01E02.mkv"]);
	});

	test("leaves ambiguous episode matches unpaired", () => {
		const pairs = pairOriginalSources(["/denoised/Show.S01E01.mkv"], ["/originals/A.S01E01.mkv", "/originals/B.S01E01.mkv"]);
		expect(pairs[0]?.sourcePath).toBe("");
	});

	test("pairs a single selected input and source directly", () => {
		expect(pairOriginalSources(["/denoised/episode.mkv"], ["/originals/raw.mkv"])[0]).toEqual({
			targetPath: "/denoised/episode.mkv",
			sourcePath: "/originals/raw.mkv",
			method: "single",
		});
	});

	test("never pairs a file with itself", () => {
		expect(pairOriginalSources(["/media/Show.S01E01.mkv"], ["/media/Show.S01E01.mkv"])[0]?.sourcePath).toBe("");
	});
});
