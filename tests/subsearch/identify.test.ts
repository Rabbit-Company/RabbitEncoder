import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { applyIdentityOverride, identifyMedia, movieHash, parseMediaName, parseNfo } from "../../src/subsearch/identify";
import { openSubtitlesLanguage, searchParams } from "../../src/subsearch/opensubtitles";
import { POPULAR_SUBTITLE_LANGUAGES } from "../../src/subsearch/languages";
import { computeDownloadedFlagArgs } from "../../src/translate/translate-step";

describe("parseMediaName", () => {
	it("reads scene movie names", () => {
		const id = parseMediaName("/m/The.Matrix.1999.1080p.BluRay.x264-GROUP.mkv");
		expect(id).toMatchObject({ kind: "movie", title: "The Matrix", year: 1999 });
	});

	it("keeps a title that starts with a year", () => {
		expect(parseMediaName("/m/2001 A Space Odyssey (1968) [imdbid-tt0062622].mkv")).toMatchObject({
			title: "2001 A Space Odyssey",
			year: 1968,
			imdbId: "tt0062622",
		});
		expect(parseMediaName("/m/1917 (2019).mkv")).toMatchObject({ title: "1917", year: 2019 });
	});

	it("reads episodes", () => {
		expect(parseMediaName("/tv/Show/Breaking.Bad.S02E05.720p.WEB-DL.mkv")).toMatchObject({ kind: "episode", title: "Breaking Bad", season: 2, episode: 5 });
		expect(parseMediaName("/tv/Show/Show Name (2019) - 3x07 - Title.mkv")).toMatchObject({
			kind: "episode",
			title: "Show Name",
			year: 2019,
			season: 3,
			episode: 7,
		});
	});

	it("reads anime absolute numbers", () => {
		expect(parseMediaName("/a/[SubsPlease] Sousou no Frieren - 12 (1080p) [ABCD1234].mkv")).toMatchObject({
			kind: "episode",
			title: "Sousou no Frieren",
			episode: 12,
		});
	});

	it("takes the series folder when the file has only numbers", () => {
		expect(parseMediaName("/tv/The Expanse (2015)/Season 02/S02E03.mkv")).toMatchObject({ kind: "episode", title: "The Expanse", season: 2, episode: 3 });
	});
});

describe("nfo files", () => {
	const dir = mkdtempSync(join(tmpdir(), "rabbit-nfo-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("parses Jellyfin and Kodi IDs", () => {
		const xml = `<movie><title>Dune &amp; Co</title><year>2021</year><uniqueid type="imdb" default="true">tt1160419</uniqueid><uniqueid type="tmdb">438631</uniqueid></movie>`;
		expect(parseNfo(xml)).toEqual({ title: "Dune & Co", year: 2021, imdbId: "tt1160419", tmdbId: 438631 });
	});

	it("uses the episode and series .nfo files", () => {
		const show = join(dir, "Show");
		const season = join(show, "Season 01");
		mkdirSync(season, { recursive: true });
		writeFileSync(join(show, "tvshow.nfo"), `<tvshow><title>Frieren: Beyond Journey's End</title><uniqueid type="imdb">tt22248376</uniqueid></tvshow>`);
		writeFileSync(join(season, "[Group] Frieren - 30 (1080p).nfo"), `<episodedetails><season>2</season><episode>2</episode></episodedetails>`);
		const id = identifyMedia(join(season, "[Group] Frieren - 30 (1080p).mkv"));
		expect(id).toMatchObject({ kind: "episode", title: "Frieren: Beyond Journey's End", season: 2, episode: 2, parentImdbId: "tt22248376" });
		expect(searchParams(id, ["sl", "en"], null)).toEqual({
			languages: "en,sl",
			parent_imdb_id: "22248376",
			season_number: "2",
			episode_number: "2",
			type: "episode",
		});
	});

	it("hashes like OpenSubtitles", () => {
		const path = join(dir, "video.bin");
		const bytes = new Uint8Array(200_000);
		for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff;
		writeFileSync(path, bytes);
		const view = new DataView(bytes.buffer);
		let expected = BigInt(bytes.length);
		for (const start of [0, bytes.length - 65_536]) for (let i = 0; i < 65_536; i += 8) expected += view.getBigUint64(start + i, true);
		expect(movieHash(path)).toBe((expected & ((1n << 64n) - 1n)).toString(16).padStart(16, "0"));
	});
});

