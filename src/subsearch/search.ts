import { writeFileSync } from "fs";
import { basename, join } from "path";
import { Logger } from "../core/logger";
import { CancelledError } from "../core/process";
import { detectReleaseGroup } from "../core/naming";
import type { JobSettings, ProbeResult, SubtitleHearingImpairedPreference } from "../core/types";
import { normalizeTag, resolveTranslateLang } from "../translate/translate-languages";
import { alignToReference } from "./align";
import { dialogueCues, mapCue, retimeDocument, type TextCue } from "./cues";
import { decodeSubtitleBytes, toSubDocument } from "./formats";
import { identifyMedia, movieHash, type MediaIdentity } from "./identify";
import {
	downloadOpenSubtitles,
	isCachedListing,
	isQuotaError,
	checkOpenSubtitles,
	openSubtitlesApiKey,
	openSubtitlesLanguage,
	searchOpenSubtitles,
	type OpenSubtitlesAccount,
	type SubtitleListing,
} from "./opensubtitles";
import { buildReference, type ReferenceTimeline } from "./reference";
import { EXTRA_LANGUAGE_RESERVE } from "./languages";
import { measureSync, priorPoints, rateCandidate, releaseMatch, type CandidateTraits, type SyncQuality } from "./score";

/** A rating this high ends the search for a language early. */
const EXCELLENT_RATING = 88;
/** Fewer dialogue cues than this is a broken or foreign-parts-only file. */
const MIN_CUES = 40;
const SAMPLE_COUNT = 4;

export interface SampleLine {
	atMs: number;
	text: string;
	/** Reference text at the same time, when the reference is a text subtitle. */
	reference?: string;
}

export interface EvaluatedCandidate {
	key: string;
	provider: "opensubtitles";
	release: string;
	fileName: string;
	uploader: string;
	url: string;
	downloads: number;
	hearingImpaired: boolean;
	machineTranslated: boolean;
	trustedUploader: boolean;
	hashMatch: boolean;
	fps: number;
	prior: number;
	status: "rated" | "untested" | "excluded" | "failed";
	reason?: string;
	rating?: number;
	quality?: SyncQuality;
	/** Main shift in ms, frame rate scale, and how many parts were shifted on their own. */
	offsetMs?: number;
	scale?: number;
	pieces?: number;
	cueCount?: number;
	samples?: SampleLine[];
	/** Synced file on the server. Not sent to the browser. */
	syncedPath?: string;
	format?: "srt" | "ass";
}

export interface LanguageResult {
	/** Language tag as requested, used for the MKV track. */
	language: string;
	name: string;
	/** One of the most used languages, added on top of the requested ones. */
	extra?: boolean;
	candidates: EvaluatedCandidate[];
	bestKey?: string;
	note?: string;
}

export interface SubtitleSearchResult {
	identity: MediaIdentity;
	hash: string | null;
	reference: { kind: string; label: string } | null;
	languages: LanguageResult[];
	/** Downloads OpenSubtitles said are left today. */
	remainingDownloads?: number;
	notes: string[];
}

export interface SubtitleSearchOptions {
	inputPath: string;
	/** Where the video lives in the library, for its name and .nfo files. The input can be a staged copy of it. */
	identityPath?: string;
	/** File to hash for exact matches. The original when the input is an encode of it. */
	hashPath?: string;
	probe: ProbeResult;
	languages: string[];
	settings: JobSettings;
	/** Where downloads are cached across searches. */
	cacheDir: string;
	/** Scratch folder of this search, which keeps the synced files. */
	workDir: string;
	/** Override what the file name and .nfo files say. */
	identity?: Partial<MediaIdentity>;
	/** Downloads per language, instead of the setting. */
	maxTries?: number;
	/** Most new downloads for the whole search. Cached files are free. */
	downloadBudget?: number;
	/**
	 * Most used languages to try on top of `languages`: one download each, and
	 * only while more than EXTRA_LANGUAGE_RESERVE downloads are left today.
	 */
	extraLanguages?: string[];
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
}

