import type { AudioStreamInfo, ProbeResult } from "../core/types";
import { probeFile } from "../pipeline/probe";
import type { Interval, TimeMap } from "../subsearch/cues";
import { bestLagOnCoarse, cachedAudioEnvelope, COARSE_RATE, correlationAt, downsample, ENVELOPE_RATE, MAX_LAG_SEC } from "./audio-envelope";

const COARSE_FACTOR = ENVELOPE_RATE / COARSE_RATE;
const MS_PER_STEP = 1000 / ENVELOPE_RATE;
/** Each window of the target is searched for on its own, starting every STEP. */
const WINDOW = 60 * ENVELOPE_RATE;
const STEP = 20 * ENVELOPE_RATE;
const MIN_WINDOW = 20 * ENVELOPE_RATE;
/** A window's best lag counts as a possible offset of the whole file from this correlation on. */
const CANDIDATE_MIN = 0.3;
/** Windows that correlate this well at their chosen lag count as matched. */
export const RELEASE_MATCH_MIN = 0.35;
/** Lags this close are the same offset found twice. */
const LAG_TOLERANCE = 3;
const MAX_CANDIDATES = 40;
/**
 * A change of offset between windows costs this much correlation. Windows
 * overlap, so a real cut wins in several of them, while a stray peak in one
 * silent window does not add up to a change.
 */
const CHANGE_PENALTY = 0.8;
/** A frame rate change must beat no change by this much, so noise never picks one. */
const SCALE_MARGIN = 1.03;

export interface EnvelopeAlignOptions {
	/** Frame rate changes to try on top of none, as source time multipliers. */
	scales?: number[];
	maxLagSec?: number;
}

export interface EnvelopeAlignment {
	/** Turns a time in the source into the time the same moment has in the target. */
	map: TimeMap;
	/** Median correlation of the target's windows at their chosen offsets, 0 to 1. */
	confidence: number;
	/** Share of the target's windows that matched the source. */
	coveredShare: number;
	/** Parts of the source, in source time, that the target does not have. */
	removed: Interval[];
}

/** Target time less source time for a lag, without the -0 a lag of 0 would give. */
const offsetOf = (lag: number) => (lag ? -lag * MS_PER_STEP : 0);

const NO_MATCH: EnvelopeAlignment = { map: { scale: 1, pieces: [{ fromMs: 0, offsetMs: 0 }] }, confidence: 0, coveredShare: 0, removed: [] };

/** The source played `scale` times slower, so its timeline lines up with the target's. */
function stretch(env: Float32Array, scale: number): Float32Array {
	if (scale === 1) return env;
	const out = new Float32Array(Math.floor(env.length * scale));
	for (let i = 0; i < out.length; i++) {
		const pos = i / scale;
		const k = Math.floor(pos);
		const t = pos - k;
		out[i] = env[k]! * (1 - t) + (env[k + 1] ?? env[k]!) * t;
	}
	return out;
}

function median(values: number[]): number {
	if (!values.length) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)]!;
}

function percentile(values: Float64Array, share: number): number {
	const finite = Array.from(values).filter(Number.isFinite);
	if (!finite.length) return 0;
	finite.sort((a, b) => a - b);
	return finite[Math.floor((finite.length - 1) * share)]!;
}

/** Level difference of every target step against the source at `lag`, after the two releases' gain difference. */
function differences(target: Float32Array, source: Float32Array, lag: number, from: number, to: number): Float64Array {
	const raw: number[] = [];
	for (let i = from; i < to; i++) {
		const j = i + lag;
		if (j >= 0 && j < source.length) raw.push(target[i]! - source[j]!);
	}
	const gain = median(raw);
	const out = new Float64Array(to - from);
	for (let i = from; i < to; i++) {
		const j = i + lag;
		out[i - from] = j >= 0 && j < source.length ? Math.abs(target[i]! - source[j]! - gain) : Infinity;
	}
	return out;
}

/**
 * Where the offset changes from `lagA` to `lagB` inside the target's steps
 * `from` to `to`. Returns the last step of the first offset (s1) and the
 * first step of the second (s2). They differ when the target has footage the
 * source lacks, which matches neither offset.
 */
