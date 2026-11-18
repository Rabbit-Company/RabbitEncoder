/**
 * TVDB series and episodes through SkyHook, the metadata service Sonarr
 * itself uses, and TMDB movies through Radarr's. Neither needs an API key, and
 * both name and number things as Sonarr and Radarr do.
 */

const SKYHOOK = "https://skyhook.sonarr.tv/v1/tvdb";
const RADARR = "https://api.radarr.video/v1";
const TIMEOUT_MS = 15_000;
const CACHE_MS = 60 * 60 * 1000;

export interface TvdbSeries {
	tvdbId: number;
	title: string;
	year?: number;
	imdbId?: string;
	tmdbId?: number;
	/** Minutes, as TVDB rounds them. */
	runtime?: number;
	status?: string;
	episodes?: TvdbEpisode[];
}

export interface TvdbEpisode {
	season: number;
	episode: number;
	title: string;
	runtime?: number;
	airDate?: string;
}

const IMDB = /^tt\d{7,9}$/;

const cache = new Map<string, { at: number; value: unknown }>();

async function get<T>(url: string, signal?: AbortSignal): Promise<T> {
	const hit = cache.get(url);
	if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: { Accept: "application/json" } });
	if (!res.ok) throw new Error(`Metadata lookup failed (HTTP ${res.status})`);
	const value = (await res.json()) as T;
	cache.set(url, { at: Date.now(), value });
	return value;
}

const yearOf = (raw: any): number | undefined => {
	const year = Number(raw?.year) || Number(String(raw?.firstAired ?? "").slice(0, 4));
	return year > 1900 ? year : undefined;
};

export function parseSeries(raw: any): TvdbSeries | null {
	const tvdbId = Number(raw?.tvdbId);
	if (!Number.isInteger(tvdbId) || tvdbId <= 0 || typeof raw?.title !== "string") return null;
	const series: TvdbSeries = { tvdbId, title: raw.title, year: yearOf(raw) };
	if (typeof raw.imdbId === "string" && IMDB.test(raw.imdbId)) series.imdbId = raw.imdbId;
	if (Number.isInteger(raw.tmdbId) && raw.tmdbId > 0) series.tmdbId = raw.tmdbId;
	if (Number(raw.runtime) > 0) series.runtime = Number(raw.runtime);
	if (typeof raw.status === "string") series.status = raw.status;
	if (Array.isArray(raw.episodes)) {
		series.episodes = raw.episodes
			.filter((e: any) => Number.isInteger(e?.seasonNumber) && Number.isInteger(e?.episodeNumber))
			.map((e: any) => ({
				season: e.seasonNumber,
				episode: e.episodeNumber,
				title: typeof e.title === "string" ? e.title : "",
				...(Number(e.runtime) > 0 ? { runtime: Number(e.runtime) } : {}),
				...(typeof e.airDate === "string" ? { airDate: e.airDate } : {}),
			}))
			.sort((a: TvdbEpisode, b: TvdbEpisode) => a.season - b.season || a.episode - b.episode);
	}
	return series;
}

export async function searchSeries(term: string, signal?: AbortSignal): Promise<TvdbSeries[]> {
	const query = term.trim();
	if (!query) return [];
	const raw = await get<unknown[]>(`${SKYHOOK}/search/en/?term=${encodeURIComponent(query)}`, signal);
	return (Array.isArray(raw) ? raw : [])
		.map(parseSeries)
		.filter((s): s is TvdbSeries => !!s)
		.slice(0, 10);
}

export async function fetchSeries(tvdbId: number, signal?: AbortSignal): Promise<TvdbSeries> {
	if (!Number.isInteger(tvdbId) || tvdbId <= 0) throw new Error("Invalid TVDB ID");
	const series = parseSeries(await get<unknown>(`${SKYHOOK}/shows/en/${tvdbId}`, signal));
	if (!series) throw new Error(`TVDB has no series ${tvdbId}`);
	return series;
}

export interface TmdbMovie {
	tmdbId: number;
	title: string;
	year?: number;
	imdbId?: string;
	/** Minutes. */
	runtime?: number;
	originalTitle?: string;
}

export function parseMovie(raw: any): TmdbMovie | null {
	const tmdbId = Number(raw?.TmdbId);
	if (!Number.isInteger(tmdbId) || tmdbId <= 0 || typeof raw?.Title !== "string") return null;
	const movie: TmdbMovie = { tmdbId, title: raw.Title };
	if (Number(raw.Year) > 1800) movie.year = Number(raw.Year);
	if (typeof raw.ImdbId === "string" && IMDB.test(raw.ImdbId)) movie.imdbId = raw.ImdbId;
	if (Number(raw.Runtime) > 0) movie.runtime = Number(raw.Runtime);
	if (typeof raw.OriginalTitle === "string" && raw.OriginalTitle !== raw.Title) movie.originalTitle = raw.OriginalTitle;
	return movie;
}

/** Movies by title. A year, when known, puts the films of that year first. */
export async function searchMovies(term: string, year?: number, signal?: AbortSignal): Promise<TmdbMovie[]> {
	const query = term.trim();
	if (!query) return [];
	const raw = await get<unknown[]>(`${RADARR}/search?q=${encodeURIComponent(query)}`, signal);
	const movies = (Array.isArray(raw) ? raw : []).map(parseMovie).filter((m): m is TmdbMovie => !!m);
	if (year) movies.sort((a, b) => Number(Math.abs((b.year ?? 0) - year) <= 1) - Number(Math.abs((a.year ?? 0) - year) <= 1));
	return movies.slice(0, 10);
}

export async function fetchMovie(tmdbId: number, signal?: AbortSignal): Promise<TmdbMovie> {
	if (!Number.isInteger(tmdbId) || tmdbId <= 0) throw new Error("Invalid TMDB ID");
	const movie = parseMovie(await get<unknown>(`${RADARR}/movie/${tmdbId}`, signal));
	if (!movie) throw new Error(`TMDB has no movie ${tmdbId}`);
	return movie;
}