export const LOGIN_NEEDED = "Log in with your OpenSubtitles.com account under Settings, Subtitle handling, Subtitle download first";

export function accountFrom(settings: JobSettings): OpenSubtitlesAccount | null {
	const username = settings.openSubtitlesUsername?.trim();
	const password = settings.openSubtitlesPassword;
	if (!username || !password) return null;
	return { apiKey: openSubtitlesApiKey(), username, password };
}

function traitsOf(l: SubtitleListing, fileName: string): CandidateTraits {
	return {
		downloads: l.downloads,
		hashMatch: l.hashMatch,
		hearingImpaired: l.hearingImpaired,
		machineTranslated: l.machineTranslated,
		trustedUploader: l.trustedUploader,
		releaseMatch: releaseMatch(l.release || l.fileName, fileName, detectReleaseGroup(fileName)),
		fps: l.fps,
	};
}

function candidateOf(l: SubtitleListing, prior: number): EvaluatedCandidate {
	return {
		key: l.key,
		provider: l.provider,
		release: l.release,
		fileName: l.fileName,
		uploader: l.uploader,
		url: l.url,
		downloads: l.downloads,
		hearingImpaired: l.hearingImpaired,
		machineTranslated: l.machineTranslated,
		trustedUploader: l.trustedUploader,
		hashMatch: l.hashMatch,
		fps: l.fps,
		prior: Math.round(prior * 10) / 10,
		status: "untested",
	};
}

function nearestText(cues: TextCue[], atMs: number): string | undefined {
	let best: TextCue | undefined;
	for (const cue of cues) {
		if (cue.endMs < atMs - 1500) continue;
		if (cue.startMs > atMs + 1500) break;
		if (!best || Math.abs(cue.startMs - atMs) < Math.abs(best.startMs - atMs)) best = cue;
	}
	return best?.text;
}

function samplesOf(cues: TextCue[], reference: ReferenceTimeline): SampleLine[] {
	const out: SampleLine[] = [];
	for (let i = 1; i <= SAMPLE_COUNT; i++) {
		const cue = cues[Math.floor((cues.length * i) / (SAMPLE_COUNT + 1))];
		if (!cue) continue;
		out.push({ atMs: cue.startMs, text: cue.text, reference: reference.cues ? nearestText(reference.cues, cue.startMs) : undefined });
	}
	return out;
}

/** Syncs a downloaded file to the reference and rates it. */
export function evaluateDownload(
	candidate: EvaluatedCandidate,
	bytes: Uint8Array,
	downloadedName: string,
	language: string,
	reference: ReferenceTimeline,
	durationMs: number,
	videoFps: number,
	traits: CandidateTraits,
	hi: SubtitleHearingImpairedPreference,
	outPath: (format: "srt" | "ass") => string,
): void {
	const doc = toSubDocument(decodeSubtitleBytes(bytes, language), downloadedName, videoFps);
	if (!doc) {
		candidate.status = "failed";
		candidate.reason = "Unknown subtitle format";
		return;
	}
	const cues = dialogueCues(doc);
	if (cues.length < MIN_CUES) {
		candidate.status = "failed";
		candidate.reason = `Only ${cues.length} dialogue lines`;
		return;
	}
	const aligned = alignToReference(cues, reference.intervals);
	const synced = cues.map((c) => mapCue(c, aligned.map));
	const quality = measureSync(synced, reference.intervals, durationMs, reference.kind);
	const path = outPath(doc.format);
	writeFileSync(path, retimeDocument(doc, aligned.map).content, "utf-8");
	Object.assign(candidate, {
		status: "rated",
		rating: rateCandidate(quality, traits, hi),
		quality,
		offsetMs: aligned.map.pieces[0]!.offsetMs,
		scale: aligned.map.scale,
		pieces: aligned.map.pieces.length,
		cueCount: cues.length,
		samples: samplesOf(synced, reference),
		syncedPath: path,
		format: doc.format,
	} satisfies Partial<EvaluatedCandidate>);
}

