import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import pkg from "../../package.json";
import { Logger } from "../core/logger";
import { resolveTranslateLang } from "../translate/translate-languages";
import type { MediaIdentity } from "./identify";

const API_HOST = "api.opensubtitles.com";
/** Rabbit Encoder's consumer key. Downloads count against each user's own account, not against it. */
const CONSUMER_API_KEY = "MOC1iverTtdWX6eMaABxzSvtubl0uwgs";
const USER_AGENT = `RabbitEncoder v${pkg.version}`;
const MAX_PAGES = 2;

export interface OpenSubtitlesAccount {
	apiKey: string;
	username: string;
	password: string;
}

/** The consumer key, which OPENSUBTITLES_API_KEY can replace with one of your own. */
export function openSubtitlesApiKey(): string {
	return process.env.OPENSUBTITLES_API_KEY?.trim() || CONSUMER_API_KEY;
}

/** One subtitle file as OpenSubtitles lists it. */
export interface SubtitleListing {
	provider: "opensubtitles";
	/** Stable key for caching and choosing, unique across providers. */
	key: string;
	fileId: number;
	fileName: string;
	/** OpenSubtitles language code, such as "sl" or "pt-br". */
	language: string;
	release: string;
	downloads: number;
	hearingImpaired: boolean;
	machineTranslated: boolean;
	foreignPartsOnly: boolean;
	trustedUploader: boolean;
	hashMatch: boolean;
	fps: number;
	uploader: string;
	url: string;
	featureTitle: string;
}

export class OpenSubtitlesError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		/** When the download quota is used up, the time it resets. */
		readonly resetAt?: number,
	) {
		super(message);
		this.name = "OpenSubtitlesError";
	}
}

/** OpenSubtitles language code for a language tag, or null when it has none. */
export function openSubtitlesLanguage(tag: string): string | null {
	const lang = resolveTranslateLang(tag);
	if (!lang) return null;
	const code = lang.code.toLowerCase();
	const base = code.split("-")[0]!;
	if (base === "pt") return /-br\b/.test(code) ? "pt-br" : "pt-pt";
	if (base === "zh") return /hant|-tw\b|-hk\b|-mo\b/.test(code) ? "zh-tw" : "zh-cn";
	// OpenSubtitles lists Filipino subtitles as Tagalog.
	if (base === "fil") return "tl";
	return base;
}

interface Session {
	token: string;
	host: string;
	expiresAt: number;
}

/** Login tokens by account, valid for a day. */
const sessions = new Map<string, Session>();

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
	return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

function sessionKey(account: OpenSubtitlesAccount): string {
	return `${account.apiKey}\n${account.username ?? ""}\n${account.password ?? ""}`;
}

async function request(
	account: OpenSubtitlesAccount,
	method: "GET" | "POST",
	path: string,
	opts: { host?: string; token?: string; params?: Record<string, string>; body?: unknown; signal?: AbortSignal } = {},
): Promise<any> {
	// Parameters must be sorted and lower case, or the API answers with a redirect.
	const query = opts.params
		? "?" +
			Object.keys(opts.params)
				.sort()
				.map((k) => `${k}=${encodeURIComponent(opts.params![k]!.toLowerCase())}`)
				.join("&")
		: "";
	const headers: Record<string, string> = { "Api-Key": account.apiKey, "User-Agent": USER_AGENT, Accept: "application/json" };
	if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
	if (opts.body !== undefined) headers["Content-Type"] = "application/json";
	for (let attempt = 0; ; attempt++) {
		const res = await fetch(`https://${opts.host ?? API_HOST}/api/v1${path}${query}`, {
			method,
			headers,
			body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
			signal: withTimeout(opts.signal, 30_000),
		});
		if (res.status === 429 && attempt < 3) {
			await Bun.sleep(1000 * (attempt + 1));
			continue;
		}
		const text = await res.text();
		let data: any = null;
		try {
			data = text ? JSON.parse(text) : null;
		} catch {}
		if (!res.ok) {
			const detail = data?.message || data?.errors?.join?.(", ") || text.slice(0, 200) || res.statusText;
			if (res.status === 401 && path === "/login") throw new OpenSubtitlesError("OpenSubtitles refused the username or password", 401);
			if (res.status === 401 || res.status === 403) throw new OpenSubtitlesError(`OpenSubtitles refused the request: ${detail}`, res.status);
			if (res.status === 406 || res.status === 407)
				throw new OpenSubtitlesError(`OpenSubtitles download limit reached: ${detail}`, res.status, resetTime(data?.reset_time_utc));
			throw new OpenSubtitlesError(`OpenSubtitles answered ${res.status}: ${detail}`, res.status);
		}
		return data;
	}
}

