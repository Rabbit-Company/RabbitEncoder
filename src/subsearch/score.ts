import type { SubtitleHearingImpairedPreference } from "../core/types";
import { overlapMs } from "./align";
import { mergeIntervals, totalMs, type Interval } from "./cues";

export type ReferenceKind = "subtitle" | "bitmap" | "audio";

/**
 * Agreement a well synced subtitle reaches against each reference. Text and
 * bitmap subtitles mark speech closely. Detected speech also marks music and
 * noise, so even a perfect subtitle agrees with it far less.
 */
const GOOD_AGREEMENT: Record<ReferenceKind, number> = { subtitle: 0.7, bitmap: 0.65, audio: 0.4 };

/** Unrelated dialogue reaches about this over the square root of its cue count at its best offset. */
const SEARCH_BIAS = 3;

const COVERAGE_BIN_MS = 60_000;
/** A minute with this much reference speech should have some dialogue. */
const SPEECH_IN_BIN_MS = 8000;
const CUES_IN_BIN_MS = 1000;

export interface SyncQuality {
	/** 0 to 1. Agreement with the reference above chance, relative to what a good subtitle reaches. */
	sync: number;
	/** Agreement corrected for chance and for the search over offsets, kept for display and tuning. */
	agreement: number;
	/** Share of speech-filled minutes without dialogue. */
	missingShare: number;
	/** Longest run of such minutes. */
	longestGapMs: number;
	/** Share of dialogue time outside the video. */
	outsideShare: number;
	/** Dialogue time in the subtitle relative to the reference. */
	densityRatio: number;
}

/**
 * Compares synced dialogue with the reference. Agreement is corrected for
 * chance, as random dialogue already overlaps a dense reference a lot.
 */
export function measureSync(candidate: Interval[], reference: Interval[], durationMs: number, kind: ReferenceKind): SyncQuality {
	const cand = mergeIntervals(candidate);
	const ref = mergeIntervals(reference);
	const span = Math.max(durationMs, ref[ref.length - 1]?.endMs ?? 0, 1);
	const inside = mergeIntervals(cand.map((c) => ({ startMs: Math.max(0, c.startMs), endMs: Math.min(span, c.endMs) })));
	const candTotal = totalMs(cand);
	const insideTotal = totalMs(inside);
	const refTotal = totalMs(ref);
	const shared = overlapMs(inside, ref);
	const chance = (insideTotal * refTotal) / span;
	const best = Math.min(insideTotal, refTotal);
	const raw = best - chance > 0 ? Math.max(0, (shared - chance) / (best - chance)) : 0;
	// The sync searched thousands of offsets, so even unrelated dialogue agrees by about this much. Few cues agree by chance more.
	const searchBias = Math.min(0.9, SEARCH_BIAS / Math.sqrt(Math.max(1, Math.min(cand.length, ref.length))));
	const agreement = Math.max(0, (raw - searchBias) / (1 - searchBias));

	const bins = Math.ceil(span / COVERAGE_BIN_MS);
	const speech = new Float64Array(bins);
	const dialogue = new Float64Array(bins);
	const spread = (list: Interval[], into: Float64Array) => {
		for (const i of list) {
			for (let b = Math.floor(i.startMs / COVERAGE_BIN_MS); b <= Math.floor((i.endMs - 1) / COVERAGE_BIN_MS) && b < bins; b++) {
				const lo = Math.max(i.startMs, b * COVERAGE_BIN_MS);
				const hi = Math.min(i.endMs, (b + 1) * COVERAGE_BIN_MS);
				if (b >= 0 && hi > lo) into[b] = into[b]! + hi - lo;
			}
		}
	};
	spread(ref, speech);
	spread(inside, dialogue);
	let speechBins = 0;
	let missing = 0;
	let run = 0;
	let longest = 0;
	for (let b = 0; b < bins; b++) {
		if (speech[b]! < SPEECH_IN_BIN_MS) continue;
		speechBins++;
		if (dialogue[b]! < CUES_IN_BIN_MS) {
			missing++;
			run++;
			longest = Math.max(longest, run);
		} else run = 0;
	}

	return {
		sync: Math.min(1, agreement / GOOD_AGREEMENT[kind]),
		agreement,
		missingShare: speechBins ? missing / speechBins : 0,
		longestGapMs: longest * COVERAGE_BIN_MS,
		outsideShare: candTotal ? (candTotal - insideTotal) / candTotal : 0,
		densityRatio: refTotal ? insideTotal / refTotal : 0,
	};
}

