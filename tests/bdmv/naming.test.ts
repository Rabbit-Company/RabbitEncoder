import { describe, expect, test } from "bun:test";
import { DEFAULT_NAMING_FORMATS as F, discFolder, discOutputPath, renderTemplate, sonarrClean, unknownTokens } from "../../src/bdmv/naming";
import { numberRows, type NumberedRow } from "../../src/bdmv/numbering";
import { loadNamingFormats } from "../../src/core/config";
import type { TvdbSeries } from "../../src/bdmv/metadata";

const show = { title: "Gals Can't Be Kind to Otaku!?", year: 2026, imdbId: "tt39443176", tvdbId: 468761, tmdbId: 309163 };
const film = { title: "Your Name.", year: 2016, imdbId: "tt5311514", tmdbId: 372058 };

describe("sonarrClean", () => {
	test("cleans characters Sonarr replaces", () => {
		expect(sonarrClean("Gals Can't Be Kind to Otaku!?")).toBe("Gals Can't Be Kind to Otaku!!");
		expect(sonarrClean("Re:Zero: Starting Life")).toBe("Re-Zero - Starting Life");
		expect(sonarrClean('AC/DC "Live" *1*')).toBe("AC+DC Live -1-");
		expect(sonarrClean("..")).toBe("");
	});
});

describe("renderTemplate", () => {
	test("fills placeholders without regard to case and pads numbers", () => {
		expect(renderTemplate("{series title} S{season:00}E{Episode:000}", { "Series Title": "Show", season: 1, episode: 7 })).toBe("Show S01E007");
	});

	test("drops brackets and dashes around empty placeholders", () => {
		const t = "{Movie Title} ({Release Year}) [imdbid-{ImdbId}] {edition-{Edition Tags}} - {Edition Tags}";
		expect(renderTemplate(t, { "Movie Title": "Film", "Release Year": 2016, ImdbId: "tt5311514", "Edition Tags": "Director's Cut" })).toBe(
			"Film (2016) [imdbid-tt5311514] {edition-Director's Cut} - Director's Cut",
		);
		expect(renderTemplate(t, { "Movie Title": "Film" })).toBe("Film");
	});

	test("cleans what the values bring in", () => {
		expect(renderTemplate("{Movie Title}", { "Movie Title": "What/If?" })).toBe("What+If!");
	});

	test("names placeholders that do not exist", () => {
		expect(unknownTokens("{Movie Title} {Quality Full} {movie title}", ["Movie Title"])).toEqual(["Quality Full"]);
	});
});

