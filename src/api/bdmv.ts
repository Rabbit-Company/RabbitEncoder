import type { Web } from "@rabbit-company/web";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "fs";
import { basename, relative, isAbsolute, join, resolve } from "path";
import { readMkvTags } from "../core/mkv-tags";
import { CancelledError } from "../core/process";
import type { AppConfig, DiscPlan } from "../core/types";
import { discShape } from "../bdmv/classify";
import { findDiscFolders, groupDiscSets, guessDiscTitle, guessDiscYear, isDiscFolder, readDisc, type DiscFolder } from "../bdmv/disc";
import { clock, discSourcePath, originalName, parseDiscSource, type DiscOrigin } from "../bdmv/disc-source";
import { fetchMovie, fetchSeries, searchMovies, searchSeries, type TmdbMovie, type TvdbSeries } from "../bdmv/metadata";
import { parseMpls, playlistTimeline } from "../bdmv/mpls";
import { discOutputPath, type DiscIdentity, type DiscMode, type DiscOutputKind } from "../bdmv/naming";
import { episodeTag } from "../bdmv/numbering";
import { scanDiscSet, type DiscRow } from "../bdmv/plan";
import { detectedDiscSets, markDiscSet } from "../bdmv/watch";
import { playlistPath } from "../pipeline/disc-extract";
import { durationSeconds, identifyMatroska } from "../pipeline/repair";
import { parseEpisodeKey } from "../pipeline/repair-pairing";
import { pairOriginalSources } from "../video/source-pairing";
import { outputRoots } from "../pipeline/output";
import { addDiscJob } from "../queue/store";
import { COOLDOWN_SEC } from "../queue/watcher";
import { allowedRoots, resolveAllowedDirectory, resolveAllowedMediaFile } from "./repair";

const MAX_ROWS = 300;

/** The folders a disc set can be saved into, the output folder first, named by their folder unless two share a name. */
function destinations(config: AppConfig): { path: string; label: string }[] {
	const output = resolve(config.outputDir);
	const roots = outputRoots(config);
	const name = (path: string) => (path === output ? "Output" : basename(path) || path);
	return roots.map((path) => ({ path, label: roots.filter((other) => name(other) === name(path)).length > 1 ? path : name(path) }));
}

/** The title, year and IDs typed or picked in the review, checked before they go into names. */
function identityOf(raw: unknown): DiscIdentity {
	const id = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const title = typeof id.title === "string" ? id.title.trim().slice(0, 200) : "";
	if (!title) throw new Error("The title is required");
	const out: DiscIdentity = { title };
	const year = intOr(id.year, 0, 1800, 2200);
	if (year) out.year = year;
	if (typeof id.imdbId === "string" && /^tt\d{7,9}$/.test(id.imdbId)) out.imdbId = id.imdbId;
	const tvdbId = intOr(id.tvdbId, 0, 1, 1e9);
	if (tvdbId) out.tvdbId = tvdbId;
	const tmdbId = intOr(id.tmdbId, 0, 1, 1e9);
	if (tmdbId) out.tmdbId = tmdbId;
	return out;
}

const inside = (path: string, root: string) => {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const inInput = (path: string, config: AppConfig) => existsSync(config.inputDir) && inside(path, realpathSync(config.inputDir));

/** The discs of the chosen folder, which must be one disc set. */
export function discSetOf(raw: unknown, config: AppConfig): { path: string; discs: string[] } {
	const path = resolveAllowedDirectory(raw, config);
	const discs = findDiscFolders(path);
	if (!discs.length) throw new Error("No Blu-ray disc (a folder with BDMV/PLAYLIST and BDMV/STREAM) in this folder");
	if (discs.includes(path)) return { path, discs: [path] };
	// Picking the input, output or a library folder itself means its discs are unrelated.
	const sets = groupDiscSets(discs, allowedRoots(config).includes(path) ? [path] : []);
	if (sets.length > 1) throw new Error(`This folder holds ${sets.length} disc sets. Choose one of them: ${sets.map((s) => relative(path, s.path)).join(", ")}`);
	return { path, discs: sets[0]!.discs };
}

const intOr = (raw: unknown, fallback: number, min: number, max: number) => {
	const n = Number(raw);
	return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

function episodeCounts(raw: unknown): Record<number, number> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: Record<number, number> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(0, 50)) {
		const disc = Number(key);
		const count = Number(value);
		if (Number.isInteger(disc) && disc >= 0 && Number.isInteger(count) && count >= 0 && count <= 100) out[disc] = count;
	}
	return out;
}

