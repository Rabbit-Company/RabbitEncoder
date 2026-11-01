import { describe, expect, test } from "bun:test";
import { pairRepairFiles, parseEpisodeKey, parseEpisodeName } from "../../src/pipeline/repair-pairing";

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

	test("pairs a season with a release numbered across seasons by the offset its episodes agree on", () => {
		const season2 = ["/enc/Show - S02E01.mkv", "/enc/Show - S02E02.mkv", "/enc/Show - S02E04.mkv"];
		const sources = ["/src/[Erai-raws] Show - 13 [1080p].mkv", "/src/[Erai-raws] Show - 14 [1080p].mkv", "/src/[Erai-raws] Show - 16 [1080p].mkv"];
		const { pairs, unmatchedSources } = pairRepairFiles(season2, sources);

		expect(pairs.map((pair) => [pair.targetName, pair.sourceName, pair.method, pair.offset])).toEqual([
			["Show - S02E01.mkv", "[Erai-raws] Show - 13 [1080p].mkv", "absolute", 12],
			["Show - S02E02.mkv", "[Erai-raws] Show - 14 [1080p].mkv", "absolute", 12],
			["Show - S02E04.mkv", "[Erai-raws] Show - 16 [1080p].mkv", "absolute", 12],
		]);
		expect(unmatchedSources).toEqual([]);
	});

	test("keeps exact matches for season one and offsets the next season", () => {
		const both = ["/enc/Show - S01E01.mkv", "/enc/Show - S01E02.mkv", "/enc/Show - S02E01.mkv", "/enc/Show - S02E02.mkv"];
		const sources = ["/src/Show - 01.mkv", "/src/Show - 02.mkv", "/src/Show - 13.mkv", "/src/Show - 14.mkv"];
		const { pairs } = pairRepairFiles(both, sources);

		expect(pairs.map((pair) => [pair.targetName, pair.sourceName, pair.method])).toEqual([
			["Show - S01E01.mkv", "Show - 01.mkv", "episode"],
			["Show - S01E02.mkv", "Show - 02.mkv", "episode"],
			["Show - S02E01.mkv", "Show - 13.mkv", "absolute"],
			["Show - S02E02.mkv", "Show - 14.mkv", "absolute"],
		]);
	});

	test("does not guess an offset when several fit, as with a folder of the whole series", () => {
		const season2 = ["/enc/Show - S02E01.mkv", "/enc/Show - S02E02.mkv"];
		const series = Array.from({ length: 24 }, (_, i) => `/src/Show - ${String(i + 1).padStart(2, "0")}.mkv`);
		const { pairs } = pairRepairFiles(season2, series);

		expect(pairs.every((pair) => pair.method === "none")).toBe(true);
	});

	test("uses an offset given by hand", () => {
		const season2 = ["/enc/Show - S02E01.mkv", "/enc/Show - S02E02.mkv"];
		const series = Array.from({ length: 24 }, (_, i) => `/src/Show - ${String(i + 1).padStart(2, "0")}.mkv`);
		const { pairs } = pairRepairFiles(season2, series, { absoluteOffset: 12 });

		expect(pairs.map((pair) => [pair.sourceName, pair.method, pair.offset])).toEqual([
			["Show - 13.mkv", "absolute", 12],
			["Show - 14.mkv", "absolute", 12],
		]);
	});

	test("reads whether a name gives its season", () => {
		expect(parseEpisodeName("Show - S02E01.mkv")).toEqual({ season: 2, episode: 1 });
		expect(parseEpisodeName("[Group] Show - 13v2 [1080p].mkv")).toEqual({ episode: 13 });
		expect(parseEpisodeName("Show Episode 7.mkv")).toEqual({ episode: 7 });
	});
});