function describeSync(c: EvaluatedCandidate): string {
	const parts = [`${c.offsetMs! >= 0 ? "+" : ""}${(c.offsetMs! / 1000).toFixed(2)} s`];
	if (c.scale !== 1) parts.push(`speed x${c.scale!.toFixed(4)}`);
	if (c.pieces! > 1) parts.push(`${c.pieces} parts`);
	return parts.join(", ");
}

/**
 * Finds subtitles for every language, downloads the most promising ones,
 * syncs each to the video and rates it. The best rating at or above the
 * minimum score is chosen per language.
 */
export async function searchSubtitles(opts: SubtitleSearchOptions): Promise<SubtitleSearchResult> {
	const { settings, signal } = opts;
	const progress = opts.onProgress ?? (() => {});
	const account = accountFrom(settings);
	if (!account) throw new Error(LOGIN_NEEDED);

	const identity: MediaIdentity = { ...identifyMedia(opts.identityPath ?? opts.inputPath), ...(opts.identity ?? {}) };
	if (!identity.title && !identity.imdbId && !identity.tmdbId && !identity.parentImdbId && !identity.parentTmdbId)
		throw new Error("Could not tell the title from the file name. Enter it in the search.");
	const hash = movieHash(opts.hashPath ?? opts.inputPath);
	const notes: string[] = [];
	const fileName = basename(opts.identityPath ?? opts.inputPath);
	const hi = settings.subtitleDownloadHearingImpaired ?? "avoid";
	const allowMachine = settings.subtitleDownloadAllowMachine ?? false;
	const maxTries = opts.maxTries ?? settings.subtitleDownloadMaxTries ?? 2;
	let spent = 0;
	const minScore = settings.subtitleDownloadMinScore ?? 60;
	const durationMs = Math.round((opts.probe.duration || 0) * 1000);
	const videoFps = opts.probe.videoDisplayFps || opts.probe.videoStreamFps || 0;

	const wanted = [...opts.languages.map((tag) => ({ tag, extra: false })), ...(opts.extraLanguages ?? []).map((tag) => ({ tag, extra: true }))]
		.map(({ tag, extra }) => ({ tag: normalizeTag(tag.trim()), os: openSubtitlesLanguage(tag), lang: resolveTranslateLang(tag), extra }))
		.filter((w, i, all) => w.os && all.findIndex((x) => x.os === w.os) === i);
	if (!wanted.length) throw new Error("Choose at least one language OpenSubtitles knows");

	progress("Searching OpenSubtitles");
	const listings = await searchOpenSubtitles(
		account,
		identity,
		wanted.map((w) => w.os!),
		hash,
		signal,
	);

	let reference: ReferenceTimeline | null = null;
	let remaining: number | undefined;
	let quotaHit = false;
	const languages: LanguageResult[] = [];
	// Extras get what is left above the reserve, read once when the first one comes up.
	let extraBudget: number | undefined;
	let extraSpent = 0;

	for (const w of wanted) {
		const result: LanguageResult = { language: w.tag, name: w.lang?.name ?? w.tag, candidates: [], ...(w.extra ? { extra: true } : {}) };
		languages.push(result);
		if (w.extra && extraBudget === undefined) {
			try {
				const left = (await checkOpenSubtitles(account, signal)).remaining ?? remaining ?? 0;
				extraBudget = Math.max(0, left - EXTRA_LANGUAGE_RESERVE);
				if (!extraBudget)
					notes.push(`More languages were not downloaded, ${left} downloads are left today and ${EXTRA_LANGUAGE_RESERVE} are kept for chosen languages`);
			} catch (error) {
				if (error instanceof CancelledError || signal?.aborted) throw new CancelledError();
				extraBudget = 0;
				notes.push(`More languages were not downloaded, the download quota could not be read`);
			}
		}
		const languageTries = w.extra ? 1 : maxTries;
		const ranked = listings
			.filter((l) => l.language === w.os)
			.map((l) => ({ l, traits: traitsOf(l, fileName) }))
			.map((x) => ({ ...x, prior: priorPoints(x.traits, hi, videoFps), candidate: candidateOf(x.l, priorPoints(x.traits, hi, videoFps)) }))
			.sort((a, b) => b.prior - a.prior);
		result.candidates = ranked.map((r) => r.candidate);
		for (const r of ranked) {
			if (r.l.foreignPartsOnly) Object.assign(r.candidate, { status: "excluded", reason: "Foreign parts only" });
			else if (r.l.machineTranslated && !allowMachine) Object.assign(r.candidate, { status: "excluded", reason: "Machine translated" });
		}
		if (!ranked.length) {
			result.note = "OpenSubtitles has no subtitles in this language for the video";
			continue;
		}

		let tries = 0;
		for (const r of ranked) {
			if (signal?.aborted) throw new CancelledError();
			if (r.candidate.status === "excluded") continue;
			if (tries >= languageTries) {
				r.candidate.reason = "Not downloaded, better ones were tried first";
				continue;
			}
			const overBudget = w.extra ? extraSpent >= extraBudget! : opts.downloadBudget !== undefined && spent >= opts.downloadBudget;
			if (overBudget && !isCachedListing(r.l, opts.cacheDir)) {
				r.candidate.reason = "Not downloaded, keeping downloads for other files";
				continue;
			}
			reference ??= await (async () => {
				progress("Reading the video's timing");
				const ref = await buildReference(opts.inputPath, opts.probe, opts.workDir, signal);
				if (!ref) throw new Error("The video has no subtitles or audio to sync downloaded subtitles to");
				return ref;
			})();
			progress(`Downloading ${result.name}: ${r.l.release || r.l.fileName}`);
			try {
				const file = await downloadOpenSubtitles(account, r.l, opts.cacheDir, signal);
				if (!file.cached) {
					tries++;
					if (w.extra) extraSpent++;
					else spent++;
				}
				if (file.remaining !== undefined) remaining = file.remaining;
				progress(`Syncing ${result.name}: ${r.l.release || r.l.fileName}`);
				evaluateDownload(r.candidate, file.bytes, file.fileName, w.os!, reference, durationMs, videoFps, r.traits, hi, (format) =>
					join(opts.workDir, `${r.l.key}.${format}`),
				);
				if (r.candidate.status === "rated") {
					const q = r.candidate.quality!;
					Logger.info(
						`[subsearch] ${result.name} ${r.l.release || r.l.fileName}: rating ${r.candidate.rating}, agreement ${q.agreement.toFixed(2)}, missing ${Math.round(q.missingShare * 100)}%, ${describeSync(r.candidate)}`,
					);
				}
			} catch (error) {
				if (error instanceof CancelledError || signal?.aborted) throw new CancelledError();
				// Past the quota only cached files can still be tried, and refusals cost no request.
				if (isQuotaError(error)) {
					if (!quotaHit) notes.push(error.message);
					quotaHit = true;
					remaining = 0;
					r.candidate.reason = "Download limit reached";
				} else Object.assign(r.candidate, { status: "failed", reason: error instanceof Error ? error.message : String(error) });
				continue;
			}
			if ((r.candidate.rating ?? 0) >= EXCELLENT_RATING) break;
		}

		const best = result.candidates.filter((c) => c.status === "rated").sort((a, b) => b.rating! - a.rating!)[0];
		if (best && best.rating! >= minScore) result.bestKey = best.key;
		else if (best) result.note = `The best subtitle rated ${best.rating}, below the minimum of ${minScore}`;
	}

	return { identity, hash, reference: reference ? { kind: reference.kind, label: reference.label } : null, languages, remainingDownloads: remaining, notes };
}