/** The series or movie a disc set holds, from TVDB or TMDB, and whether it is one. Lookups that fail leave names to the folder. */
async function discMetadata(
	set: { path: string; discs: string[] },
	read: DiscFolder[],
	raw: { mode?: unknown; tvdbId?: unknown; tmdbId?: unknown },
	signal?: AbortSignal,
): Promise<{ mode: DiscMode; series?: TvdbSeries; movie?: TmdbMovie; guessedTitle: string; guessedYear?: number; warnings: string[] }> {
	const guessedTitle = guessDiscTitle(set.path, set.discs);
	const guessedYear = guessDiscYear(set.path, set.discs);
	const warnings: string[] = [];
	const failed = (what: string) => (error: any) => {
		warnings.push(`${what} lookup failed, so names come from the folder: ${error?.message || error}`);
		return undefined;
	};
	const tvdbId = intOr(raw.tvdbId, 0, 1, 1e9);
	const tmdbId = intOr(raw.tmdbId, 0, 1, 1e9);
	const lookSeries = () =>
		(tvdbId
			? fetchSeries(tvdbId, signal)
			: guessedTitle
				? searchSeries(guessedTitle, signal).then((found) => (found[0] ? fetchSeries(found[0].tvdbId, signal) : undefined))
				: Promise.resolve(undefined)
		).catch(failed("TVDB"));
	const lookMovie = () =>
		(tmdbId
			? fetchMovie(tmdbId, signal)
			: guessedTitle
				? searchMovies(guessedTitle, guessedYear, signal).then((found) => found[0])
				: Promise.resolve(undefined)
		).catch(failed("TMDB"));

	let mode: DiscMode | undefined = raw.mode === "movie" || raw.mode === "series" ? raw.mode : undefined;
	let series: TvdbSeries | undefined;
	let movie: TmdbMovie | undefined;
	if (mode === "series") series = await lookSeries();
	else if (mode === "movie") movie = await lookMovie();
	else {
		const shape = discShape(read.map((d) => d.playlists));
		if (shape === "series") {
			mode = "series";
			series = await lookSeries();
		} else {
			// A long playlist: a film, or episodes in one go. A film whose runtime fits it settles it.
			const longest = Math.max(...read.flatMap((d) => d.playlists.map((p) => playlistTimeline(p.mpls).duration)));
			[movie, series] = await Promise.all([lookMovie(), lookSeries()]);
			const fits = !!movie?.runtime && Math.abs(movie.runtime * 60 - longest) <= movie.runtime * 60 * 0.15;
			mode = fits ? "movie" : series || shape === "series-like" ? "series" : "movie";
		}
	}
	return { mode, series, movie, guessedTitle, guessedYear, warnings: warnings.filter((w) => w.startsWith(mode === "movie" ? "TMDB" : "TVDB")) };
}

/** An original given as a range of a disc in Rabbit's folders, checked against the disc. Null when it is not a disc range. */
export function resolveDiscSource(raw: unknown, config: AppConfig): string | null {
	const range = typeof raw === "string" ? parseDiscSource(raw.trim()) : null;
	if (!range) return null;
	const discPath = resolveAllowedDirectory(range.discPath, config);
	if (!isDiscFolder(discPath)) throw new Error("The original's disc has no BDMV folder");
	const mpls = playlistPath({ discPath, playlist: range.playlist });
	if (!existsSync(mpls)) throw new Error(`The original's disc has no playlist ${range.playlist}`);
	const { duration } = playlistTimeline(parseMpls(readFileSync(mpls)));
	if (!(range.start >= 0 && range.end > range.start + 1 && range.end <= duration + 1)) throw new Error("The original's range is outside its playlist");
	return discSourcePath({ ...range, discPath, end: Math.min(range.end, duration) });
}

/** An original that is a video file or a range of a disc. */
export const resolveOriginal = (raw: unknown, config: AppConfig, label: string): string =>
	resolveDiscSource(raw, config) ?? resolveAllowedMediaFile(raw, config, label);

