import type { JobSettings, ProbeResult, SourceTrackPlan } from "../core/types";
import {
	analyzeSubtitleStreams,
	sortSubtitleStreams,
	filterStreamsByLanguage,
	filterSubtitleTypes,
	deduplicateSubtitleStreams,
	filterIgnoredTracks,
	DEFAULT_IGNORE_KEYWORD,
} from "../tracks/tracks";
import { Logger } from "../core/logger";
import { selectAudioStreams } from "../audio/audio-step";

export async function analyzeSourceTracks(
	probe: ProbeResult,
	settings: JobSettings,
	inputPath: string,
	tempDir: string,
	signal: AbortSignal,
): Promise<SourceTrackPlan> {
	// Audio
	const audioStreams = selectAudioStreams(probe.audioStreams || [], settings);

	// Subtitles
	const allSubtitleStreams = filterIgnoredTracks(probe.subtitleStreams || [], DEFAULT_IGNORE_KEYWORD, "subtitle");

	await analyzeSubtitleStreams(
		allSubtitleStreams,
		inputPath,
		tempDir,
		{
			langDetect: settings.subtitleLangDetect,
			langDetectConfidence: settings.subtitleLangDetectConfidence,
			detectSignsSongs: settings.detectSignsSongs,
			detectSDH: settings.detectSDH,
			detectHonorifics: settings.detectHonorifics,
			signsSongsStyleRatio: settings.signsSongsStyleRatio,
			signsSongsLineRatio: settings.signsSongsLineRatio,
			sdhRatioThreshold: settings.sdhRatioThreshold,
			sdhMinLines: settings.sdhMinLines,
			honorificsMinCount: settings.honorificsMinCount,
			honorificsRatio: settings.honorificsRatio,
			assumeMislabeled: settings.assumeMislabeledTracks,
		},
		signal,
	);

	const sortedSubtitleStreams = sortSubtitleStreams(allSubtitleStreams, {
		sourcePriority: settings.subtitleSourcePriority,
		fansubTiebreak: settings.subtitleFansubTiebreak,
		formatPriority: settings.subtitleFormatPriority,
		languagePriority: settings.subtitleLanguagePriority,
	});

	const allowedSubLangs = settings.subtitleLanguages || [];
	const langFilteredSubs = filterStreamsByLanguage(sortedSubtitleStreams, allowedSubLangs, "subtitle");
	const skippedSubLang = sortedSubtitleStreams.length - langFilteredSubs.length;
	if (skippedSubLang > 0) Logger.info(`[subtitle] Filtered ${skippedSubLang} track(s) not in [${allowedSubLangs.join(", ")}]`);

	const typeFilteredSubs = filterSubtitleTypes(langFilteredSubs, {
		removeSDH: settings.removeSDHSubtitles,
		removeCommentary: settings.removeCommentarySubtitles,
		removeForcedSignsSongs: settings.removeForcedSignsSongs,
		removeStoryboard: settings.removeStoryboardSubtitles,
		removeHonorifics: settings.removeHonorificsSubtitles,
		dropPicture: settings.dropPictureSubtitles,
	});
	const droppedByTypeSubs = langFilteredSubs.length - typeFilteredSubs.length;
	if (droppedByTypeSubs > 0) Logger.info(`[subtitle] Dropped ${droppedByTypeSubs} track(s) by type/format filters`);

	const subtitleStreams = settings.dedupeSubtitles
		? deduplicateSubtitleStreams(typeFilteredSubs, { acrossFormat: settings.dedupeAcrossFormat })
		: typeFilteredSubs;

	if (settings.dedupeSubtitles && typeFilteredSubs.length !== subtitleStreams.length) {
		Logger.info(`[subtitle] Deduplicated ${typeFilteredSubs.length - subtitleStreams.length} redundant track(s)`);
	}

	return { subtitleStreams, audioStreams };
}
