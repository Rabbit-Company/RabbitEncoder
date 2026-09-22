import { describe, expect, test } from "bun:test";
import { pairRepairFiles, parseEpisodeKey } from "../../src/pipeline/repair-pairing";

describe("parseEpisodeKey", () => {
	test("reads the common season/episode spellings", () => {
		expect(parseEpisodeKey("Show - S01E02 - Title.mkv")).toEqual({ season: 1, episode: 2 });
		expect(parseEpisodeKey("Show.s2.e11.mkv")).toEqual({ season: 2, episode: 11 });
		expect(parseEpisodeKey("Show 1x02.mkv")).toEqual({ season: 1, episode: 2 });
		expect(parseEpisodeKey("Show Episode 7.mkv")).toEqual({ season: 1, episode: 7 });
		expect(parseEpisodeKey("[Group] Show - 02v2 [1080p].mkv")).toEqual({ season: 1, episode: 2 });
	});

	test("ignores years, resolutions and hashes in bracketed tags", () => {
		expect(parseEpisodeKey("Show (2026) - S01E03 [Bluray-1080p][Opus 2.0][AV1]-Rabbit.mkv")).toEqual({ season: 1, episode: 3 });
		expect(parseEpisodeKey("Show (2026) [1080p][x265].mkv")).toBeNull();
	});

	test("returns null when there is no episode to read", () => {
		expect(parseEpisodeKey("Movie.mkv")).toBeNull();
	});
});

describe("pairRepairFiles", () => {
	const targets = ["/enc/Show - S01E01 - A [AV1].mkv", "/enc/Show - S01E02 - B [AV1].mkv", "/enc/Show - S01E10 - C [AV1].mkv"];

	test("matches on episode number regardless of naming or order", () => {
		const sources = ["/src/[Group] Show - 10 [BD].mkv", "/src/[Group] Show - 01 [BD].mkv", "/src/[Group] Show - 02 [BD].mkv"];
		const { pairs, unmatchedSources } = pairRepairFiles(targets, sources);

		expect(pairs.map((pair) => [pair.targetName, pair.sourceName, pair.method])).toEqual([
			["Show - S01E01 - A [AV1].mkv", "[Group] Show - 01 [BD].mkv", "episode"],
			["Show - S01E02 - B [AV1].mkv", "[Group] Show - 02 [BD].mkv", "episode"],
			["Show - S01E10 - C [AV1].mkv", "[Group] Show - 10 [BD].mkv", "episode"],
		]);
		expect(unmatchedSources).toEqual([]);
	});

	test("falls back to natural order when neither side numbers its episodes", () => {
		const unnumbered = ["/enc/beta.mkv", "/enc/alpha.mkv"];
		const sources = ["/src/second.mkv", "/src/first.mkv"];
		const { pairs } = pairRepairFiles(unnumbered, sources);

		expect(pairs.map((pair) => [pair.targetName, pair.sourceName, pair.method])).toEqual([
			["alpha.mkv", "first.mkv", "order"],
			["beta.mkv", "second.mkv", "order"],
		]);
	});

	test("sorts numerically, so ep10 does not land between ep1 and ep2", () => {
		const { pairs } = pairRepairFiles(["/enc/ep2.mkv", "/enc/ep10.mkv", "/enc/ep1.mkv"], ["/src/b.mkv", "/src/c.mkv", "/src/a.mkv"]);

		expect(pairs.map((pair) => pair.targetName)).toEqual(["ep1.mkv", "ep2.mkv", "ep10.mkv"]);
	});

	test("leaves a target unmatched rather than guessing when the counts differ", () => {
		const { pairs, unmatchedSources } = pairRepairFiles(["/enc/one.mkv", "/enc/two.mkv"], ["/src/only.mkv"]);

		expect(pairs.every((pair) => pair.method === "none" && pair.sourcePath === "")).toBe(true);
		expect(unmatchedSources).toEqual(["/src/only.mkv"]);
	});

	test("never guesses when an episode number is ambiguous on either side", () => {
		const duplicateSources = ["/src/Show - 01 [BD].mkv", "/src/Show S01E01 [WEB].mkv"];
		const { pairs, unmatchedSources } = pairRepairFiles(["/enc/Show - S01E01.mkv"], duplicateSources);

		expect(pairs[0]!.method).toBe("none");
		expect(unmatchedSources).toHaveLength(2);
	});

	test("reports the sources that no target claimed", () => {
		const sources = ["/src/Show - 01.mkv", "/src/Show - 02.mkv", "/src/Show - 10.mkv", "/src/Show - 11.mkv"];
		const { pairs, unmatchedSources } = pairRepairFiles(targets, sources);

		expect(pairs.every((pair) => pair.method === "episode")).toBe(true);
		expect(unmatchedSources).toEqual(["/src/Show - 11.mkv"]);
	});

	test("mixes episode matches with order matches for the remainder", () => {
		const mixed = ["/enc/Show - S01E01.mkv", "/enc/extras-a.mkv", "/enc/extras-b.mkv"];
		const sources = ["/src/Show - 01.mkv", "/src/bonus-1.mkv", "/src/bonus-2.mkv"];
		const { pairs } = pairRepairFiles(mixed, sources);

		expect(pairs.map((pair) => pair.method)).toEqual(["order", "order", "episode"]);
		expect(pairs.find((pair) => pair.targetName === "Show - S01E01.mkv")!.sourceName).toBe("Show - 01.mkv");
	});
});