/** Whether a folder holds Blu-ray discs, so originals are taken from them rather than from its videos. */
export function holdsDiscs(path: string): boolean {
	return findDiscFolders(path).length > 0;
}

export type DiscOriginalMethod = "disc" | "episode" | "filename" | "single" | "none";

export interface DiscOriginals {
	pairs: { targetPath: string; sourcePath: string; method: DiscOriginalMethod }[];
	/** Every item of the set, to choose one by hand. */
	sources: { path: string; name: string }[];
}

/** A remux holds the range cut at key frames, so it can be a few seconds shorter or longer. */
const lengthFits = (seconds: number, range: { start: number; end: number }) =>
	!(seconds > 0) || Math.abs(seconds - (range.end - range.start)) <= Math.max(5, (range.end - range.start) * 0.02);

const rowLabel = (row: DiscRow): string =>
	row.kind === "movie"
		? `Movie${row.edition ? ` (${row.edition})` : ""}`
		: row.kind === "extra"
			? `Extra${row.title ? ` ${row.title}` : ""}`
			: episodeTag(row.kind === "special" ? 0 : (row.season ?? 1), row.episode ?? 0);

/**
 * Pairs videos made from a disc set with their ranges on it. A video that
 * names its disc range in its tags finds it again. Others are matched by
 * episode number to the episodes a fresh read of the discs proposes, and
 * kept only when the lengths agree.
 */
export async function pairDiscOriginals(rawPath: unknown, targets: string[], config: AppConfig, signal?: AbortSignal): Promise<DiscOriginals> {
	const set = discSetOf(rawPath, config);
	const read = set.discs.map((disc) => readDisc(disc));
	const lengths = new Map(read.map((d) => [d.path, new Map(d.playlists.map((p) => [p.name, playlistTimeline(p.mpls).duration]))]));

	const info: { target: string; origin: DiscOrigin | null; seconds: number }[] = [];
	const tagDir = mkdtempSync(join(config.tempDir, "disc-pairs-"));
	try {
		for (const target of targets) {
			if (signal?.aborted) throw new CancelledError();
			const origin = (await readMkvTags(target, tagDir, signal)).disc;
			const seconds = await identifyMatroska(target, signal)
				.then(durationSeconds)
				.catch(() => 0);
			info.push({ target, origin, seconds });
		}
	} finally {
		rmSync(tagDir, { recursive: true, force: true });
	}

	const sources = new Map<string, string>();
	const pairs = new Map<string, DiscOriginals["pairs"][number]>();
	for (const { target, origin } of info) {
		if (!origin) continue;
		const fits = read.filter((d) => {
			const length = lengths.get(d.path)?.get(origin.playlist);
			return length !== undefined && Math.abs(length - origin.length) < 0.05;
		});
		const named = fits.filter((d) => d.label === origin.label);
		const disc = fits.length === 1 ? fits[0] : named.length === 1 ? named[0] : undefined;
		if (!disc) continue;
		const path = discSourcePath({ discPath: disc.path, playlist: origin.playlist, start: origin.start, end: origin.end });
		pairs.set(target, { targetPath: target, sourcePath: path, method: "disc" });
		sources.set(path, `From tags: ${originalName(path)}`);
	}

	const untagged = info.filter((i) => !pairs.has(i.target));
	const episodes = untagged.map((i) => parseEpisodeKey(i.target)).filter((key) => key !== null);
	const seasons = [...new Set(episodes.map((key) => key.season))];
	const found = await discMetadata(set, read, { mode: episodes.length ? "series" : "movie" }, signal);
	const scanFrom = (firstEpisode: number) =>
		scanDiscSet(set.path, set.discs, { ...found, read, formats: config.naming, season: seasons.length === 1 ? Math.max(1, seasons[0]!) : 1, firstEpisode });
	const rangeOf = (row: DiscRow) => discSourcePath({ discPath: row.discPath, playlist: row.playlist, start: row.start, end: row.end });

	const match = (rows: DiscRow[]) => {
		const out: DiscOriginals["pairs"] = [];
		const movies = rows.filter((r) => r.kind === "movie" && r.selected);
		if (found.mode === "movie" && untagged.length === 1 && movies.length === 1 && !episodes.length) {
			const { target, seconds } = untagged[0]!;
			if (lengthFits(seconds, movies[0]!)) out.push({ targetPath: target, sourcePath: rangeOf(movies[0]!), method: "single" });
			return out;
		}
		// Rows go in as made up file names, so the usual pairing by episode number and name applies.
		const names = rows.map((row, i) => `/disc/${i}/${discOutputPath(found.mode, config.naming, scanned.identity, row).filename}`);
		for (const pair of pairOriginalSources(
			untagged.map((i) => i.target),
			names,
		)) {
			const row = pair.sourcePath ? rows[Number(pair.sourcePath.split("/")[2])] : undefined;
			const seconds = info.find((i) => i.target === pair.targetPath)!.seconds;
			if (row && pair.method !== "single" && lengthFits(seconds, row)) out.push({ targetPath: pair.targetPath, sourcePath: rangeOf(row), method: pair.method });
		}
		return out;
	};

	// The set may start later in the season than episode 1, as a second volume does.
	let scanned = scanFrom(1);
	let best = untagged.length ? match(scanned.rows) : [];
	const lowest = Math.min(...episodes.filter((key) => seasons.length === 1 && key.season === seasons[0]).map((key) => key.episode));
	if (untagged.length && best.length < untagged.length && Number.isFinite(lowest) && lowest > 1) {
		const first = scanned;
		scanned = scanFrom(lowest);
		const later = match(scanned.rows);
		if (later.length > best.length) best = later;
		else scanned = first;
	}
	for (const pair of best) pairs.set(pair.targetPath, pair);
	for (const row of scanned.rows) {
		const path = rangeOf(row);
		if (!sources.has(path)) sources.set(path, `${rowLabel(row)}, ${row.discLabel}, playlist ${row.playlist}, ${clock(row.start)} to ${clock(row.end)}`);
	}

	return {
		pairs: targets.map((target) => pairs.get(target) ?? { targetPath: target, sourcePath: "", method: "none" }),
		sources: [...sources].map(([path, name]) => ({ path, name })),
	};
}

