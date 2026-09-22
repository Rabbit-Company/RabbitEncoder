import type { SubtitleStreamInfo } from "../core/types";
import { Logger } from "../core/logger";
import { buildSubtitleTrackName, computeSubtitleDefaultIndexByLang, detectSubtitleTrackType, normalizeLanguageGroup, type SubtitleTrackType } from "./tracks";

/** A subtitle track with the name, language and flags the workflow gives it. */
export interface PlannedSubtitleTrack {
	stream: SubtitleStreamInfo;
	trackType: SubtitleTrackType;
	/** Honorifics tracks are relabelled `en-JP`; everything else keeps its language. */
	effectiveLang: string;
	trackName: string;
	isDefault: boolean;
	isForced: boolean;
	isHearingImpaired: boolean;
	isCommentary: boolean;
	isOriginal: boolean;
	/**
	 * False for types the workflow has no flag policy for (storyboard). Those
	 * tracks keep whatever flags the source set, so the mux leaves them alone.
	 */
	applyFlags: boolean;
}

/**
 * Name and flag an ordered set of subtitle streams the way the encode does:
 * one default per language group, one forced track per language group, SDH and
 * commentary flagged by type, honorifics relabelled and always default.
 *
 * `streams` must already be filtered, sorted and deduplicated (see
 * `analyzeSourceTracks`) — this step only decides names and flags, so both the
 * encode pipeline and a repair that re-imports source subtitles produce the
 * same result.
 */
export function planSubtitleTracks(streams: SubtitleStreamInfo[], options: { renameTracks: boolean }): PlannedSubtitleTrack[] {
	const planned: PlannedSubtitleTrack[] = [];
	const forcedAssigned = new Set<string>();
	const defaultIndexByLang = computeSubtitleDefaultIndexByLang(streams);

	for (const stream of streams) {
		const trackType = detectSubtitleTrackType(stream);
		const lang = stream.language || "und";
		const langGroup = normalizeLanguageGroup(lang);
		const trackName = options.renameTracks ? buildSubtitleTrackName(trackType, stream.title) : stream.title || buildSubtitleTrackName(trackType, stream.title);
		const isDefaultForLang = defaultIndexByLang.get(langGroup) === stream.index;
		const isOriginal = !!stream.isOriginal;

		if (trackType === "forced") {
			if (forcedAssigned.has(langGroup)) {
				Logger.warn(`[subtitle] Duplicate forced track for ${lang}, skipping index ${stream.index}`);
				continue;
			}
			forcedAssigned.add(langGroup);
		}

		const base = { stream, trackType, effectiveLang: lang, trackName, isOriginal, applyFlags: true };
		switch (trackType) {
			case "forced":
				planned.push({ ...base, isDefault: false, isForced: true, isHearingImpaired: false, isCommentary: false });
				break;
			case "honorifics":
				planned.push({ ...base, effectiveLang: "en-JP", isDefault: true, isForced: false, isHearingImpaired: false, isCommentary: false });
				break;
			case "sdh":
				planned.push({ ...base, isDefault: isDefaultForLang, isForced: false, isHearingImpaired: true, isCommentary: false });
				break;
			case "commentary":
				planned.push({ ...base, isDefault: false, isForced: false, isHearingImpaired: false, isCommentary: true });
				break;
			case "full":
				planned.push({ ...base, isDefault: isDefaultForLang, isForced: false, isHearingImpaired: false, isCommentary: false });
				break;
			default:
				planned.push({
					...base,
					applyFlags: false,
					isDefault: !!stream.isDefault,
					isForced: !!stream.isForced,
					isHearingImpaired: !!stream.isHearingImpaired,
					isCommentary: false,
				});
				break;
		}
	}
	return planned;
}

/** mkvmerge flag args for a planned track, applied to the track at `id`. */
export function subtitleFlagArgs(track: PlannedSubtitleTrack, id = 0): string[] {
	if (!track.applyFlags) return [];
	return [
		"--default-track-flag",
		`${id}:${track.isDefault ? "1" : "0"}`,
		"--forced-display-flag",
		`${id}:${track.isForced ? "1" : "0"}`,
		"--hearing-impaired-flag",
		`${id}:${track.isHearingImpaired ? "1" : "0"}`,
		"--commentary-flag",
		`${id}:${track.isCommentary ? "1" : "0"}`,
		"--original-flag",
		`${id}:${track.isOriginal ? "1" : "0"}`,
	];
}
