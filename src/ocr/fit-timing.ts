import { Logger } from "../core/logger";
import type { ProbeResult } from "../core/types";
import { alignToReference } from "../subsearch/align";
import { dialogueCues, mapCue, type TimeMap } from "../subsearch/cues";
import { buildReference } from "../subsearch/reference";
import { measureSync } from "../subsearch/score";

/** Fewer cues than this, such as a forced track of a few signs, are too few to judge timing by. */
const MIN_CUES = 20;
/** Below this, the subtitles belong to another cut or another video. */
const MIN_FIT = 0.5;
/** Smaller differences are rounding, not a shift. */
const SHIFT_TOLERANCE_MS = 40;

export type TimingFit = { ok: true; map: TimeMap | null; note?: string } | { ok: false; error: string };

function describe(map: TimeMap): string {
	const offset = map.pieces[0]!.offsetMs;
	const parts = [`${offset >= 0 ? "+" : ""}${(offset / 1000).toFixed(2)} s`];
	if (map.scale !== 1) parts.push(`speed ×${map.scale.toFixed(4)}`);
	if (map.pieces.length > 1) parts.push(`${map.pieces.length} parts`);
	return parts.join(", ");
}

/**
 * Checks subtitles read from an original against the video they go into, by
 * its own subtitles or its audio. Returns the time map to apply when the
 * video was shifted, cut or sped up, null when it already fits, or an error
 * when the subtitles do not belong to it.
 */
export async function fitTimingToVideo(srt: string, videoPath: string, probe: ProbeResult, workDir: string, signal?: AbortSignal): Promise<TimingFit> {
	const cues = dialogueCues({ format: "srt", content: srt });
	if (cues.length < MIN_CUES) return { ok: true, map: null, note: "too few lines to check the timing" };
	const reference = await buildReference(videoPath, probe, workDir, signal);
	if (!reference) return { ok: true, map: null, note: "the timing could not be checked, the video has no subtitles or audio" };
	const aligned = alignToReference(cues, reference.intervals);
	const quality = measureSync(
		cues.map((c) => mapCue(c, aligned.map)),
		reference.intervals,
		(probe.duration || 0) * 1000,
		reference.kind,
	);
	const fit = quality.sync * (1 - quality.missingShare);
	Logger.info(`[ocr] Timing against ${reference.label}: fit ${fit.toFixed(2)}, agreement ${quality.agreement.toFixed(2)}, ${describe(aligned.map)}`);
	if (fit < MIN_FIT)
		return {
			ok: false,
			error: `the subtitles do not match the video's timing (fit ${Math.round(fit * 100)}%), so the original is probably a different cut or video`,
		};
	const { scale, pieces } = aligned.map;
	if (scale === 1 && pieces.length === 1 && Math.abs(pieces[0]!.offsetMs) <= SHIFT_TOLERANCE_MS) return { ok: true, map: null };
	return { ok: true, map: aligned.map, note: `shifted to fit the video (${describe(aligned.map)})` };
}
