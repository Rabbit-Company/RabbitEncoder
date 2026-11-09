import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";
import pkg from "../../package.json";
import { Logger } from "../core/logger";
import { isZip, readZip } from "../core/zip";
import { resolveTranslateLang } from "../translate/translate-languages";
import type { MediaIdentity } from "./identify";
import type { DownloadedFile, SubtitleListing } from "./listing";
import { otherEpisode } from "./score";

const API_URL = "https://api.subdl.com/api/v1";
const DOWNLOAD_URL = "https://dl.subdl.com";
const USER_AGENT = `RabbitEncoder v${pkg.version}`;
const SUBTITLE_FILE = /\.(?:srt|ass|ssa|vtt|sub|txt)$/i;

export interface SubdlAccount {
	apiKey: string;
}

export class SubdlError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "SubdlError";
	}
}

/** SubDL language code for a language tag, or null when it has none. */
export function subdlLanguage(tag: string): string | null {
	const lang = resolveTranslateLang(tag);
	if (!lang) return null;
	const code = lang.code.toLowerCase();
	const base = code.split("-")[0]!;
	if (base === "pt") return /-br\b/.test(code) ? "BR_PT" : "PT";
	// SubDL files Traditional Chinese as "Big 5 code".
	if (base === "zh") return /hant|-tw\b|-hk\b|-mo\b/.test(code) ? "ZH_BG" : "ZH";
	if (base === "fil") return "TL";
	if (base === "nb" || base === "nn") return "NO";
	return base.toUpperCase();
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
	return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

async function request(account: SubdlAccount, path: string, params: Record<string, string>, signal?: AbortSignal): Promise<any> {
	const query = new URLSearchParams({ api_key: account.apiKey, ...params });
	for (let attempt = 0; ; attempt++) {
		const res = await fetch(`${API_URL}${path}?${query}`, {
			headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
			signal: withTimeout(signal, 30_000),
		});
		if (res.status === 429 && attempt < 2) {
			await Bun.sleep(1500 * (attempt + 1));
			continue;
		}
		const text = await res.text();
		let data: any = null;
		try {
			data = text ? JSON.parse(text) : null;
		} catch {}
		const detail = data?.message || data?.error || text.slice(0, 200) || res.statusText;
		if (res.status === 401 || res.status === 403) throw new SubdlError(`SubDL refused the API key: ${detail}`, res.status);
		if (res.status === 429) throw new SubdlError(`SubDL request limit reached: ${detail}`, res.status);
		if (!res.ok) throw new SubdlError(`SubDL answered ${res.status}: ${detail}`, res.status);
		return data;
	}
}

/**
 * Search parameters for the media. SubDL files episodes under their series,
 * so an episode is searched by the series' ID with its season and episode.
 */
export function subdlSearchParams(identity: MediaIdentity, languages: string[]): Record<string, string> {
	const params: Record<string, string> = {
		languages: [...new Set(languages)].sort().join(","),
		subs_per_page: "30",
		unpack: "1",
		client: "custom_integration",
	};
	if (identity.kind === "episode") {
		if (identity.parentImdbId) params.imdb_id = identity.parentImdbId;
		else if (identity.parentTmdbId) params.tmdb_id = String(identity.parentTmdbId);
		else params.film_name = identity.title;
		if (identity.season !== undefined) params.season_number = String(identity.season);
		if (identity.episode !== undefined) params.episode_number = String(identity.episode);
		params.type = "tv";
	} else {
		if (identity.imdbId) params.imdb_id = identity.imdbId;
		else if (identity.tmdbId) params.tmdb_id = String(identity.tmdbId);
		else {
			params.film_name = identity.title;
			if (identity.year) params.year = String(identity.year);
		}
		params.type = "movie";
	}
	return params;
}

/** "/subtitle/3197651-3213944.zip" or "/subtitle/3197651/file1" as a key safe for file names. */
function keyOf(path: string): string {
	return `sd-${path
		.replace(/^\/?subtitle\//, "")
		.replace(/\.zip$/i, "")
		.replace(/[^A-Za-z0-9_-]+/g, "-")}`;
}

/**
 * The listings of one SubDL subtitle. A pack that lists its files gives the
 * file of the searched episode, any other subtitle its archive.
 */
export function subdlListings(sub: any, identity: MediaIdentity, featureTitle = ""): SubtitleListing[] {
	const base = {
		provider: "subdl" as const,
		fileId: 0,
		downloads: 0,
		machineTranslated: false,
		foreignPartsOnly: false,
		trustedUploader: false,
		hashMatch: false,
		fps: Number(sub?.fps ?? 0) || 0,
		uploader: String(sub?.author ?? ""),
		url: typeof sub?.subtitlePage === "string" && sub.subtitlePage ? `https://subdl.com${sub.subtitlePage}` : "",
		featureTitle,
		...(identity.kind === "episode" ? { season: identity.season, episode: identity.episode } : {}),
	};
	const language = String(sub?.language ?? "").toUpperCase();
	const files: any[] = Array.isArray(sub?.unpack_files) ? sub.unpack_files : [];
	if (files.length) {
		return files
			.filter((f) => typeof f?.url === "string" && f.url && SUBTITLE_FILE.test(String(f.name ?? "")))
			.filter(
				(f) =>
					identity.kind !== "episode" ||
					((f.episode == null || Number(f.episode) === identity.episode) &&
						(f.season == null || identity.season === undefined || Number(f.season) === identity.season)),
			)
			.map((f) => ({
				...base,
				key: keyOf(f.url),
				downloadPath: String(f.url),
				fileName: String(f.name),
				language: String(f.language ?? language).toUpperCase(),
				release: String(f.release_name || sub.release_name || ""),
				hearingImpaired: f.hi != null ? !!f.hi : !!sub.hi,
			}));
	}
	if (typeof sub?.url !== "string" || !sub.url) return [];
	return [
		{
			...base,
			key: keyOf(sub.url),
			downloadPath: sub.url,
			fileName: String(sub.name ?? ""),
			language,
			release: String(sub.release_name ?? ""),
			hearingImpaired: !!sub.hi,
		},
	];
}

export async function searchSubdl(account: SubdlAccount, identity: MediaIdentity, languages: string[], signal?: AbortSignal): Promise<SubtitleListing[]> {
	const params = subdlSearchParams(identity, languages);
	const data = await request(account, "/subtitles", params, signal);
	// No match comes back as status false with an error, which is no failure.
	if (data?.status === false) {
		Logger.info(`[subsearch] SubDL found nothing for ${JSON.stringify(params)}: ${data.error ?? "no reason given"}`);
		return [];
	}
	const featureTitle = String(data?.results?.[0]?.name ?? "");
	const out = new Map<string, SubtitleListing>();
	for (const sub of data?.subtitles ?? []) for (const l of subdlListings(sub, identity, featureTitle)) if (!out.has(l.key)) out.set(l.key, l);
	Logger.info(`[subsearch] SubDL listed ${out.size} subtitle(s) for ${JSON.stringify(params)}`);
	return [...out.values()];
}

export function isSubdlQuotaError(error: unknown): error is SubdlError {
	return error instanceof SubdlError && error.status === 429;
}

function cachePaths(tempDir: string, l: SubtitleListing): { data: string; meta: string } {
	const dir = join(tempDir, "subtitle-cache", "subdl");
	return { data: join(dir, `${l.key}.bin`), meta: join(dir, `${l.key}.json`) };
}

export function isCachedSubdl(l: SubtitleListing, tempDir: string): boolean {
	const p = cachePaths(tempDir, l);
	return existsSync(p.data) && existsSync(p.meta);
}

/** The subtitle file in an archive, the one of the listing's episode when it holds several. */
export function pickArchiveEntry(entries: { name: string; data: Uint8Array }[], season?: number, episode?: number) {
	const subs = entries.filter((e) => SUBTITLE_FILE.test(e.name));
	const fitting = subs.filter((e) => !otherEpisode(basename(e.name), season, episode));
	return (fitting.length ? fitting : subs).sort((a, b) => b.data.length - a.data.length)[0];
}

async function fetchFile(account: SubdlAccount, path: string, signal?: AbortSignal): Promise<Response> {
	const url = `${DOWNLOAD_URL}${path.startsWith("/") ? "" : "/"}${path}`;
	const get = (key?: string) =>
		fetch(url, { headers: { "User-Agent": USER_AGENT, ...(key ? { "x-api-key": key } : {}) }, signal: withTimeout(signal, 60_000) });
	// A paid key downloads on the account's quota. Others are refused and download on the anonymous one.
	const res = await get(account.apiKey);
	return [401, 402, 403].includes(res.status) ? get() : res;
}

/** Downloads a subtitle. SubDL sends an archive for most, so the file is taken out of it. */
export async function downloadSubdl(account: SubdlAccount, l: SubtitleListing, tempDir: string, signal?: AbortSignal): Promise<DownloadedFile> {
	if (!l.downloadPath) throw new SubdlError("SubDL listed no download for this subtitle");
	const paths = cachePaths(tempDir, l);
	let bytes: Uint8Array;
	let fileName: string;
	let cached = false;
	if (isCachedSubdl(l, tempDir)) {
		bytes = new Uint8Array(readFileSync(paths.data));
		fileName = (JSON.parse(readFileSync(paths.meta, "utf-8")) as { fileName: string }).fileName;
		cached = true;
	} else {
		const res = await fetchFile(account, l.downloadPath, signal);
		if (res.status === 429) throw new SubdlError("SubDL download limit reached, 300 a day without a paid plan", 429);
		if (!res.ok) throw new SubdlError(`SubDL download failed with ${res.status}`, res.status);
		bytes = new Uint8Array(await res.arrayBuffer());
		if (!bytes.length) throw new SubdlError("SubDL sent an empty file");
		fileName = l.fileName || basename(l.downloadPath);
		mkdirSync(join(tempDir, "subtitle-cache", "subdl"), { recursive: true });
		writeFileSync(paths.data, bytes);
		writeFileSync(paths.meta, JSON.stringify({ fileName, release: l.release, language: l.language }));
		Logger.info(`[subsearch] Downloaded ${fileName} from SubDL`);
	}
	// The archive is kept whole, as one archive can hold the files of several episodes.
	if (!isZip(bytes)) return { fileName, bytes, cached };
	const entry = pickArchiveEntry(readZip(bytes), l.season, l.episode);
	if (!entry) throw new SubdlError("The SubDL archive holds no subtitle file");
	return { fileName: basename(entry.name), bytes: entry.data, cached };
}

/** Checks the API key. */
export async function checkSubdl(account: SubdlAccount, signal?: AbortSignal): Promise<{ ok: true }> {
	const data = await request(account, "/me", {}, signal);
	if (data?.status === false) throw new SubdlError(`SubDL refused the API key: ${data.error ?? data.message ?? "no reason given"}`);
	return { ok: true };
}
