import type { Web } from "@rabbit-company/web";
import { existsSync, readFileSync, realpathSync } from "fs";
import { basename, relative, isAbsolute, resolve } from "path";
import type { AppConfig, DiscPlan } from "../core/types";
import { discShape } from "../bdmv/classify";
import { findDiscFolders, groupDiscSets, guessDiscTitle, guessDiscYear, isDiscFolder, readDisc } from "../bdmv/disc";
import { fetchMovie, fetchSeries, searchMovies, searchSeries, type TmdbMovie, type TvdbSeries } from "../bdmv/metadata";
import { parseMpls, playlistTimeline } from "../bdmv/mpls";
import { discOutputPath, type DiscIdentity, type DiscMode, type DiscOutputKind } from "../bdmv/naming";
import { scanDiscSet } from "../bdmv/plan";
import { detectedDiscSets, markDiscSet } from "../bdmv/watch";
import { playlistPath } from "../pipeline/disc-extract";
import { outputRoots } from "../pipeline/output";
import { addDiscJob } from "../queue/store";
import { COOLDOWN_SEC } from "../queue/watcher";
import { allowedRoots, resolveAllowedDirectory } from "./repair";

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
function discSetOf(raw: unknown, config: AppConfig): { path: string; discs: string[] } {
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
					? fetchSeries(tvdbId, c.req.signal)
					: guessedTitle
						? searchSeries(guessedTitle, c.req.signal).then((found) => (found[0] ? fetchSeries(found[0].tvdbId, c.req.signal) : undefined))
						: Promise.resolve(undefined)
				).catch(failed("TVDB"));
			const lookMovie = () =>
				(tmdbId
					? fetchMovie(tmdbId, c.req.signal)
					: guessedTitle
						? searchMovies(guessedTitle, guessedYear, c.req.signal).then((found) => found[0])
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
			const scan = scanDiscSet(set.path, set.discs, {
				mode,
				series,
				movie,
				read,
				guessedTitle,
				guessedYear,
				formats: config.naming,
				season: intOr(raw.season, 1, 1, 200),
				firstEpisode: intOr(raw.firstEpisode, 1, 1, 5000),
				episodeCounts: episodeCounts(raw.episodeCounts),
			});
			scan.warnings.unshift(...warnings.filter((w) => w.startsWith(mode === "movie" ? "TMDB" : "TVDB")));
			return c.json({ ...scan, destinations: destinations(config) });
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});

	app.post("/api/bdmv/jobs", async (c) => {
		try {
			const raw = (await c.req.json()) as { path?: unknown; mode?: unknown; identity?: unknown; rows?: unknown; outputRoot?: unknown };
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
