/**
 * Names for disc imports, from templates written like Sonarr's and Radarr's
 * naming formats. Shared by the server and the dashboard.
 */

export type DiscMode = "series" | "movie";
export type DiscOutputKind = "episode" | "special" | "extra" | "movie";

export interface NamingFormats {
	seriesFolder: string;
	seasonFolder: string;
	specialsFolder: string;
	episode: string;
	movieFolder: string;
	movie: string;
}

export const DEFAULT_NAMING_FORMATS: NamingFormats = {
	seriesFolder: "{Series TitleYear}",
	seasonFolder: "Season {season:00}",
	specialsFolder: "Specials",
	episode: "{Series TitleYear} - S{season:00}E{episode:00} - {Episode Title}",
	movieFolder: "{Movie Title} ({Release Year})",
	movie: "{Movie Title} ({Release Year}) - {Edition Tags}",
};

export const SERIES_TOKENS = ["Series Title", "Series TitleYear", "Series Year", "Year", "ImdbId", "TvdbId", "TmdbId", "season", "episode", "Episode Title"];
export const MOVIE_TOKENS = ["Movie Title", "Movie TitleYear", "Release Year", "Year", "ImdbId", "TmdbId", "Edition Tags"];

/** What the series or movie is, from TVDB or TMDB or as typed. */
export interface DiscIdentity {
	title: string;
	year?: number;
	imdbId?: string;
	tvdbId?: number;
	tmdbId?: number;
}

export interface DiscOutputRow {
	kind: DiscOutputKind;
	season?: number;
	episode?: number;
	/** Episode title, or the name of an extra. */
	title: string;
	/** Edition of a movie, such as Director's Cut. */
	edition?: string;
}

const BAD: Record<string, string> = { "\\": "+", "/": "+", "<": "", ">": "", "?": "!", "*": "-", "|": "", '"': "" };

/**
 * Sonarr's file name cleaning, with its default colon replacement. Trailing
 * dots only go at the end of a whole name, so "Your Name." keeps its dot
 * inside "Your Name. (2016)".
 */
export function sonarrClean(name: string, trimEnd = true): string {
	const clean = name
		.replace(/[\\/<>?*|"]/g, (c) => BAD[c]!)
		.replace(/: /g, " - ")
		.replace(/:/g, "-")
		.replace(/[\u0000-\u001f]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return trimEnd ? clean.replace(/[.\s]+$/, "") : clean;
}

const EMPTY = "\u0001";
const TOKEN = /\{([A-Za-z][A-Za-z ]*?)(?::(0+))?\}/g;

/** Tokens a template names that are not in `known`, to warn about at startup. */
export function unknownTokens(template: string, known: string[]): string[] {
	const names = new Set(known.map((k) => k.toLowerCase()));
	return [...template.matchAll(TOKEN)].map((m) => m[1]!).filter((name) => !names.has(name.trim().toLowerCase()));
}

/**
 * Fills a template. `{season:00}` pads a number. A token without a value
 * takes the brackets around it and a dash before it along, so `[imdbid-{ImdbId}]`
 * and ` - {Edition Tags}` disappear when there is nothing to put in them.
 */
export function renderTemplate(template: string, values: Record<string, string | number | undefined>): string {
	const lower = Object.fromEntries(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]));
	let out = template.replace(TOKEN, (_, name: string, pad?: string) => {
		const value = lower[name.trim().toLowerCase()];
		if (value === undefined || value === "") return EMPTY;
		const text = typeof value === "number" && pad ? String(value).padStart(pad.length, "0") : String(value);
		return sonarrClean(text, false) || EMPTY;
	});
	const group = new RegExp(`[\\[({][^\\[\\](){}]*${EMPTY}[^\\[\\](){}]*[\\])}]`, "g");
	for (let before = ""; before !== out;) {
		before = out;
		out = out.replace(group, "");
	}
	out = out.replace(new RegExp(`\\s*-\\s*${EMPTY}`, "g"), "").replace(new RegExp(EMPTY, "g"), "");
	return sonarrClean(out.replace(/^\s*-\s+/, "").replace(/\s+-\s*$/, ""));
}

const titleYear = (title: string, year?: number) => (year && !/\(\d{4}\)$/.test(title.trim()) ? `${title} (${year})` : title);

function seriesValues(id: DiscIdentity, row?: DiscOutputRow): Record<string, string | number | undefined> {
	return {
		"Series Title": id.title,
		"Series TitleYear": titleYear(id.title, id.year),
		"Series Year": id.year,
		Year: id.year,
		ImdbId: id.imdbId,
		TvdbId: id.tvdbId,
		TmdbId: id.tmdbId,
		season: row?.season,
		episode: row?.episode,
		"Episode Title": row?.title,
	};
}

function movieValues(id: DiscIdentity, row?: DiscOutputRow): Record<string, string | number | undefined> {
	return {
		"Movie Title": id.title,
		"Movie TitleYear": titleYear(id.title, id.year),
		"Release Year": id.year,
		Year: id.year,
		ImdbId: id.imdbId,
		TmdbId: id.tmdbId,
		"Edition Tags": row?.edition,
	};
}

const or = (name: string, fallback: string) => name || fallback;

/** The series or movie folder, which is also where its extras go. */
export function discFolder(mode: DiscMode, formats: NamingFormats, id: DiscIdentity): string {
	return mode === "movie"
		? or(renderTemplate(formats.movieFolder, movieValues(id)), "Unknown Movie")
		: or(renderTemplate(formats.seriesFolder, seriesValues(id)), "Unknown Series");
}

/**
 * Where a disc item goes under the output folder, and the name the encode
 * keeps before it adds its own tags.
 */
export function discOutputPath(
	mode: DiscMode,
	formats: NamingFormats,
	id: DiscIdentity,
	row: DiscOutputRow,
): { relativePath: string; filename: string; outputTitle: string } {
	const folder = discFolder(mode, formats, id);
	const named = (relativePath: string, title: string) => ({ relativePath, filename: `${title}.mkv`, outputTitle: title });
	if (row.kind === "extra") return named(`${folder}/extras`, or(sonarrClean(row.title), "Extra"));
	if (row.kind === "movie") return named(folder, or(renderTemplate(formats.movie, movieValues(id, row)), folder));
	const season = row.kind === "special" ? 0 : Math.max(1, row.season ?? 1);
	const values = seriesValues(id, { ...row, season, episode: Math.max(0, row.episode ?? 0) });
	const seasonFolder = season === 0 ? renderTemplate(formats.specialsFolder, values) : renderTemplate(formats.seasonFolder, values);
	return named(`${folder}/${or(seasonFolder, season === 0 ? "Specials" : `Season ${season}`)}`, or(renderTemplate(formats.episode, values), folder));
}
