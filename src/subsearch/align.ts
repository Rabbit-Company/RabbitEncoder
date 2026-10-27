import { mapCue, mergeIntervals, type Interval, type TimeMap } from "./cues";

/**
 * Frame rate changes between releases. A PAL release plays 23.976 fps film
 * at 25 fps, so its subtitles run 4% faster than a BluRay's.
 */
export const FRAME_RATE_SCALES = [1, 24 / 23.976, 23.976 / 24, 25 / 23.976, 23.976 / 25, 25 / 24, 24 / 25];

/** A frame rate change must beat no change by this much, so noise never picks one. */
const SCALE_MARGIN = 1.03;
const COARSE_STEP_MS = 40;
const FINE_STEP_MS = 10;

export interface AlignOptions {
	/** Largest global shift searched in either direction. */
	maxOffsetMs?: number;
	scales?: number[];
	/** Largest extra shift a part of the file may get on top of the global one. */
	maxPieceShiftMs?: number;
}

export interface AlignResult {
	map: TimeMap;
	/** Milliseconds of candidate dialogue that land on reference speech after the map. */
	overlapMs: number;
	/** Overlap with no change at all, to tell how far the subtitle was off. */
	unshiftedOverlapMs: number;
}

/** Shared time of two sorted, merged interval lists, with `a` shifted by `shift`. */
export function overlapMs(a: Interval[], b: Interval[], shift = 0): number {
	if (!a.length || !b.length) return 0;
	let j = firstEndingAfter(b, a[0]!.startMs + shift);
	let i = 0;
	let sum = 0;
	while (i < a.length && j < b.length) {
		const as = a[i]!.startMs + shift;
		const ae = a[i]!.endMs + shift;
		const bs = b[j]!.startMs;
		const be = b[j]!.endMs;
		const lo = as > bs ? as : bs;
		const hi = ae < be ? ae : be;
		if (hi > lo) sum += hi - lo;
		if (ae < be) i++;
		else j++;
	}
	return sum;
}

function firstEndingAfter(list: Interval[], ms: number): number {
	let lo = 0;
	let hi = list.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (list[mid]!.endMs <= ms) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

function scaled(intervals: Interval[], scale: number): Interval[] {
	return scale === 1 ? intervals : intervals.map((i) => ({ startMs: i.startMs * scale, endMs: i.endMs * scale }));
}

// FFT cross-correlation

function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
	const n = re.length;
	for (let i = 1, j = 0; i < n; i++) {
		let bit = n >> 1;
		for (; j & bit; bit >>= 1) j ^= bit;
		j ^= bit;
		if (i < j) {
			let t = re[i]!;
			re[i] = re[j]!;
			re[j] = t;
			t = im[i]!;
			im[i] = im[j]!;
			im[j] = t;
		}
	}
	for (let len = 2; len <= n; len <<= 1) {
		const angle = ((inverse ? 2 : -2) * Math.PI) / len;
		const wr = Math.cos(angle);
		const wi = Math.sin(angle);
		const half = len >> 1;
		for (let start = 0; start < n; start += len) {
			let cr = 1;
			let ci = 0;
			for (let k = 0; k < half; k++) {
				const a = start + k;
				const b = a + half;
				const tr = re[b]! * cr - im[b]! * ci;
				const ti = re[b]! * ci + im[b]! * cr;
				re[b] = re[a]! - tr;
				im[b] = im[a]! - ti;
				re[a] = re[a]! + tr;
				im[a] = im[a]! + ti;
				const next = cr * wr - ci * wi;
				ci = cr * wi + ci * wr;
				cr = next;
			}
		}
	}
	if (inverse) {
		for (let i = 0; i < n; i++) {
			re[i] = re[i]! / n;
			im[i] = im[i]! / n;
		}
	}
}

/** Covered share of every step-long slot, from `originMs` on. */
function rasterize(intervals: Interval[], size: number, originMs: number): Float64Array {
	const out = new Float64Array(size);
	for (const { startMs, endMs } of intervals) {
		const s = (startMs - originMs) / COARSE_STEP_MS;
		const e = (endMs - originMs) / COARSE_STEP_MS;
		for (let k = Math.max(0, Math.floor(s)); k < Math.min(size, Math.ceil(e)); k++) out[k] = out[k]! + Math.min(e, k + 1) - Math.max(s, k);
	}
	return out;
}

interface Spectrum {
	re: Float64Array;
	im: Float64Array;
}

