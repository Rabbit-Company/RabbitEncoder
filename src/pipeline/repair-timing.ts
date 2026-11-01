import type { ProbeResult } from "../core/types";
import { dialogueCues, retimeDocument, type Interval, type SubFormat, type TimeMap } from "../subsearch/cues";
import { measureSync, type ReferenceKind } from "../subsearch/score";
import { RELEASE_MATCH_MIN, type EnvelopeAlignment } from "../sync/release-align";

/** Below this share of the encode matching the source, the source is another cut or another video. */
export const MIN_COVERED_SHARE = 0.6;
/** Fewer dialogue lines than this, such as a signs track, are too few to judge timing by. */
const MIN_CHECK_CUES = 20;
/** A retimed track that fits the encode worse than this is left out. */
export const MIN_RETIMED_FIT = 0.5;

/** How another release's subtitles move to fit the encode. */
export interface SourceTiming {
	map: TimeMap;
	removed: Interval[];
	/** The encode's video length, which no retimed line runs past. */
	endMs: number;
}

/** Null when the source's audio matches the encode well enough to retime by, else why not. */
export function alignmentProblem(alignment: Pick<EnvelopeAlignment, "confidence" | "coveredShare">): string | null {
	if (alignment.confidence >= RELEASE_MATCH_MIN && alignment.coveredShare >= MIN_COVERED_SHARE) return null;
	return `The source's audio does not match the encode (${Math.round(alignment.coveredShare * 100)}% matched, correlation ${alignment.confidence.toFixed(2)}), so it is probably another episode or cut`;
}

/** The source already lines up with the encode, so its tracks need no change. */
export function isIdentityTiming(map: TimeMap, removed: Interval[]): boolean {
	return map.scale === 1 && map.pieces.length === 1 && Math.abs(map.pieces[0]!.offsetMs) < 10 && removed.length === 0;
}

/**
 * Releases differ by whole frames, while the audio finds an offset to 10 ms.
 * Rounding every offset to whole frames of the encode keeps each line on the
 * same frame it was timed to, where moving lines one by one to a frame could
 * show a frame-exact sign a frame early.
 */
export function snapOffsetsToFrames(map: TimeMap, frameRate: number): TimeMap {
	const frameMs = 1000 / frameRate;
	return { ...map, pieces: map.pieces.map((p) => ({ ...p, offsetMs: Math.round(Math.round(p.offsetMs / frameMs) * frameMs) || 0 })) };
}

export function sourceTimingFor(
	alignment: Pick<EnvelopeAlignment, "map" | "removed">,
	endMs: number,
	probe: Pick<ProbeResult, "videoStreamFps" | "isFrameRateMismatch">,
): SourceTiming | null {
	const constantRate = !probe.isFrameRateMismatch && probe.videoStreamFps > 0;
	const map = constantRate ? snapOffsetsToFrames(alignment.map, probe.videoStreamFps) : alignment.map;
	if (isIdentityTiming(map, alignment.removed)) return null;
	return { map, removed: alignment.removed, endMs };
}

/**
 * mkvmerge's --sync for tracks copied unchanged, such as PGS. It scales and
 * then delays, the same as the map, but cannot cut, so a map with several
 * pieces has none.
 */
export function mkvmergeSync(map: TimeMap): { delayMs: number; scale: number } | null {
	if (map.pieces.length !== 1) return null;
	return { delayMs: map.pieces[0]!.offsetMs, scale: map.scale };
}

export function retimeSubtitleText(text: string, format: SubFormat, timing: SourceTiming): string {
	return retimeDocument({ format, content: text.replace(/^\uFEFF/, "") }, timing.map, timing.endMs, { acrossCuts: true, removed: timing.removed }).content;
}

type TimingReference = { intervals: Interval[]; kind: ReferenceKind };

/**
 * How well a track's dialogue fits the encode before and after retiming, 0
 * to 1, or null when it has too few lines to tell or the encode has nothing
 * to compare with. The reference is only asked for when the track can be judged.
 */
export async function retimingFits(
	original: string,
	retimed: string,
	format: SubFormat,
	reference: () => Promise<TimingReference | null>,
	durationMs: number,
): Promise<{ before: number; after: number } | null> {
	const after = dialogueCues({ format, content: retimed });
	if (after.length < MIN_CHECK_CUES) return null;
	const ref = await reference();
	if (!ref) return null;
	const fit = (cues: Interval[]) => {
		const quality = measureSync(cues, ref.intervals, durationMs, ref.kind);
		return quality.sync * (1 - quality.missingShare);
	};
	return { before: fit(dialogueCues({ format, content: original.replace(/^\uFEFF/, "") })), after: fit(after) };
}

/**
 * The audio of both releases already vouches for the timing, and speech found
 * in audio can be off, so a retimed track is only left out when it fits
 * badly and retiming made it worse.
 */
export function retimingFailed(fits: { before: number; after: number } | null): boolean {
	return !!fits && fits.after < MIN_RETIMED_FIT && fits.after < fits.before;
}

export function describeTiming(map: TimeMap, removed: Interval[]): string {
	const offset = map.pieces[0]!.offsetMs;
	const parts = [`${offset >= 0 ? "+" : ""}${(offset / 1000).toFixed(2)} s`];
	if (map.scale !== 1) parts.push(`speed ×${map.scale.toFixed(4)}`);
	if (map.pieces.length > 1) parts.push(`${map.pieces.length} parts`);
	const cutMs = removed.reduce((sum, r) => sum + r.endMs - r.startMs, 0);
	if (cutMs > 0) parts.push(`${(cutMs / 1000).toFixed(1)} s of the source left out`);
	return parts.join(", ");
}
