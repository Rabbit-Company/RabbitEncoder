import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "fs";
import { randomUUID } from "crypto";
import { basename, dirname, join, parse as parsePath } from "path";
import type { Web } from "@rabbit-company/web";
import type { AppConfig, SubtitleAddTrack, SubtitleStreamInfo } from "../core/types";
import { EXTRA_LANGUAGE_CHOICES, POPULAR_SUBTITLE_LANGUAGES } from "../subsearch/languages";
import { Logger } from "../core/logger";
import { probeFile } from "../pipeline/probe";
import { identifyMatroska } from "../pipeline/repair";
import { addSubtitleAddJob, getAppConfig } from "../queue/store";
import { candidateCredit, cleanPreferredSources, downloadedLanguageTag, downloadedTrackName } from "../subsearch/naming";
import { applyIdentityOverride, identifyMedia, type MediaIdentity } from "../subsearch/identify";
import { checkOpenSubtitles } from "../subsearch/opensubtitles";
import { accountFrom, LOGIN_NEEDED, searchSubtitles, tryCandidate, type SubtitleSearchResult } from "../subsearch/search";
import { resolveTranslateLang } from "../translate/translate-languages";
import { buildKeptDescriptors, missingTargetLanguages } from "../translate/translate-step";
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
	/** A candidate being downloaded on request, one at a time. */
	trying?: string;
	result?: SubtitleSearchResult;
	/** Asked for languages the video has a track in already, so they were not searched. */
	present?: PresentLanguage[];
	error?: string;
}