describe("disc output paths", () => {
	test("places episodes, specials and extras as Sonarr and Jellyfin expect", () => {
		expect(discOutputPath("series", F, show, { kind: "episode", season: 1, episode: 3, title: "Do You Want to Come Over?" })).toEqual({
			relativePath: "Gals Can't Be Kind to Otaku!! (2026)/Season 01",
			filename: "Gals Can't Be Kind to Otaku!! (2026) - S01E03 - Do You Want to Come Over!.mkv",
			outputTitle: "Gals Can't Be Kind to Otaku!! (2026) - S01E03 - Do You Want to Come Over!",
		});
		expect(discOutputPath("series", F, show, { kind: "special", season: 1, episode: 2, title: "" }).filename).toBe(
			"Gals Can't Be Kind to Otaku!! (2026) - S00E02.mkv",
		);
		expect(discOutputPath("series", F, show, { kind: "special", episode: 2, title: "" }).relativePath).toBe("Gals Can't Be Kind to Otaku!! (2026)/Specials");
		expect(discOutputPath("series", F, show, { kind: "extra", title: "NCOP 1/2" })).toMatchObject({
			relativePath: "Gals Can't Be Kind to Otaku!! (2026)/extras",
			filename: "NCOP 1+2.mkv",
		});
	});

	test("names a movie and its editions as Radarr does", () => {
		expect(discOutputPath("movie", F, film, { kind: "movie", title: "" })).toEqual({
			relativePath: "Your Name. (2016)",
			filename: "Your Name. (2016).mkv",
			outputTitle: "Your Name. (2016)",
		});
		expect(discOutputPath("movie", F, film, { kind: "movie", title: "", edition: "Director's Cut" }).filename).toBe("Your Name. (2016) - Director's Cut.mkv");
		expect(discOutputPath("movie", F, film, { kind: "extra", title: "Trailer" }).relativePath).toBe("Your Name. (2016)/extras");
	});

	test("follows formats the user set", () => {
		const formats = loadNamingFormats({
			MOVIE_FOLDER_FORMAT: "{Movie Title} ({Release Year}) [imdbid-{ImdbId}]",
			MOVIE_FORMAT: "{Movie Title} ({Release Year}) [imdbid-{ImdbId}] {edition-{Edition Tags}}",
			SERIES_FOLDER_FORMAT: "{Series Title} ({Series Year}) [tvdbid-{TvdbId}]",
			SEASON_FOLDER_FORMAT: "Season {season}",
			EPISODE_FORMAT: "{Series Title} - {season:0}x{episode:00} - {Episode Title}",
		});
		expect(discOutputPath("movie", formats, film, { kind: "movie", title: "" })).toEqual({
			relativePath: "Your Name. (2016) [imdbid-tt5311514]",
			filename: "Your Name. (2016) [imdbid-tt5311514].mkv",
			outputTitle: "Your Name. (2016) [imdbid-tt5311514]",
		});
		expect(discOutputPath("movie", formats, { title: "Film" }, { kind: "movie", title: "", edition: "IMAX" }).filename).toBe("Film {edition-IMAX}.mkv");
		expect(discOutputPath("series", formats, show, { kind: "episode", season: 1, episode: 4, title: "Let's Go to Karaoke" })).toMatchObject({
			relativePath: "Gals Can't Be Kind to Otaku!! (2026) [tvdbid-468761]/Season 1",
			filename: "Gals Can't Be Kind to Otaku!! - 1x04 - Let's Go to Karaoke.mkv",
		});
	});

	test("never names a folder after nothing", () => {
		expect(discFolder("series", F, { title: ".." })).toBe("Unknown Series");
		expect(discFolder("movie", { ...F, movieFolder: "{ImdbId}" }, { title: "Film" })).toBe("Unknown Movie");
	});
});

describe("numberRows", () => {
	const series: TvdbSeries = {
		tvdbId: 1,
		title: "Show",
		year: 2026,
		runtime: 23,
		episodes: [
			{ season: 0, episode: 1, title: "OVA" },
			...Array.from({ length: 4 }, (_, i) => ({ season: 1, episode: i + 1, title: `Title ${i + 1}`, runtime: 23 })),
		],
	};
	const row = (kind: NumberedRow["kind"], disc: number, length = 1422): NumberedRow => ({ kind, disc, start: 0, end: length, title: "" });

	test("numbers episodes across discs and takes TVDB titles", () => {
		const rows = [row("episode", 0), row("extra", 0, 90), row("episode", 0), row("episode", 1), row("special", 1, 1500), row("extra", 1, 90)];
		const warnings = numberRows(rows, 1, 1, series);
		expect(rows.map((r) => [r.season, r.episode, r.title])).toEqual([
			[1, 1, "Title 1"],
			[undefined, undefined, "Disc 1 Extra 1"],
			[1, 2, "Title 2"],
			[1, 3, "Title 3"],
			[0, 1, "OVA"],
			[undefined, undefined, "Disc 2 Extra 2"],
		]);
		expect(warnings[0]).toContain("Found 3 episodes, TVDB lists 4");
	});

	test("warns about episodes TVDB does not have and lengths that do not fit", () => {
		const rows = [row("episode", 0, 600), row("episode", 0)];
		numberRows(rows, 1, 4, series);
		expect(rows[0]!.warning).toBe("10:00 long, TVDB says about 23 min");
		expect(rows[1]!.warning).toBe("S01E05 is not on TVDB");
	});

	test("leaves movies unnumbered", () => {
		const rows = [row("movie", 0, 6360), row("extra", 0, 90)];
		numberRows(rows, 1, 1);
		expect(rows.map((r) => [r.episode, r.title])).toEqual([
			[undefined, ""],
			[undefined, "Disc 1 Extra 1"],
		]);
	});
});