/** Logs in once a day. Downloads need a login, as Rabbit's consumer does not allow anonymous ones. */
async function session(account: OpenSubtitlesAccount, signal?: AbortSignal): Promise<Session> {
	const key = sessionKey(account);
	const cached = sessions.get(key);
	if (cached && cached.expiresAt > Date.now()) return cached;
	const data = await request(account, "POST", "/login", { body: { username: account.username, password: account.password }, signal });
	if (!data?.token) throw new OpenSubtitlesError("OpenSubtitles login returned no token");
	const next = { token: data.token as string, host: (data.base_url as string) || API_HOST, expiresAt: Date.now() + 23 * 3_600_000 };
	sessions.set(key, next);
	return next;
}

/** Runs a request with the login, logging in again once if OpenSubtitles dropped the token early. */
async function withSession<T>(account: OpenSubtitlesAccount, signal: AbortSignal | undefined, call: (s: Session) => Promise<T>): Promise<T> {
	const current = await session(account, signal);
	try {
		return await call(current);
	} catch (error) {
		if (!(error instanceof OpenSubtitlesError) || error.status !== 401) throw error;
		sessions.delete(sessionKey(account));
		return call(await session(account, signal));
	}
}

function imdbDigits(id: string | undefined): string | undefined {
	const digits = id?.replace(/^tt/i, "").replace(/^0+/, "");
	return digits || undefined;
}

/** Search parameters for the media, IDs first, the title only when there are none. */
export function searchParams(identity: MediaIdentity, languages: string[], hash: string | null): Record<string, string> {
	const params: Record<string, string> = { languages: [...new Set(languages)].sort().join(",") };
	if (hash) params.moviehash = hash;
	if (identity.kind === "episode") {
		if (identity.imdbId) params.imdb_id = imdbDigits(identity.imdbId)!;
		else if (identity.parentImdbId) params.parent_imdb_id = imdbDigits(identity.parentImdbId)!;
		else if (identity.parentTmdbId) params.parent_tmdb_id = String(identity.parentTmdbId);
		else params.query = identity.title;
		if (!identity.imdbId) {
			if (identity.season !== undefined) params.season_number = String(identity.season);
			if (identity.episode !== undefined) params.episode_number = String(identity.episode);
		}
		params.type = "episode";
	} else {
		if (identity.imdbId) params.imdb_id = imdbDigits(identity.imdbId)!;
		else if (identity.tmdbId) params.tmdb_id = String(identity.tmdbId);
		else {
			params.query = identity.title;
			if (identity.year) params.year = String(identity.year);
		}
		params.type = "movie";
	}
	return params;
}

function listing(item: any): SubtitleListing[] {
	const a = item?.attributes ?? {};
	const files: any[] = Array.isArray(a.files) ? a.files : [];
	return files.slice(0, 1).map((file) => ({
		provider: "opensubtitles" as const,
		key: `os-${file.file_id}`,
		fileId: Number(file.file_id),
		fileName: String(file.file_name ?? ""),
		language: String(a.language ?? "").toLowerCase(),
		release: String(a.release ?? ""),
		downloads: Number(a.download_count ?? 0) || 0,
		hearingImpaired: !!a.hearing_impaired,
		machineTranslated: !!a.machine_translated || !!a.ai_translated,
		foreignPartsOnly: !!a.foreign_parts_only,
		trustedUploader: !!a.from_trusted,
		hashMatch: !!a.moviehash_match,
		fps: Number(a.fps ?? 0) || 0,
		uploader: String(a.uploader?.name ?? ""),
		url: String(a.url ?? ""),
		featureTitle: String(a.feature_details?.movie_name ?? a.feature_details?.title ?? ""),
	}));
}

export async function searchOpenSubtitles(
	account: OpenSubtitlesAccount,
	identity: MediaIdentity,
	languages: string[],
	hash: string | null,
	signal?: AbortSignal,
): Promise<SubtitleListing[]> {
	const params = searchParams(identity, languages, hash);
	const out = new Map<string, SubtitleListing>();
	for (let page = 1; page <= MAX_PAGES; page++) {
		const data = await withSession(account, signal, (s) =>
			request(account, "GET", "/subtitles", { host: s.host, token: s.token, params: { ...params, page: String(page) }, signal }),
		);
		for (const item of data?.data ?? []) for (const l of listing(item)) if (!out.has(l.key) && l.fileId) out.set(l.key, l);
		if (page >= Number(data?.total_pages ?? 1)) break;
	}
	Logger.info(`[subsearch] OpenSubtitles listed ${out.size} subtitle(s) for ${JSON.stringify(params)}`);
	return [...out.values()];
}