export interface CandidateTraits {
	downloads: number;
	hashMatch: boolean;
	hearingImpaired: boolean;
	machineTranslated: boolean;
	trustedUploader: boolean;
	/** 0 to 1, how well its release name matches the video file name. */
	releaseMatch: number;
	/** Frame rate the subtitle was made for, 0 when unknown. */
	fps: number;
}

export type HearingImpairedPreference = SubtitleHearingImpairedPreference;

/** Points for or against a subtitle from its listing alone, before downloading it. */
export function priorPoints(t: CandidateTraits, hi: HearingImpairedPreference, videoFps: number): number {
	let points = 0;
	if (t.hashMatch) points += 25;
	points += t.releaseMatch * 15;
	points += Math.min(10, Math.log10(1 + t.downloads) * 2.5);
	if (t.trustedUploader) points += 3;
	if (t.machineTranslated) points -= 30;
	if (hi === "avoid" && t.hearingImpaired) points -= 8;
	if (hi === "prefer" && !t.hearingImpaired) points -= 8;
	if (t.fps && videoFps && Math.abs(t.fps - videoFps) < 0.01) points += 3;
	return points;
}

/**
 * Final 0 to 100 rating. Timing decides, as a subtitle that cannot be synced
 * is useless. Missing parts take away their share. The listing adds at most
 * a few points to tell close candidates apart.
 */
export function rateCandidate(quality: SyncQuality, traits: CandidateTraits, hi: HearingImpairedPreference): number {
	let rating = 100 * quality.sync * (1 - quality.missingShare) * (1 - quality.outsideShare);
	if (quality.longestGapMs >= 5 * 60_000) rating -= 15;
	if (traits.hashMatch) rating += 3;
	rating += Math.min(4, Math.log10(1 + traits.downloads));
	if (traits.machineTranslated) rating -= 20;
	if (hi === "avoid" && traits.hearingImpaired) rating -= 5;
	if (hi === "prefer" && !traits.hearingImpaired) rating -= 5;
	return Math.round(Math.max(0, Math.min(100, rating)));
}

const RELEASE_TOKENS = /[a-z0-9]+/g;
const NOISE_TOKENS = new Set(["mkv", "mp4", "avi", "srt", "sub", "subs", "the", "and", "a", "of", "x264", "x265", "h264", "h265", "hevc", "avc", "aac", "ac3"]);
const SOURCE_TOKENS: Record<string, string> = {
	bluray: "bluray",
	bdrip: "bluray",
	brrip: "bluray",
	bdremux: "bluray",
	remux: "bluray",
	webdl: "web",
	webrip: "web",
	web: "web",
	amzn: "web",
	nf: "web",
	dsnp: "web",
	hdtv: "hdtv",
	dvdrip: "dvd",
	dvd: "dvd",
};

function releaseTokens(name: string): Set<string> {
	const lower = name.toLowerCase().replace(/web[ .-]?dl/g, "webdl");
	return new Set((lower.match(RELEASE_TOKENS) ?? []).filter((t) => !NOISE_TOKENS.has(t)));
}

/**
 * 0 to 1 likeness of a subtitle's release name and the video file name.
 * The release group and source (BluRay, WEB) say most about timing.
 */
export function releaseMatch(release: string, fileName: string, group: string | null): number {
	if (!release.trim()) return 0;
	const a = releaseTokens(release);
	const b = releaseTokens(fileName);
	if (!a.size || !b.size) return 0;
	let shared = 0;
	for (const t of a) if (b.has(t)) shared++;
	let score = shared / Math.max(a.size, b.size);
	const source = (tokens: Set<string>) => [...tokens].map((t) => SOURCE_TOKENS[t]).find(Boolean);
	const sa = source(a);
	const sb = source(b);
	if (sa && sb) score += sa === sb ? 0.2 : -0.2;
	if (group && a.has(group.toLowerCase())) score += 0.4;
	return Math.max(0, Math.min(1, score));
}
