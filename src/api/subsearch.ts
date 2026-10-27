import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "fs";
import { randomUUID } from "crypto";
import { basename, dirname, join, parse as parsePath } from "path";
import type { Web } from "@rabbit-company/web";
import type { AppConfig, SubtitleAddTrack } from "../core/types";
import { Logger } from "../core/logger";
import { probeFile } from "../pipeline/probe";
import { addSubtitleAddJob, getAppConfig } from "../queue/store";
import { buildSubtitleTrackName } from "../tracks/tracks";
import type { MediaIdentity } from "../subsearch/identify";
import { checkOpenSubtitles } from "../subsearch/opensubtitles";
import { accountFrom, LOGIN_NEEDED, searchSubtitles, type SubtitleSearchResult } from "../subsearch/search";
import { resolveTranslateLang } from "../translate/translate-languages";
import { resolveAllowedMediaFile } from "./repair";

/** Searches keep their synced files this long, for the user to apply one. */
const SEARCH_TTL_MS = 6 * 3_600_000;

interface StoredSearch {
	path: string;
	workDir: string;
	createdAt: number;
	state: "running" | "done" | "error";
	message: string;
	controller: AbortController;
	result?: SubtitleSearchResult;
	error?: string;
}

const searches = new Map<string, StoredSearch>();

function searchRoot(config: AppConfig): string {
	return join(config.tempDir, "subtitle-search");
}

/** Removes searches past their time, including folders left by a restart. */
function pruneSearches(config: AppConfig): void {
	const now = Date.now();
	for (const [id, s] of searches) {
		if (now - s.createdAt < SEARCH_TTL_MS) continue;
		s.controller.abort();
		rmSync(s.workDir, { recursive: true, force: true });
		searches.delete(id);
	}
	const root = searchRoot(config);
	if (!existsSync(root)) return;
	for (const name of readdirSync(root)) {
		const dir = join(root, name);
		try {
			if (!searches.has(name) && now - statSync(dir).mtimeMs > SEARCH_TTL_MS) rmSync(dir, { recursive: true, force: true });
		} catch {}
	}
}

/** The state of a search, and its result without server paths. */
function publicSearch(id: string, s: StoredSearch) {
	const base = { searchId: id, path: s.path, state: s.state, message: s.message, error: s.error };
	if (!s.result) return base;
	return {
		...base,
		...s.result,
		languages: s.result.languages.map((l) => ({ ...l, candidates: l.candidates.map(({ syncedPath: _, ...c }) => c) })),
	};
}

function identityOverride(raw: any): Partial<MediaIdentity> {
	if (!raw || typeof raw !== "object") return {};
	const out: Partial<MediaIdentity> = {};
	const int = (v: unknown, max: number) => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max ? v : undefined);
	if (typeof raw.title === "string" && raw.title.trim()) out.title = raw.title.trim().slice(0, 200);
	if (raw.kind === "movie" || raw.kind === "episode") out.kind = raw.kind;
	if (int(raw.year, 2100)) out.year = raw.year;
	if (int(raw.season, 999) !== undefined) out.season = raw.season;
	if (int(raw.episode, 99_999) !== undefined) out.episode = raw.episode;
	if (typeof raw.imdbId === "string" && /^tt\d{7,9}$/.test(raw.imdbId.trim())) out.imdbId = raw.imdbId.trim();
	return out;
}