function spectrum(signal: Float64Array): Spectrum {
	const re = Float64Array.from(signal);
	const im = new Float64Array(signal.length);
	fft(re, im, false);
	return { re, im };
}

/** Best whole-step shift of the candidate within ±maxSteps, by cross-correlation. */
function bestCoarseShift(ref: Spectrum, cand: Float64Array, maxSteps: number): { shift: number; score: number } {
	const c = spectrum(cand);
	const n = cand.length;
	const re = new Float64Array(n);
	const im = new Float64Array(n);
	for (let k = 0; k < n; k++) {
		// ref * conj(cand): lag k means the candidate moves k steps later.
		re[k] = ref.re[k]! * c.re[k]! + ref.im[k]! * c.im[k]!;
		im[k] = ref.im[k]! * c.re[k]! - ref.re[k]! * c.im[k]!;
	}
	fft(re, im, true);
	let shift = 0;
	let score = -Infinity;
	for (let lag = -maxSteps; lag <= maxSteps; lag++) {
		const v = re[(lag + n) % n]!;
		if (v > score) {
			score = v;
			shift = lag;
		}
	}
	return { shift, score };
}

function refineShift(cand: Interval[], ref: Interval[], around: number, radius: number): { shift: number; overlap: number } {
	let best = { shift: around, overlap: overlapMs(cand, ref, around) };
	for (let d = around - radius; d <= around + radius; d += FINE_STEP_MS) {
		const overlap = overlapMs(cand, ref, d);
		if (overlap > best.overlap) best = { shift: d, overlap };
	}
	return best;
}

// Parts of the file shifted on their own

const PIECE_STEP_MS = 100;
/**
 * A change of shift between two parts costs this much overlap. A real cut
 * gains overlap in every segment after it, while unrelated dialogue only
 * gains a little here and there, which this keeps from adding up.
 */
const PIECE_PENALTY_MS = 15_000;
/** Piecewise shifts must add at least this share of overlap to be used. */
const PIECE_MIN_GAIN = 0.05;
/** More parts than this means the dialogue does not belong to the video at all. */
const MAX_PIECES = 6;

interface Segment {
	firstCue: number;
	cues: Interval[];
}

/** Groups of consecutive cues, closed at a pause once they span 20 seconds or at 90 seconds. */
function segmentCues(cues: Interval[]): Segment[] {
	const out: Segment[] = [];
	let current: Segment | null = null;
	for (let i = 0; i < cues.length; i++) {
		const cue = cues[i]!;
		if (current) {
			const first = current.cues[0]!.startMs;
			const last = current.cues[current.cues.length - 1]!;
			const span = cue.startMs - first;
			if ((span >= 20_000 && cue.startMs - last.endMs >= 1200) || span >= 90_000) {
				out.push(current);
				current = null;
			}
		}
		if (!current) current = { firstCue: i, cues: [] };
		current.cues.push(cue);
	}
	if (current) out.push(current);
	return out.map((s) => ({ ...s, cues: mergeIntervals(s.cues) }));
}

/**
 * Viterbi over segments: every segment picks an extra shift, and changing it
 * from the previous segment costs a fixed penalty. That keeps one shift for
 * the whole file unless a cut, such as a removed scene, moves everything after it.
 */
function pieceShifts(segments: Segment[], ref: Interval[], maxShiftMs: number): number[] {
	const states: number[] = [];
	for (let d = -maxShiftMs; d <= maxShiftMs; d += PIECE_STEP_MS) states.push(d);
	const zero = states.indexOf(0);
	const back: Int32Array[] = [];
	let prev = new Float64Array(states.length);
	segments.forEach((segment, si) => {
		const next = new Float64Array(states.length);
		const from = new Int32Array(states.length);
		let bestPrev = 0;
		if (si > 0) for (let s = 1; s < states.length; s++) if (prev[s]! > prev[bestPrev]!) bestPrev = s;
		for (let s = 0; s < states.length; s++) {
			const emission = overlapMs(segment.cues, ref, states[s]!) - Math.abs(states[s]!) * 1e-3;
			if (si === 0) {
				next[s] = emission - (s === zero ? 0 : PIECE_PENALTY_MS);
				from[s] = s;
				continue;
			}
			const stay = prev[s]!;
			const jump = prev[bestPrev]! - PIECE_PENALTY_MS;
			next[s] = emission + (stay >= jump ? stay : jump);
			from[s] = stay >= jump ? s : bestPrev;
		}
		back.push(from);
		prev = next;
	});
	let state = 0;
	for (let s = 1; s < states.length; s++) if (prev[s]! > prev[state]!) state = s;
	const out = new Array<number>(segments.length);
	for (let si = segments.length - 1; si >= 0; si--) {
		out[si] = states[state]!;
		state = back[si]![state]!;
	}
	return out;
}