export function registerBdmvRoutes(app: Web, config: AppConfig): void {
	app.get("/api/bdmv/detected", (c) => c.json({ sets: detectedDiscSets(COOLDOWN_SEC) }));

	app.post("/api/bdmv/dismiss", async (c) => {
		try {
			const raw = (await c.req.json()) as { path?: unknown };
			const path = resolveAllowedDirectory(raw.path, config);
			if (!inInput(path, config)) throw new Error("Only disc sets in the input folder are offered");
			markDiscSet(path, "dismissed");
			return c.json({ ok: true });
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});

	app.get("/api/bdmv/search", async (c) => {
		try {
			const query = c.query();
			const term = (query.get("q") ?? "").slice(0, 200);
			if (query.get("mode") === "movie")
				return c.json({ movies: await searchMovies(term, intOr(query.get("year"), 0, 1800, 2200) || undefined, c.req.signal) });
			return c.json({ series: await searchSeries(term, c.req.signal) });
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 502);
		}
	});

	app.post("/api/bdmv/scan", async (c) => {
		try {
			const raw = (await c.req.json()) as {
				path?: unknown;
				mode?: unknown;
				tvdbId?: unknown;
				tmdbId?: unknown;
				season?: unknown;
				firstEpisode?: unknown;
				episodeCounts?: unknown;
			};
			const set = discSetOf(raw.path, config);
			const read = set.discs.map((disc) => readDisc(disc));
			const found = await discMetadata(set, read, { mode: raw.mode, tvdbId: raw.tvdbId, tmdbId: raw.tmdbId }, c.req.signal);
			const scan = scanDiscSet(set.path, set.discs, {
				...found,
				read,
				formats: config.naming,
				season: intOr(raw.season, 1, 1, 200),
				firstEpisode: intOr(raw.firstEpisode, 1, 1, 5000),
				episodeCounts: episodeCounts(raw.episodeCounts),
			});
			scan.warnings.unshift(...found.warnings);
			return c.json({ ...scan, destinations: destinations(config) });
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});

	/** The ranges of a disc set that videos made from it came from, for film grain. */
	app.post("/api/bdmv/originals", async (c) => {
		try {
			const raw = (await c.req.json()) as { path?: unknown; targets?: unknown };
			if (!Array.isArray(raw.targets) || !raw.targets.length) throw new Error("Choose the videos to find originals for");
			if (raw.targets.length > 500) throw new Error("Choose at most 500 videos");
			const targets = [...new Set(raw.targets.map((path) => resolveAllowedMediaFile(path, config, "Video")))];
			return c.json(await pairDiscOriginals(raw.path, targets, config, c.req.signal));
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});

	app.post("/api/bdmv/jobs", async (c) => {
		try {
			const raw = (await c.req.json()) as { path?: unknown; mode?: unknown; identity?: unknown; rows?: unknown; outputRoot?: unknown; remuxOnly?: unknown };
			const set = discSetOf(raw.path, config);
			const mode: DiscMode = raw.mode === "movie" ? "movie" : "series";
			const identity = identityOf(raw.identity);
			const roots = outputRoots(config);
			const outputRoot = typeof raw.outputRoot === "string" && raw.outputRoot.trim() ? resolve(raw.outputRoot.trim()) : resolve(config.outputDir);
			if (!roots.includes(outputRoot)) throw new Error("Save to must be the output folder or one of the library folders");
			const kinds: DiscOutputKind[] = mode === "movie" ? ["movie", "extra"] : ["episode", "special", "extra"];
			if (!Array.isArray(raw.rows) || !raw.rows.length) throw new Error("Choose at least one episode or extra");
			if (raw.rows.length > MAX_ROWS) throw new Error(`At most ${MAX_ROWS} items can be queued at once`);

			const timelines = new Map<string, ReturnType<typeof playlistTimeline>>();
			const plans: DiscPlan[] = raw.rows.map((row: any, i: number) => {
				const discPath = resolve(String(row?.discPath ?? ""));
				if (!set.discs.includes(discPath) || !isDiscFolder(discPath)) throw new Error(`Item ${i + 1} names a disc outside this set`);
				const playlist = String(row?.playlist ?? "");
				if (!/^\d{5}$/.test(playlist)) throw new Error(`Item ${i + 1} has an invalid playlist`);
				const mplsPath = playlistPath({ discPath, playlist });
				if (!existsSync(mplsPath)) throw new Error(`The disc has no playlist ${playlist}`);
				let timeline = timelines.get(mplsPath);
				if (!timeline) {
					timeline = playlistTimeline(parseMpls(readFileSync(mplsPath)));
					timelines.set(mplsPath, timeline);
				}
				const start = Number(row?.start);
				const end = Number(row?.end);
				if (!(start >= 0 && end > start + 1 && end <= timeline.duration + 1)) throw new Error(`Item ${i + 1} has an invalid range`);
				if (!kinds.includes(row?.kind)) throw new Error(`Item ${i + 1} cannot be a ${String(row?.kind).slice(0, 20)} in ${mode} mode`);
				const out = discOutputPath(mode, config.naming, identity, {
					kind: row.kind as DiscOutputKind,
					season: intOr(row?.season, 1, 0, 200),
					episode: intOr(row?.episode, 1, 0, 5000),
					title: typeof row?.title === "string" ? row.title.slice(0, 200) : "",
					edition: typeof row?.edition === "string" ? row.edition.slice(0, 100) : "",
				});
				return {
					discPath,
					playlist,
					start,
					end: Math.min(end, timeline.duration),
					duration: timeline.duration,
					...out,
					...(outputRoot !== resolve(config.outputDir) ? { outputRoot } : {}),
					...(raw.remuxOnly === true ? { remuxOnly: true } : {}),
				};
			});
			const names = plans.map((p) => `${p.relativePath}/${p.filename}`.toLowerCase());
			const twice = names.find((name, i) => names.indexOf(name) !== i);
			if (twice) throw new Error(`Two items would be written as ${twice}. Give them different numbers or names.`);

			const jobs = plans.map((plan) => addDiscJob(plan));
			if (inInput(set.path, config)) markDiscSet(set.path, "queued");
			return c.json({ jobIds: jobs.map((job) => job.id) }, 201);
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});
}
