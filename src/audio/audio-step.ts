import { Logger } from "../core/logger";
import type { AudioPreviewResult, AudioPreviewTrack, AudioStreamInfo, AudioTrackType, JobSettings } from "../core/types";
import { getOpusBitrateForLayout, normalizeLayout } from "../pipeline/probe";
import {
	DEFAULT_IGNORE_KEYWORD,
	buildAudioTrackName,
	deduplicateAudioStreams,
	detectAudioTrackType,
	filterAudioTypes,
	filterIgnoredTracks,
	filterStreamsByLanguage,
	languageToFlag,
	normalizeLanguageGroup,
	sortAudioStreams,
	type AudioDetectOptions,
} from "../tracks/tracks";

/**
 * The audio handling of an encode, in one place, so encodes and the audio
 * tools choose, order, name and encode tracks the same way.
 */

export type AudioSettings = Pick<
	JobSettings,
	| "audioLanguages"
	| "audioLanguagePriority"
	| "removeCommentaryAudio"
	| "removeDescriptiveAudio"
	| "removeKaraokeAudio"
	| "dropCompatibilityAudio"
	| "preferUncensoredAudio"
	| "dedupeAudio"
	| "keepBestAudioChannelsOnly"
	| "audioCodecPriority"
	| "detectCommentaryAudio"
	| "detectDescriptiveAudio"
	| "detectKaraokeAudio"
	| "audioBitrates"
	| "noPhaseInv"
>;

export function audioDetectOptions(settings: AudioSettings): AudioDetectOptions {
	return { commentary: settings.detectCommentaryAudio, descriptive: settings.detectDescriptiveAudio, karaoke: settings.detectKaraokeAudio };
}

/** Why an encode leaves a track out. */
export type AudioDropReason = "ignored" | "language" | "type" | "duplicate";

/**
 * The tracks an encode keeps, in the order it writes them: language and type
 * filters, then sorting, then dedupe. `dropped`, when given, is filled with
 * why each other track was left out, by stream index.
 */
export function selectAudioStreams(streams: AudioStreamInfo[], settings: AudioSettings, dropped?: Map<number, AudioDropReason>): AudioStreamInfo[] {
	const detect = audioDetectOptions(settings);
	const all = filterIgnoredTracks(streams, DEFAULT_IGNORE_KEYWORD, "audio");
	const allowed = settings.audioLanguages || [];
	const langFiltered = filterStreamsByLanguage(all, allowed, "audio");
	const skippedLang = all.length - langFiltered.length;
	if (skippedLang > 0) Logger.info(`[audio] Filtered ${skippedLang} track(s) not in [${allowed.join(", ")}]`);

	const typeFiltered = filterAudioTypes(
		langFiltered,
		{
			removeCommentary: settings.removeCommentaryAudio,
			removeDescriptive: settings.removeDescriptiveAudio,
			removeKaraoke: settings.removeKaraokeAudio,
			dropCompatibility: settings.dropCompatibilityAudio,
		},
		detect,
	);
	const droppedByType = langFiltered.length - typeFiltered.length;
	if (droppedByType > 0) Logger.info(`[audio] Dropped ${droppedByType} track(s) by type/compatibility filters`);

	const sorted = sortAudioStreams(typeFiltered, { languagePriority: settings.audioLanguagePriority, preferUncensored: settings.preferUncensoredAudio, detect });
	const kept = settings.dedupeAudio
		? deduplicateAudioStreams(sorted, {
				collapseChannels: settings.keepBestAudioChannelsOnly,
				codecPriority: settings.audioCodecPriority,
				preferUncensored: settings.preferUncensoredAudio,
				detect,
			})
		: sorted;
	if (settings.dedupeAudio && sorted.length !== kept.length) Logger.info(`[audio] Deduplicated ${sorted.length - kept.length} redundant track(s)`);
	if (dropped) {
		const stages: Array<[AudioStreamInfo[], AudioDropReason]> = [
			[all, "ignored"],
			[langFiltered, "language"],
			[typeFiltered, "type"],
			[kept, "duplicate"],
		];
		for (const s of streams) {
			const stage = stages.find(([list]) => !list.includes(s));
			if (stage) dropped.set(s.index, stage[1]);
		}
	}
	return kept;
}