/**
 * Finds the frame rate scale and shifts that line the candidate's dialogue up
 * with the reference timeline. Both are lists of speech or cue intervals.
 */
export function alignToReference(candidate: Interval[], reference: Interval[], opts: AlignOptions = {}): AlignResult {
	const cues = candidate.filter((c) => c.endMs > c.startMs).sort((a, b) => a.startMs - b.startMs);
	const ref = mergeIntervals(reference);
	const unshifted = overlapMs(mergeIntervals(cues), ref);
	if (!cues.length || !ref.length) return { map: { scale: 1, pieces: [{ fromMs: 0, offsetMs: 0 }] }, overlapMs: unshifted, unshiftedOverlapMs: unshifted };

	const maxOffsetMs = opts.maxOffsetMs ?? 600_000;
	const scales = opts.scales ?? FRAME_RATE_SCALES;
	const maxEnd = Math.max(ref[ref.length - 1]!.endMs, cues[cues.length - 1]!.endMs * Math.max(...scales));
	const span = Math.ceil((maxEnd + maxOffsetMs) / COARSE_STEP_MS) + 1;
	let size = 1;
	while (size < span * 2) size <<= 1;
	const refSpectrum = spectrum(rasterize(ref, size, 0));
	const maxSteps = Math.ceil(maxOffsetMs / COARSE_STEP_MS);

	let best = { scale: 1, shift: 0, overlap: -1 };
	for (const scale of scales) {
		const merged = mergeIntervals(scaled(cues, scale));
		const coarse = bestCoarseShift(refSpectrum, rasterize(merged, size, 0), maxSteps);
		const fine = refineShift(merged, ref, coarse.shift * COARSE_STEP_MS, COARSE_STEP_MS * 2);
		const weighted = scale === 1 ? fine.overlap * SCALE_MARGIN : fine.overlap;
		const bestWeighted = best.scale === 1 ? best.overlap * SCALE_MARGIN : best.overlap;
		if (weighted > bestWeighted) best = { scale, shift: fine.shift, overlap: fine.overlap };
	}

	const globalMap: TimeMap = { scale: best.scale, pieces: [{ fromMs: 0, offsetMs: best.shift }] };
	const placed = cues.map((c) => ({ startMs: c.startMs * best.scale + best.shift, endMs: c.endMs * best.scale + best.shift }));
	const segments = segmentCues(placed);
	if (segments.length < 2) return { map: globalMap, overlapMs: best.overlap, unshiftedOverlapMs: unshifted };

	const extra = pieceShifts(segments, ref, opts.maxPieceShiftMs ?? 30_000);
	const pieces: TimeMap["pieces"] = [];
	for (let si = 0; si < segments.length;) {
		let end = si;
		while (end + 1 < segments.length && extra[end + 1] === extra[si]) end++;
		const run = mergeIntervals(segments.slice(si, end + 1).flatMap((s) => s.cues));
		const fine = refineShift(run, ref, extra[si]!, PIECE_STEP_MS);
		pieces.push({ fromMs: si === 0 ? 0 : cues[segments[si]!.firstCue]!.startMs, offsetMs: best.shift + fine.shift });
		si = end + 1;
	}
	const pieceMap: TimeMap = { scale: best.scale, pieces };
	const total = pieces.length > 1 ? overlapMs(mergeIntervals(cues.map((c) => mapCue(c, pieceMap))), ref) : 0;
	if (pieces.length === 1 || pieces.length > MAX_PIECES || total < best.overlap * (1 + PIECE_MIN_GAIN)) {
		const single = refineShift(mergeIntervals(placed), ref, 0, PIECE_STEP_MS);
		return {
			map: { scale: best.scale, pieces: [{ fromMs: 0, offsetMs: best.shift + single.shift }] },
			overlapMs: single.overlap,
			unshiftedOverlapMs: unshifted,
		};
	}
	return { map: pieceMap, overlapMs: total, unshiftedOverlapMs: unshifted };
}
