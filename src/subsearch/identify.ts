import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "fs";
import { basename, dirname, extname, join } from "path";

export interface MediaIdentity {
	kind: "movie" | "episode";
	title: string;
	year?: number;
	season?: number;
	episode?: number;
	/** IMDb ID of the movie or the episode, "tt" followed by digits. */
	imdbId?: string;
	tmdbId?: number;
	/** IMDb and TMDB IDs of the series an episode belongs to. */
	parentImdbId?: string;
	parentTmdbId?: number;
	/** Where the IDs and numbers came from, for the log and the Tools window. */
	sources: string[];
}

const SEASON_EPISODE_RE = /(?:^|[^a-z0-9])s(\d{1,2})[ ._-]?e(\d{1,4})(?![0-9])/i;
const CROSS_RE = /(?:^|[^a-z0-9])(\d{1,2})x(\d{2,3})(?![0-9])/i;
/** Anime releases, `[Group] Title - 12 (1080p)` or `Title - 12v2`. */
const ABSOLUTE_RE = /^(?:\[[^\]]*\]\s*)?(.+?)\s+-\s+(\d{1,4})(?:v\d)?(?=$|[\s\[(._])/;
const YEAR_RE = /(?:^|[\s.(\[_-])((?:19|20)\d{2})(?=$|[\s.)\]_-])/;
const IMDB_RE = /\b(tt\d{7,9})\b/;
const TMDB_RE = /\[tmdb(?:id)?[-=](\d+)\]|\{tmdb[-=](\d+)\}/i;
/** Words after which a scene name holds only release details. */
const RELEASE_WORD_RE =
	/(?:^|[\s.])(?:2160p|1080p|1080i|720p|576p|480p|4k|uhd|bluray|blu-ray|bdrip|brrip|web-?dl|webrip|web|hdtv|dvdrip|remux|x264|x265|h\.?264|h\.?265|hevc|proper|repack|extended|unrated|imax|hdr|dv)(?=$|[\s.])/i;

function cleanTitle(raw: string): string {
	return raw
		.replace(/\[[^\]]*\]|\{[^}]*\}/g, " ")
		.replace(/[._()]+/g, " ")
		.replace(/\s+-\s*$/, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Season folders say nothing about the title, so the series folder above them is used. */
function seriesFolderTitle(videoPath: string): string {
	let dir = dirname(videoPath);
	if (/^(season|staffel|saison|temporada|series)\s*\d+$|^s\d{1,2}$|^specials?$/i.test(basename(dir))) dir = dirname(dir);
	return cleanTitle(basename(dir).replace(YEAR_RE, " "));
}

/** Identity from the file name alone, with the folder as a fallback title. */
export function parseMediaName(videoPath: string): MediaIdentity {
	const stem = basename(videoPath, extname(videoPath));
	const sources = ["file name"];
	const identity: MediaIdentity = { kind: "movie", title: "", sources };
	const imdb = stem.match(IMDB_RE);
	if (imdb) identity.imdbId = imdb[1];
	const tmdb = stem.match(TMDB_RE);
	if (tmdb) identity.tmdbId = parseInt(tmdb[1] ?? tmdb[2]!, 10);

	const se = stem.match(SEASON_EPISODE_RE) ?? stem.match(CROSS_RE);
	if (se) {
		identity.kind = "episode";
		identity.season = parseInt(se[1]!, 10);
		identity.episode = parseInt(se[2]!, 10);
		identity.title = cleanTitle(stem.slice(0, se.index).replace(YEAR_RE, " "));
		const year = stem.slice(0, se.index).match(YEAR_RE);
		if (year) identity.year = parseInt(year[1]!, 10);
		if (!identity.title) {
			identity.title = seriesFolderTitle(videoPath);
			sources.push("folder name");
		}
		return identity;
	}

	const absolute = stem.match(ABSOLUTE_RE);
	if (absolute && !YEAR_RE.test(` ${absolute[2]} `)) {
		identity.kind = "episode";
		identity.episode = parseInt(absolute[2]!, 10);
		identity.title = cleanTitle(absolute[1]!);
		return identity;
	}

	// The last year counts, so "2001 A Space Odyssey 1968" keeps its title.
	const year = [...stem.matchAll(new RegExp(YEAR_RE.source, "g"))].filter((m) => m.index! > 0).pop();
	let titlePart = stem;
	if (year) {
		identity.year = parseInt(year[1]!, 10);
		titlePart = stem.slice(0, year.index! + 1);
	} else {
		const release = stem.match(RELEASE_WORD_RE);
		if (release && release.index! > 0) titlePart = stem.slice(0, release.index);
	}
	identity.title = cleanTitle(titlePart);
	return identity;
}

// Kodi, Jellyfin and Sonarr .nfo files

function tag(xml: string, name: string): string | undefined {
	const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>\\s*([^<]*?)\\s*</${name}>`, "i"));
	return m?.[1]
		? m[1]
				.replace(/&amp;/g, "&")
				.replace(/&lt;/g, "<")
				.replace(/&gt;/g, ">")
				.replace(/&quot;/g, '"')
				.replace(/&apos;/g, "'")
		: undefined;
}

function uniqueId(xml: string, type: string): string | undefined {
	const m = xml.match(new RegExp(`<uniqueid[^>]*type=["']${type}["'][^>]*>\\s*([^<\\s]+)\\s*</uniqueid>`, "i"));
	return m?.[1];
}

interface NfoIds {
	imdbId?: string;
	tmdbId?: number;
	title?: string;
	year?: number;
	season?: number;
	episode?: number;
}

export function parseNfo(xml: string): NfoIds {
	const out: NfoIds = {};
	const imdb = uniqueId(xml, "imdb") ?? tag(xml, "imdbid") ?? tag(xml, "imdb_id") ?? tag(xml, "id");
	if (imdb && /^tt\d{7,9}$/.test(imdb)) out.imdbId = imdb;
	const tmdb = uniqueId(xml, "tmdb") ?? tag(xml, "tmdbid");
	if (tmdb && /^\d+$/.test(tmdb)) out.tmdbId = parseInt(tmdb, 10);
	const title = tag(xml, "title");
	if (title) out.title = title;
	const year = tag(xml, "year") ?? tag(xml, "premiered")?.slice(0, 4);
	if (year && /^\d{4}$/.test(year)) out.year = parseInt(year, 10);
	const season = tag(xml, "season");
	if (season && /^\d+$/.test(season)) out.season = parseInt(season, 10);
	const episode = tag(xml, "episode");
	if (episode && /^\d+$/.test(episode)) out.episode = parseInt(episode, 10);
	return out;
}

function readNfo(path: string): { root: string; ids: NfoIds } | null {
	try {
		if (!existsSync(path)) return null;
		const xml = readFileSync(path, "utf-8").slice(0, 200_000);
		const root = xml.match(/<(movie|episodedetails|tvshow)[\s>]/i)?.[1]?.toLowerCase() ?? "";
		return { root, ids: parseNfo(xml) };
	} catch {
		return null;
	}
}

/**
 * Adds what media managers wrote next to the video: `<video>.nfo` or
 * `movie.nfo`, and `tvshow.nfo` one or two folders up for series. Their IDs
 * and episode numbers beat anything guessed from the file name.
 */
export function identifyMedia(videoPath: string): MediaIdentity {
	const identity = parseMediaName(videoPath);
	const dir = dirname(videoPath);
	const own = readNfo(join(dir, `${basename(videoPath, extname(videoPath))}.nfo`)) ?? readNfo(join(dir, "movie.nfo"));
	if (own?.root === "episodedetails" || (own && identity.kind === "episode" && own.root !== "movie")) {
		identity.kind = "episode";
		if (own.ids.season !== undefined) identity.season = own.ids.season;
		if (own.ids.episode !== undefined) identity.episode = own.ids.episode;
		if (own.ids.imdbId) identity.imdbId = own.ids.imdbId;
		identity.sources.push("episode .nfo");
	} else if (own) {
		identity.kind = "movie";
		if (own.ids.imdbId) identity.imdbId = own.ids.imdbId;
		if (own.ids.tmdbId) identity.tmdbId = own.ids.tmdbId;
		if (own.ids.title) identity.title = own.ids.title;
		if (own.ids.year) identity.year = own.ids.year;
		identity.sources.push("movie .nfo");
	}
	if (identity.kind === "episode") {
		for (const folder of [dir, dirname(dir)]) {
			const show = readNfo(join(folder, "tvshow.nfo"));
			if (!show) continue;
			if (show.ids.imdbId) identity.parentImdbId = show.ids.imdbId;
			if (show.ids.tmdbId) identity.parentTmdbId = show.ids.tmdbId;
			if (show.ids.title) identity.title = show.ids.title;
			identity.sources.push("tvshow.nfo");
			break;
		}
		// An absolute anime number without a season is the first season's, unless an .nfo said otherwise.
		identity.season ??= 1;
	}
	return identity;
}

/**
 * Lays what was entered in the search over the detected identity. Entering a
 * different kind drops the detected numbers and IDs, since an episode's IDs
 * find nothing in a movie search and the other way around.
 */
export function applyIdentityOverride(detected: MediaIdentity, entered: Partial<MediaIdentity>): MediaIdentity {
	if (!entered.kind || entered.kind === detected.kind) return { ...detected, ...entered };
	const { season: _s, episode: _e, imdbId: _i, tmdbId: _t, parentImdbId: _pi, parentTmdbId: _pt, ...kept } = detected;
	return { ...kept, ...entered, sources: [...detected.sources, "your entry"] };
}

const HASH_CHUNK = 65_536;

/** OpenSubtitles hash: the file size plus the 64-bit words of its first and last 64 KiB. */
export function movieHash(path: string): string | null {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const size = fstatSync(fd).size;
		if (size < HASH_CHUNK) return null;
		const buffer = Buffer.alloc(HASH_CHUNK * 2);
		readSync(fd, buffer, 0, HASH_CHUNK, 0);
		readSync(fd, buffer, HASH_CHUNK, HASH_CHUNK, size - HASH_CHUNK);
		const mask = (1n << 64n) - 1n;
		let hash = BigInt(size);
		for (let i = 0; i < buffer.length; i += 8) hash = (hash + buffer.readBigUInt64LE(i)) & mask;
		return hash.toString(16).padStart(16, "0");
	} catch {
		return null;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