function resetTime(raw: unknown): number | undefined {
	const at = typeof raw === "string" ? Date.parse(raw) : NaN;
	return Number.isFinite(at) && at > Date.now() ? at : undefined;
}

/**
 * Downloads are refused until this time once the quota is used up, so a
 * season batch does not ask again for every episode. Cached files still work.
 */
let downloadsBlockedUntil = 0;

function blockDownloads(resetAt: number | undefined): void {
	downloadsBlockedUntil = resetAt ?? Date.now() + 3_600_000;
	Logger.warn(`[subsearch] OpenSubtitles download quota used up until ${new Date(downloadsBlockedUntil).toISOString()}`);
}

export function isQuotaError(error: unknown): error is OpenSubtitlesError {
	return error instanceof OpenSubtitlesError && (error.status === 406 || error.status === 407);
}

export interface DownloadedFile {
	fileName: string;
	bytes: Uint8Array;
	/** True when it came from the cache and used no quota. */
	cached: boolean;
	/** Downloads left today, when OpenSubtitles said. */
	remaining?: number;
}

function cacheDir(tempDir: string): string {
	const dir = join(tempDir, "subtitle-cache", "opensubtitles");
	mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * Downloads a subtitle file. Every download counts against the daily quota,
 * so files are kept and reused. Their content never changes.
 */
/** The file was downloaded before, so using it costs no quota. */
export function isCachedListing(l: SubtitleListing, tempDir: string): boolean {
	const dir = join(tempDir, "subtitle-cache", "opensubtitles");
	return existsSync(join(dir, `${l.fileId}.bin`)) && existsSync(join(dir, `${l.fileId}.json`));
}

export async function downloadOpenSubtitles(account: OpenSubtitlesAccount, l: SubtitleListing, tempDir: string, signal?: AbortSignal): Promise<DownloadedFile> {
	const dir = cacheDir(tempDir);
	const dataPath = join(dir, `${l.fileId}.bin`);
	const metaPath = join(dir, `${l.fileId}.json`);
	if (existsSync(dataPath) && existsSync(metaPath)) {
		const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as { fileName: string };
		return { fileName: meta.fileName, bytes: new Uint8Array(readFileSync(dataPath)), cached: true };
	}
	if (Date.now() < downloadsBlockedUntil)
		throw new OpenSubtitlesError(`OpenSubtitles download limit reached until ${new Date(downloadsBlockedUntil).toLocaleString()}`, 407, downloadsBlockedUntil);
	let data: any;
	try {
		data = await withSession(account, signal, (s) =>
			request(account, "POST", "/download", { host: s.host, token: s.token, body: { file_id: l.fileId }, signal }),
		);
	} catch (error) {
		if (isQuotaError(error)) blockDownloads(error.resetAt);
		throw error;
	}
	if (!data?.link) throw new OpenSubtitlesError(data?.message || "OpenSubtitles returned no download link");
	const res = await fetch(data.link, { headers: { "User-Agent": USER_AGENT }, signal: withTimeout(signal, 60_000) });
	if (!res.ok) throw new OpenSubtitlesError(`Subtitle download failed with ${res.status}`, res.status);
	const bytes = new Uint8Array(await res.arrayBuffer());
	if (!bytes.length) throw new OpenSubtitlesError("OpenSubtitles sent an empty file");
	const fileName = String(data.file_name || l.fileName || `${l.fileId}.srt`);
	writeFileSync(dataPath, bytes);
	writeFileSync(metaPath, JSON.stringify({ fileName, release: l.release, language: l.language }));
	const remaining = typeof data.remaining === "number" ? data.remaining : undefined;
	if (remaining !== undefined && remaining <= 0) blockDownloads(resetTime(data.reset_time_utc));
	Logger.info(`[subsearch] Downloaded ${fileName} from OpenSubtitles${remaining !== undefined ? ` (${remaining} downloads left today)` : ""}`);
	return { fileName, bytes, cached: false, remaining };
}

/** Checks the login and reports the download quota. */
export async function checkOpenSubtitles(
	account: OpenSubtitlesAccount,
	signal?: AbortSignal,
): Promise<{ user: string; remaining: number | null; allowed: number | null }> {
	const data = await withSession(account, signal, (s) => request(account, "GET", "/infos/user", { host: s.host, token: s.token, signal }));
	const d = data?.data ?? {};
	return {
		user: String(d.username ?? account.username),
		remaining: typeof d.remaining_downloads === "number" ? d.remaining_downloads : null,
		allowed: typeof d.allowed_downloads === "number" ? d.allowed_downloads : null,
	};
}