export function splitPoints(target: Float32Array, source: Float32Array, lagA: number, lagB: number, from: number, to: number): { s1: number; s2: number } {
	const dA = differences(target, source, lagA, from, to);
	const dB = differences(target, source, lagB, from, to);
	const tau = Math.max(0.02, 1.5 * (percentile(dA, 0.25) + percentile(dB, 0.25)));
	const gain = (d: number) => Math.max(-tau, Math.min(tau, tau - d));
	const n = to - from;
	// before[k]: what the first offset earns on steps before k. after[k]: the second from k on.
	const before = new Float64Array(n + 1);
	for (let i = 0; i < n; i++) before[i + 1] = before[i]! + gain(dA[i]!);
	const after = new Float64Array(n + 1);
	for (let i = n - 1; i >= 0; i--) after[i] = after[i + 1]! + gain(dB[i]!);
	let best = -Infinity;
	let s1 = 0;
	let s2 = 0;
	let bestBefore = 0;
	for (let k = 0; k <= n; k++) {
		if (before[k]! > before[bestBefore]!) bestBefore = k;
		const total = before[bestBefore]! + after[k]!;
		if (total > best) {
			best = total;
			s1 = bestBefore;
			s2 = k;
		}
	}
	return { s1: from + s1, s2: from + s2 };
}

/**
 * Lines a source's audio envelope up with a target's, allowing parts of
 * either to be missing in the other, and a frame rate change.
 */
export function alignEnvelopes(target: Float32Array, source: Float32Array, options: EnvelopeAlignOptions = {}): EnvelopeAlignment {
	const maxLagSec = options.maxLagSec ?? MAX_LAG_SEC;
	const coarseTarget = downsample(target, COARSE_FACTOR);

	let scale = 1;
	let stretched = source;
	let coarseSource = downsample(source, COARSE_FACTOR);
	let scaleScore = bestLagOnCoarse(target, stretched, coarseTarget, coarseSource, maxLagSec).score * SCALE_MARGIN;
	for (const candidate of new Set(options.scales ?? [])) {
		if (candidate === 1 || !(candidate > 0)) continue;
		const s = stretch(source, candidate);
		const cs = downsample(s, COARSE_FACTOR);
		const score = bestLagOnCoarse(target, s, coarseTarget, cs, maxLagSec).score;
		if (score > scaleScore) {
			scale = candidate;
			stretched = s;
			coarseSource = cs;
			scaleScore = score;
		}
	}

	const windows: Array<{ from: number; to: number }> = [];
	for (let from = 0; from + MIN_WINDOW <= target.length; from += STEP) windows.push({ from, to: Math.min(from + WINDOW, target.length) });
	if (!windows.length) return NO_MATCH;

	const found: Array<{ lag: number; score: number }> = [];
	for (const w of windows) {
		const hit = bestLagOnCoarse(target, stretched, coarseTarget, coarseSource, maxLagSec, w.from, w.to);
		if (hit.score >= CANDIDATE_MIN) found.push(hit);
	}
	if (!found.length) return NO_MATCH;
	found.sort((a, b) => a.lag - b.lag);
	const clusters: Array<{ lag: number; score: number }> = [];
	let last = -Infinity;
	for (const hit of found) {
		const current = clusters[clusters.length - 1];
		if (current && hit.lag - last <= LAG_TOLERANCE) {
			if (hit.score > current.score) Object.assign(current, hit);
		} else clusters.push({ ...hit });
		last = hit.lag;
	}
	const lags = clusters
		.sort((a, b) => b.score - a.score)
		.slice(0, MAX_CANDIDATES)
		.map((c) => c.lag);

	const scores = windows.map((w) => lags.map((lag) => Math.max(0, correlationAt(target, stretched, lag, w.from, w.to))));

	// One offset per window: the most correlation, less the cost of every change.
	const back = windows.map(() => new Int32Array(lags.length));
	let total = scores[0]!.slice();
	for (let w = 1; w < windows.length; w++) {
		let leader = 0;
		for (let c = 1; c < lags.length; c++) if (total[c]! > total[leader]!) leader = c;
		const next = new Array<number>(lags.length);
		for (let c = 0; c < lags.length; c++) {
			const stay = total[c]!;
			const jump = total[leader]! - CHANGE_PENALTY;
			back[w]![c] = stay >= jump ? c : leader;
			next[c] = Math.max(stay, jump) + scores[w]![c]!;
		}
		total = next;
	}
	const chosen = new Array<number>(windows.length);
	chosen[windows.length - 1] = total.indexOf(Math.max(...total));
	for (let w = windows.length - 1; w > 0; w--) chosen[w - 1] = back[w]![chosen[w]!]!;

	const toSourceMs = (steps: number) => (steps / scale) * MS_PER_STEP;
	const pieces: TimeMap["pieces"] = [{ fromMs: 0, offsetMs: offsetOf(lags[chosen[0]!]!) }];
	const removed: Interval[] = [];
	for (let w = 1; w < windows.length; w++) {
		const lagA = lags[chosen[w - 1]!]!;
		const lagB = lags[chosen[w]!]!;
		if (lagA === lagB) continue;
		const { s1, s2 } = splitPoints(target, stretched, lagA, lagB, windows[w - 1]!.from, windows[w]!.to);
		const endA = s1 + lagA;
		const startB = s2 + lagB;
		const fromMs = Math.round(toSourceMs(startB));
		if (fromMs <= pieces[pieces.length - 1]!.fromMs) continue;
		pieces.push({ fromMs, offsetMs: offsetOf(lagB) });
		if (startB - endA > LAG_TOLERANCE) removed.push({ startMs: Math.round(toSourceMs(endA)), endMs: fromMs });
	}

	const chosenScores = windows.map((_, w) => scores[w]![chosen[w]!]!);
	return {
		map: { scale, pieces },
		confidence: median(chosenScores),
		coveredShare: chosenScores.filter((s) => s >= RELEASE_MATCH_MIN).length / windows.length,
		removed,
	};
}

