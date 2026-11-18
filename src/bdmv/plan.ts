import { basename } from "path";
import { classifyDisc, classifyMovieDisc, type DiscItem } from "./classify";
import { readDisc, type DiscFolder } from "./disc";
import type { TmdbMovie, TvdbSeries } from "./metadata";
import type { DiscIdentity, DiscMode, DiscOutputKind, NamingFormats } from "./naming";
import { numberRows } from "./numbering";

const DEFAULT_RUNTIME_MINUTES = 24;

export interface DiscRow extends Omit<DiscItem, "kind" | "selected"> {
	id: string;
	disc: number;
	discPath: string;
	discLabel: string;
	/** Seconds the whole playlist plays. */
	duration: number;
	kind: DiscOutputKind;
	selected: boolean;
	season?: number;
	episode?: number;
	title: string;
	edition?: string;
	warning?: string;
}

export interface DiscSetScan {
	path: string;
	name: string;
	mode: DiscMode;
	/** What to search for, from the folder names. */
	guessedTitle: string;
	guessedYear?: number;
	discs: { path: string; label: string; episodes: number; playlists: number }[];
	series?: TvdbSeries;
	movie?: TmdbMovie;
	/** Title, year and IDs the names are made from. */
	identity: DiscIdentity;
	formats: NamingFormats;
	season: number;
	firstEpisode: number;
	rows: DiscRow[];
	warnings: string[];
}

export interface DiscScanOptions {
	mode?: DiscMode;
	season?: number;
	firstEpisode?: number;
	/** Episodes per disc, by disc position, when the guess from the runtime is wrong. */
	episodeCounts?: Record<number, number>;
	series?: TvdbSeries;
	movie?: TmdbMovie;
	guessedTitle?: string;
	guessedYear?: number;
	formats: NamingFormats;
	/** Discs already read, so a disc is read once per scan. */
	read?: DiscFolder[];
}

function rowsOf(disc: DiscFolder, index: number, items: DiscItem[]): DiscRow[] {
	const durations = new Map(disc.playlists.map((p) => [p.name, p.mpls.items.reduce((s, i) => s + (i.outTime - i.inTime), 0) / 45_000]));
	return items.map((item) => ({
		...item,
		id: `${index}:${item.playlist}:${Math.round(item.start)}`,
		disc: index,
		discPath: disc.path,
		discLabel: disc.label,
		duration: durations.get(item.playlist) ?? item.end,
		kind: item.kind,
		selected: item.selected ?? true,
		title: "",
	}));
}

/** A movie set has one feature. Every disc proposes its best, and only the best of those stays ticked. */
function keepOneFeature(rows: DiscRow[], runtime?: number): void {
	const ticked = rows.filter((r) => r.kind === "movie" && r.selected);
	const distance = (r: DiscRow) => (runtime ? Math.abs(r.end - r.start - runtime) : -(r.end - r.start));
	const best = [...ticked].sort((a, b) => distance(a) - distance(b))[0];
	for (const row of ticked) {
		if (row === best) continue;
		row.selected = false;
		row.note ??= "Another feature-length playlist on another disc. Tick it and name its edition to keep both.";
	}
}

/** Reads every disc of a set and proposes what to encode and how to name it. */
export function scanDiscSet(setPath: string, discPaths: string[], options: DiscScanOptions): DiscSetScan {
	const mode = options.mode ?? "series";
	const series = mode === "series" ? options.series : undefined;
	const movie = mode === "movie" ? options.movie : undefined;
	const season = Math.max(1, Math.floor(options.season ?? 1));
	const firstEpisode = Math.max(1, Math.floor(options.firstEpisode ?? 1));
	const discs = options.read ?? discPaths.map((path) => readDisc(path));
	const rows: DiscRow[] = [];
	const summary: DiscSetScan["discs"] = [];
	discs.forEach((disc, index) => {
		const items =
			mode === "movie"
				? classifyMovieDisc(disc.playlists, { runtime: movie?.runtime ? movie.runtime * 60 : undefined })
				: classifyDisc(disc.playlists, { runtime: (series?.runtime ?? DEFAULT_RUNTIME_MINUTES) * 60, episodes: options.episodeCounts?.[index] });
		rows.push(...rowsOf(disc, index, items));
		summary.push({ path: disc.path, label: disc.label, episodes: items.filter((i) => i.kind === "episode").length, playlists: disc.playlists.length });
	});
	if (mode === "movie") keepOneFeature(rows, movie?.runtime ? movie.runtime * 60 : undefined);
	const warnings = numberRows(rows, season, firstEpisode, series);
	if (mode === "movie" && !rows.some((r) => r.kind === "movie"))
		warnings.push("No playlist is long enough to be the movie. Switch to Series if these discs hold episodes.");
	for (const disc of summary) if (!disc.playlists) warnings.push(`${disc.label} has no playlist whose clips are all there`);
	const found = series ?? movie;
	const identity: DiscIdentity = found
		? {
				title: found.title,
				year: found.year,
				imdbId: found.imdbId,
				tmdbId: found.tmdbId,
				...(series ? { tvdbId: series.tvdbId } : {}),
			}
		: { title: options.guessedTitle || basename(setPath), year: options.guessedYear };
	return {
		path: setPath,
		name: basename(setPath),
		mode,
		guessedTitle: options.guessedTitle ?? "",
		guessedYear: options.guessedYear,
		discs: summary,
		series,
		movie,
		identity,
		formats: options.formats,
		season,
		firstEpisode,
		rows,
		warnings,
	};
}