interface PresentLanguage {
	language: string;
	name: string;
	/** Title of the track the video has in it. */
	title?: string;
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

/** The most used languages, without the ones asked for and the ones the file has a dialogue track in. */
function extraLanguagesFor(count: number, chosen: string[], streams: SubtitleStreamInfo[]): string[] {
	const code = (tag: string | undefined) => resolveTranslateLang(tag)?.code;
	const taken = new Set([...chosen.map(code), ...streams.filter((s) => !s.isForced).map((s) => code(s.language))]);
	return POPULAR_SUBTITLE_LANGUAGES.slice(0, count).filter((tag) => !taken.has(code(tag)));
}

/**
 * Subtitle streams with the full language tags of an MKV. ffprobe gives a
 * zh-Hant track as plain "chi", which reads as Simplified Chinese.
 */
async function subtitleStreamsOf(path: string, streams: SubtitleStreamInfo[], signal: AbortSignal): Promise<SubtitleStreamInfo[]> {
	if (!/\.mk[av]$/i.test(path) || !streams.length) return streams;
	try {
		// The n-th subtitle stream ffprobe lists is the n-th subtitle track mkvmerge lists.
		const tracks = ((await identifyMatroska(path, signal)).tracks ?? []).filter((t) => t.type === "subtitles");
		return streams.map((s, i) => {
			const ietf = tracks[i]?.properties.language_ietf;
			return ietf && ietf !== "und" ? { ...s, language: ietf } : s;
		});
	} catch {
		return streams;
	}
}

/** The asked for languages a video has a full track in already, the way translation decides what is missing. */
function presentLanguages(languages: string[], streams: SubtitleStreamInfo[]): PresentLanguage[] {
	const missing = new Set(missingTargetLanguages(buildKeptDescriptors(streams), languages));
	return languages
		.filter((language) => !missing.has(language))
		.map((language) => {
			const lang = resolveTranslateLang(language);
			const track = streams.find((s) => !s.isForced && resolveTranslateLang(s.language)?.code === lang?.code);
			return { language, name: lang?.name ?? language, ...(track?.title ? { title: track.title } : {}) };
		});
}

/** The state of a search, and its result without server paths. */
function publicSearch(id: string, s: StoredSearch) {
	const base = { searchId: id, path: s.path, state: s.state, message: s.message, error: s.error, present: s.present ?? [] };
	if (!s.result) return base;
	const { session: _, ...result } = s.result;
	return {
		...base,
		...result,
		languages: result.languages.map((l) => ({
			...l,
			candidates: l.candidates.map(({ syncedPath: _, ...c }) => ({ ...c, credit: candidateCredit(c.release, c.uploader, c.fileName) })),
		})),
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
		const body = (await c.req.json().catch(() => ({}))) as {
			path?: unknown;
			languages?: unknown;
			identity?: unknown;
			extraLanguages?: unknown;
			preferredSources?: unknown;
			searchPresent?: unknown;
		};
		pruneSearches(config);
		try {
			const path = resolveAllowedMediaFile(body.path, config, "Video");
			if (!Array.isArray(body.languages) || body.languages.some((l) => typeof l !== "string")) throw new Error("languages must be a list of language codes");
			const languages = [...new Set((body.languages as string[]).map((l) => l.trim()).filter(Boolean))].slice(0, 10);
			const unknown = languages.filter((l) => !resolveTranslateLang(l));
			if (unknown.length) throw new Error(`Unknown language: ${unknown.join(", ")}`);
			const extraCount = (EXTRA_LANGUAGE_CHOICES as readonly unknown[]).includes(body.extraLanguages) ? (body.extraLanguages as number) : 0;
			if (!languages.length && !extraCount) throw new Error("Choose at least one language");
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
					const streams = await subtitleStreamsOf(path, probe.subtitleStreams ?? [], stored.controller.signal);
					stored.present = body.searchPresent === true ? [] : presentLanguages(languages, streams);
					const missing = languages.filter((language) => !stored.present!.some((p) => p.language === language));
					const extraLanguages = extraLanguagesFor(extraCount, languages, streams);
					// Reading the video for a sync reference is the slow part, and nothing would use it.
					if (!missing.length && !extraLanguages.length) {
						const identity = applyIdentityOverride(identifyMedia(path), identityOverride(body.identity));
						stored.result = { identity, hash: null, reference: null, languages: [], notes: [] };
						stored.state = "done";
						stored.message = "";
						return;
					}
					stored.result = await searchSubtitles({
						inputPath: path,
						probe,
						languages: missing,
						extraLanguages,
						...(Array.isArray(body.preferredSources) ? { preferredSources: cleanPreferredSources(body.preferredSources) } : {}),
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

	/** Downloads and rates a candidate the search did not get to. */
	app.post("/api/subsearch/search/:id/try", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as { language?: unknown; key?: unknown };
		const search = searches.get(c.params.id!);
		try {
			if (!search?.result) throw new Error("The search has expired. Search again.");
			if (search.trying) throw new Error("Another subtitle is downloading. Wait for it to finish.");
			if (typeof body.language !== "string" || typeof body.key !== "string") throw new Error("Choose a subtitle to try");
			search.trying = body.key;
			try {
				await tryCandidate(search.result, body.language, body.key, search.controller.signal);
			} finally {
				search.trying = undefined;
				search.message = "";
			}
			return c.json(publicSearch(c.params.id!, search));
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
		}
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
			const picked = (body.choices as Array<{ language?: unknown; key?: unknown; credit?: unknown }>).map((choice) => {
				const lang = result.languages.find((l) => l.language === choice.language);
				const candidate = lang?.candidates.find((x) => x.key === choice.key && x.status === "rated");
				if (!lang || !candidate?.syncedPath || !existsSync(candidate.syncedPath)) throw new Error("That subtitle is not available. Search again.");
				// Brackets would break the "[Credit]" at the end of the track name.
				const credit = typeof choice.credit === "string" ? choice.credit.replace(/[[\]]/g, "").trim().slice(0, 60) : "";
				return { lang, candidate, credit };
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
			const tracks: SubtitleAddTrack[] = picked.map(({ lang, candidate, credit }) => {
				const file = join(workDir, `${lang.language}.${candidate.format}`);
				copyFileSync(candidate.syncedPath!, file);
				return {
					file,
					language: downloadedLanguageTag(lang.language),
					trackName: downloadedTrackName(candidate.hearingImpaired ? "sdh" : "full", candidate.release, candidate.uploader, candidate.fileName, credit),
					hearingImpaired: candidate.hearingImpaired,
					...(lang.extra ? { extra: true } : {}),
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
