/**
 * Detects sources that are constant frame rate except for a few dropped
 * frames, and plans how to fill those gaps with duplicates so the encode can be
 * muxed as plain CFR. Anything that is not exactly that case (true VFR, mixed
 * rates, many gaps) yields no plan and keeps its source timecodes.
 */

export interface CfrGap {
	/** Index of the first source frame after the gap. */
	beforeFrame: number;
	/** Number of frames missing in the gap. */
	missing: number;
}

export interface CfrPlan {
	fpsNum: number;
	fpsDen: number;
	sourceFrames: number;
	/** Frame count after filling: sourceFrames plus every missing frame. */
	totalFrames: number;
	/** Frames missing before the first source frame. */
	leading: number;
	gaps: CfrGap[];
	/** Frames missing after the last source frame. */
	trailing: number;
}

const STANDARD_RATES: Array<[number, number]> = [
	[24000, 1001],
	[24, 1],
	[25, 1],
	[30000, 1001],
	[30, 1],
	[48, 1],
	[50, 1],
	[60000, 1001],
	[60, 1],
	[120000, 1001],
	[120, 1],
];

/** Container timestamps are usually rounded to whole milliseconds. */
const GRID_TOLERANCE_MS = 2;
const MAX_MISSING_RATIO = 0.01;
/** Each gap becomes one term of an ffmpeg expression, so keep the count bounded. */
const MAX_GAPS = 200;
const MIN_FRAMES = 48;

function parseRate(rate: string | undefined): [number, number] | null {
	const m = rate?.match(/^(\d+)(?:\/(\d+))?$/);
	if (!m) return null;
	const num = Number(m[1]);
	const den = Number(m[2] ?? 1);
	return num > 0 && den > 0 ? [num, den] : null;
}

function fitGrid(frameTimes: number[], endTime: number | null, fpsNum: number, fpsDen: number): Omit<CfrPlan, "fpsNum" | "fpsDen"> | null {
	const frameMs = (1000 * fpsDen) / fpsNum;

	const leading = Math.round(frameTimes[0]! / frameMs);
	const origin = frameTimes[0]! - leading * frameMs;
	if (Math.abs(origin) > GRID_TOLERANCE_MS) return null;

	const gaps: CfrGap[] = [];
	let prevSlot = leading;

	for (let i = 1; i < frameTimes.length; i++) {
		const offset = frameTimes[i]! - origin;
		const slot = Math.round(offset / frameMs);
		if (Math.abs(offset - slot * frameMs) > GRID_TOLERANCE_MS) return null;
		if (slot <= prevSlot) return null;
		if (slot - prevSlot > 1) gaps.push({ beforeFrame: i, missing: slot - prevSlot - 1 });
		prevSlot = slot;
	}

	let trailing = 0;
	if (endTime !== null) {
		const endSlot = Math.round((endTime - origin) / frameMs);
		trailing = Math.max(0, endSlot - prevSlot - 1);
	}

	return { sourceFrames: frameTimes.length, totalFrames: prevSlot + 1 + trailing, leading, gaps, trailing };
}

/**
 * @param timecodesMs    Presentation timestamps in milliseconds, as written by
 *                       `mkvextract timestamps_v2` (which may append the end
 *                       time of the last frame as one extra entry).
 * @param frameCount     Actual number of video frames in the source.
 * @param frameRateHint  The container's nominal rate ("24000/1001"), tried first.
 */
export function planCfrNormalization(timecodesMs: number[], frameCount: number, frameRateHint?: string): CfrPlan | null {
	if (frameCount < MIN_FRAMES) return null;
	if (timecodesMs.some((t) => !Number.isFinite(t))) return null;

	let endTime: number | null = null;
	let frameTimes = timecodesMs;
	if (timecodesMs.length === frameCount + 1) {
		endTime = timecodesMs[frameCount]!;
		frameTimes = timecodesMs.slice(0, frameCount);
	} else if (timecodesMs.length !== frameCount) {
		return null;
	}

	const deltas = [];
	for (let i = 1; i < frameTimes.length; i++) deltas.push(frameTimes[i]! - frameTimes[i - 1]!);
	const medianDelta = deltas.toSorted((a, b) => a - b)[Math.floor(deltas.length / 2)]!;

	const hint = parseRate(frameRateHint);
	const candidates = hint ? [hint, ...STANDARD_RATES] : STANDARD_RATES;

	for (const [fpsNum, fpsDen] of candidates) {
		// The grid must be the source's own frame interval, not a finer multiple of it.
		if (Math.abs((1000 * fpsDen) / fpsNum - medianDelta) > GRID_TOLERANCE_MS) continue;

		const fit = fitGrid(frameTimes, endTime, fpsNum, fpsDen);
		if (!fit) continue;

		const missing = fit.totalFrames - fit.sourceFrames;
		if (missing === 0) return null;
		if (missing > fit.sourceFrames * MAX_MISSING_RATIO) return null;
		if (fit.gaps.length > MAX_GAPS) return null;

		return { fpsNum, fpsDen, ...fit };
	}

	return null;
}

/** ffmpeg rejects a flat sum of roughly 100 terms or more, so nest it as a balanced tree. */
function sumBalanced(terms: string[]): string {
	if (terms.length <= 8) return terms.join("+");
	const mid = Math.ceil(terms.length / 2);
	return `(${sumBalanced(terms.slice(0, mid))})+(${sumBalanced(terms.slice(mid))})`;
}

/**
 * ffmpeg filter chain that fills the planned gaps. Frames are placed on the
 * grid by index rather than by their container timestamps, so the result does
 * not depend on how the intermediate file was timestamped.
 */
export function buildCfrFilter(plan: CfrPlan): string {
	const terms = plan.gaps.map((g) => `${g.missing}*gte(N\\,${g.beforeFrame})`);
	const slotExpr = terms.length > 0 ? `N+${sumBalanced(terms)}` : "N";
	const filters = [`settb=${plan.fpsDen}/${plan.fpsNum}`, `setpts=${slotExpr}`, `fps=${plan.fpsNum}/${plan.fpsDen}`];

	if (plan.leading > 0 || plan.trailing > 0) {
		const pad = [];
		if (plan.leading > 0) pad.push(`start_mode=clone:start=${plan.leading}`);
		if (plan.trailing > 0) pad.push(`stop_mode=clone:stop=${plan.trailing}`);
		filters.push(`tpad=${pad.join(":")}`);
	}

	return filters.join(",");
}