/** Orders tracks the way an encode does, without filtering or dedupe. */
export function sortAudioLikeEncode<T extends AudioStreamInfo>(streams: T[], settings: AudioSettings): T[] {
	return sortAudioStreams(streams, {
		languagePriority: settings.audioLanguagePriority,
		preferUncensored: settings.preferUncensoredAudio,
		detect: audioDetectOptions(settings),
	}) as T[];
}

export function opusBitrateFor(stream: Pick<AudioStreamInfo, "channelLayout" | "channels">, settings: Pick<AudioSettings, "audioBitrates">): number {
	return getOpusBitrateForLayout(normalizeLayout(stream.channelLayout, stream.channels), settings.audioBitrates);
}

/** An Opus track at or under the bitrate it would be encoded at is copied, as encoding it again only loses quality. */
export function canKeepOpus(stream: Pick<AudioStreamInfo, "codec" | "bitrate">, bitrateKbps: number): boolean {
	const kbps = stream.bitrate ? stream.bitrate / 1000 : undefined;
	return /^opus$/i.test(stream.codec || "") && kbps !== undefined && kbps <= bitrateKbps;
}

export function opusencArgs(input: string, output: string, bitrateKbps: number, settings: Pick<AudioSettings, "noPhaseInv">): string[] {
	return [
		"opusenc",
		"--bitrate",
		String(bitrateKbps),
		...(settings.noPhaseInv ? ["--no-phase-inv"] : []),
		"--discard-comments",
		"--discard-pictures",
		input,
		output,
	];
}

/** The name an encode gives a track: none for main audio, the kind and its source or group for the rest. */
export function audioTrackName(trackType: AudioTrackType, sourceTitle?: string): string {
	return buildAudioTrackName(trackType, sourceTitle);
}

/** Which tracks are default, as an encode decides: the first main track of each language. */
export function audioDefaults(tracks: Array<{ language?: string; trackType: AudioTrackType }>): boolean[] {
	const assigned = new Set<string>();
	return tracks.map((track) => {
		const group = normalizeLanguageGroup(track.language || "und");
		const isDefault = track.trackType === "main" && !assigned.has(group);
		if (isDefault) assigned.add(group);
		return isDefault;
	});
}

export function detectAudioType(stream: AudioStreamInfo, settings: AudioSettings): AudioTrackType {
	return detectAudioTrackType(stream, audioDetectOptions(settings));
}

/** What an encode would do with a file's audio: the tracks it has, and the tracks it would write. */
export function previewAudio(streams: AudioStreamInfo[], settings: AudioSettings): AudioPreviewResult {
	const detect = audioDetectOptions(settings);
	const source: AudioPreviewTrack[] = streams.map((s) => ({
		index: s.index,
		codec: s.codec || "unknown",
		language: s.language || "und",
		flag: languageToFlag(s.language),
		title: s.title || "",
		trackType: detectAudioTrackType(s, detect),
		channels: s.channels,
		channelLayout: normalizeLayout(s.channelLayout, s.channels),
		bitrate: s.bitrate,
		isDefault: false,
		isOriginal: s.isOriginal || false,
	}));
	const kept = selectAudioStreams(streams, settings);
	const types = kept.map((s) => detectAudioTrackType(s, detect));
	const defaults = audioDefaults(kept.map((s, i) => ({ language: s.language, trackType: types[i]! })));
	const output: AudioPreviewTrack[] = kept.map((s, i) => {
		const layout = normalizeLayout(s.channelLayout, s.channels);
		const language = s.language || "und";
		return {
			index: s.index,
			codec: "opus",
			language,
			flag: languageToFlag(language),
			title: audioTrackName(types[i]!, s.title),
			trackType: types[i]!,
			channels: s.channels,
			channelLayout: layout,
			bitrate: s.bitrate,
			outputBitrate: opusBitrateFor(s, settings),
			isDefault: defaults[i]!,
			isOriginal: s.isOriginal || false,
		};
	});
	return { source, output };
}