export interface ReleaseAlignment extends EnvelopeAlignment {
	targetAudio: AudioStreamInfo;
	sourceAudio: AudioStreamInfo;
}

export interface ReleaseAlignOptions {
	/** App temp folder, where envelopes are cached across jobs. */
	cacheDir: string;
	targetProbe?: ProbeResult;
	sourceProbe?: ProbeResult;
	signal?: AbortSignal;
}

/** The stream in `language` when there is one, else the original, else the first. */
export function pickAlignmentAudio(streams: AudioStreamInfo[], language?: string): AudioStreamInfo | undefined {
	return (language && streams.find((s) => s.language === language)) || streams.find((s) => s.isOriginal) || streams[0];
}

/** Envelopes start where each audio stream starts, subtitles at the file's zero, so the map moves by the two delays. */
export function toFileTimes(aligned: EnvelopeAlignment, targetDelayMs: number, sourceDelayMs: number): EnvelopeAlignment {
	const { scale } = aligned.map;
	const shift = targetDelayMs - sourceDelayMs * scale;
	return {
		...aligned,
		map: {
			scale,
			pieces: aligned.map.pieces.map((p, i) => ({ fromMs: i === 0 ? 0 : p.fromMs + sourceDelayMs, offsetMs: Math.round(p.offsetMs + shift) })),
		},
		removed: aligned.removed.map((r) => ({ startMs: r.startMs + sourceDelayMs, endMs: r.endMs + sourceDelayMs })),
	};
}

function fps(probe: ProbeResult): number {
	return probe.videoDisplayFps || probe.videoStreamFps || 0;
}

/**
 * Lines up another release of the same episode or movie with the target by
 * their audio. The map turns times in the source file, such as its subtitle
 * timestamps, into times in the target file.
 */
export async function alignReleaseFiles(targetPath: string, sourcePath: string, options: ReleaseAlignOptions): Promise<ReleaseAlignment> {
	const [targetProbe, sourceProbe] = await Promise.all([options.targetProbe ?? probeFile(targetPath), options.sourceProbe ?? probeFile(sourcePath)]);
	const targetAudio = pickAlignmentAudio(targetProbe.audioStreams);
	if (!targetAudio) throw new Error(`${targetProbe.filename} has no audio to align with`);
	const sourceAudio = pickAlignmentAudio(sourceProbe.audioStreams, targetAudio.language);
	if (!sourceAudio) throw new Error(`${sourceProbe.filename} has no audio to align with`);

	const targetFps = fps(targetProbe);
	const sourceFps = fps(sourceProbe);
	const ratio = targetFps && sourceFps ? sourceFps / targetFps : 1;
	const scales = Math.abs(ratio - 1) > 0.001 ? [ratio] : [];

	const targetEnv = await cachedAudioEnvelope(targetPath, targetAudio.index, options.cacheDir, options.signal);
	const sourceEnv = await cachedAudioEnvelope(sourcePath, sourceAudio.index, options.cacheDir, options.signal);
	const aligned = alignEnvelopes(targetEnv, sourceEnv, { scales });

	return { ...toFileTimes(aligned, targetAudio.delayMs, sourceAudio.delayMs), targetAudio, sourceAudio };
}