export function registerSubtitleSearchRoutes(app: Web, config: AppConfig): void {
	app.post("/api/subsearch/test", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as { username?: string; password?: string };
		const account = accountFrom({
			...getAppConfig().defaults,
			openSubtitlesUsername: body.username ?? "",
			openSubtitlesPassword: body.password ?? "",
		});
		if (!account) return c.json({ ok: false, error: "Enter your username and password" });
		try {
			return c.json({ ok: true, ...(await checkOpenSubtitles(account)) });
		} catch (error) {
			return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	});

	/** Starts a search in the background. It reads the whole video and downloads files, which can take minutes. */
	app.post("/api/subsearch/search", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as { path?: unknown; languages?: unknown; identity?: unknown };
		pruneSearches(config);
		try {
			const path = resolveAllowedMediaFile(body.path, config, "Video");
			if (!Array.isArray(body.languages) || body.languages.some((l) => typeof l !== "string")) throw new Error("languages must be a list of language codes");
			const languages = [...new Set((body.languages as string[]).map((l) => l.trim()).filter(Boolean))].slice(0, 10);
			const unknown = languages.filter((l) => !resolveTranslateLang(l));
			if (unknown.length) throw new Error(`Unknown language: ${unknown.join(", ")}`);
			if (!languages.length) throw new Error("Choose at least one language");
			const settings = getAppConfig().defaults;
			if (!accountFrom(settings)) throw new Error(LOGIN_NEEDED);

			const id = randomUUID();
			const workDir = join(searchRoot(config), id);
			mkdirSync(workDir, { recursive: true });
			const stored: StoredSearch = { path, workDir, createdAt: Date.now(), state: "running", message: "Reading the video", controller: new AbortController() };
			searches.set(id, stored);
			void (async () => {
				try {
					const probe = await probeFile(path);
					stored.result = await searchSubtitles({
						inputPath: path,
						probe,
						languages,
						settings,
						cacheDir: config.tempDir,
						workDir,
						identity: identityOverride(body.identity),
						signal: stored.controller.signal,
						onProgress: (message) => (stored.message = message),
					});
					stored.state = "done";
					stored.message = "";
				} catch (error) {
					rmSync(workDir, { recursive: true, force: true });
					stored.state = "error";
					stored.error = stored.controller.signal.aborted ? "Search cancelled" : error instanceof Error ? error.message : String(error);
					Logger.warn(`[subsearch] Search for ${basename(path)} failed: ${stored.error}`);
				}
			})();
			return c.json(publicSearch(id, stored), 202);
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
		}
	});

	app.get("/api/subsearch/search/:id", (c) => {
		const search = searches.get(c.params.id!);
		return search ? c.json(publicSearch(c.params.id!, search)) : c.json({ error: "The search has expired. Search again." }, 404);
	});

	app.delete("/api/subsearch/search/:id", (c) => {
		const search = searches.get(c.params.id!);
		if (!search) return c.json({ error: "The search has expired" }, 404);
		search.controller.abort();
		if (search.state !== "running") {
			rmSync(search.workDir, { recursive: true, force: true });
			searches.delete(c.params.id!);
		}
		return c.json({ ok: true });
	});

	app.post("/api/subsearch/apply", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as { searchId?: unknown; choices?: unknown; mode?: unknown };
		try {
			const search = typeof body.searchId === "string" ? searches.get(body.searchId) : undefined;
			if (!search?.result) throw new Error("The search has expired. Search again.");
			const result = search.result;
			if (!Array.isArray(body.choices) || !body.choices.length) throw new Error("Choose a subtitle");
			const picked = (body.choices as Array<{ language?: unknown; key?: unknown }>).map((choice) => {
				const lang = result.languages.find((l) => l.language === choice.language);
				const candidate = lang?.candidates.find((x) => x.key === choice.key && x.status === "rated");
				if (!lang || !candidate?.syncedPath || !existsSync(candidate.syncedPath)) throw new Error("That subtitle is not available. Search again.");
				return { lang, candidate };
			});
			if (new Set(picked.map((p) => p.lang.language)).size !== picked.length) throw new Error("Choose one subtitle per language");

			if (body.mode === "sidecar") {
				const stem = parsePath(search.path).name;
				const written: string[] = [];
				for (const { lang, candidate } of picked) {
					const code = resolveTranslateLang(lang.language)?.code.split("-")[0] ?? lang.language;
					const target = join(dirname(search.path), `${stem}.${code}${candidate.hearingImpaired ? ".sdh" : ""}.${candidate.format}`);
					if (existsSync(target)) throw new Error(`${basename(target)} already exists`);
					copyFileSync(candidate.syncedPath!, target);
					written.push(basename(target));
				}
				Logger.info(`[subsearch] Saved ${written.join(", ")} next to ${basename(search.path)}`);
				return c.json({ ok: true, files: written });
			}

			const workDir = join(config.tempDir, "subtitle-add", randomUUID());
			mkdirSync(workDir, { recursive: true });
			const tracks: SubtitleAddTrack[] = picked.map(({ lang, candidate }) => {
				const file = join(workDir, `${lang.language}.${candidate.format}`);
				copyFileSync(candidate.syncedPath!, file);
				return {
					file,
					language: lang.language,
					trackName: buildSubtitleTrackName(candidate.hearingImpaired ? "sdh" : "full", undefined, "OpenSubtitles"),
					hearingImpaired: candidate.hearingImpaired,
				};
			});
			try {
				const job = addSubtitleAddJob({ targetPath: resolveAllowedMediaFile(search.path, config, "Video"), workDir, tracks });
				return c.json({ ok: true, jobId: job.id }, 201);
			} catch (error) {
				rmSync(workDir, { recursive: true, force: true });
				throw error;
			}
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
		}
	});
}