describe("openSubtitlesLanguage", () => {
	it("maps language tags to OpenSubtitles codes", () => {
		expect(openSubtitlesLanguage("slv")).toBe("sl");
		expect(openSubtitlesLanguage("eng")).toBe("en");
		expect(openSubtitlesLanguage("pt-BR")).toBe("pt-br");
		expect(openSubtitlesLanguage("por")).toBe("pt-pt");
		expect(openSubtitlesLanguage("zh-Hant")).toBe("zh-tw");
		expect(openSubtitlesLanguage("chi")).toBe("zh-cn");
		expect(openSubtitlesLanguage("fil")).toBe("tl");
		expect(openSubtitlesLanguage("tgl")).toBe("tl");
		expect(openSubtitlesLanguage("hin")).toBe("hi");
		expect(openSubtitlesLanguage("xyz")).toBeNull();
	});

	it("searches movies by title and year without IDs", () => {
		expect(searchParams({ kind: "movie", title: "The Matrix", year: 1999, sources: [] }, ["sl"], "8e245d9679d31e12")).toEqual({
			languages: "sl",
			moviehash: "8e245d9679d31e12",
			query: "The Matrix",
			year: "1999",
			type: "movie",
		});
	});
});

describe("most used languages", () => {
	it("each maps to its own OpenSubtitles language", () => {
		const codes = POPULAR_SUBTITLE_LANGUAGES.map((tag) => openSubtitlesLanguage(tag));
		expect(codes.every(Boolean)).toBe(true);
		expect(new Set(codes).size).toBe(POPULAR_SUBTITLE_LANGUAGES.length);
		expect(POPULAR_SUBTITLE_LANGUAGES).toHaveLength(30);
	});

	it("sets the default flag as decided", () => {
		expect(computeDownloadedFlagArgs(false, true).slice(0, 2)).toEqual(["--default-track-flag", "0:1"]);
		expect(computeDownloadedFlagArgs(true, false).slice(0, 4)).toEqual(["--default-track-flag", "0:0", "--forced-display-flag", "0:0"]);
	});
});

describe("applyIdentityOverride", () => {
	const special = {
		kind: "episode" as const,
		title: "Demon Slayer - Kimetsu no Yaiba",
		year: 2019,
		season: 0,
		episode: 2,
		parentImdbId: "tt9335498",
		parentTmdbId: 85937,
		sources: ["file name", "tvshow.nfo"],
	};

	it("searches an episode as a movie and drops its series details", () => {
		const id = applyIdentityOverride(special, { kind: "movie", title: "Mugen Train", year: 2020, imdbId: "tt11032374" });
		expect(id).toMatchObject({ kind: "movie", title: "Mugen Train", year: 2020, imdbId: "tt11032374" });
		expect(id.season).toBeUndefined();
		expect(id.episode).toBeUndefined();
		expect(id.parentImdbId).toBeUndefined();
		expect(id.parentTmdbId).toBeUndefined();
		expect(searchParams(id, ["sl"], null)).toEqual({ languages: "sl", imdb_id: "11032374", type: "movie" });
	});

	it("keeps the detected details when the kind stays the same", () => {
		const id = applyIdentityOverride(special, { episode: 3, kind: "episode" });
		expect(id).toMatchObject({ kind: "episode", season: 0, episode: 3, parentImdbId: "tt9335498" });
	});
});
