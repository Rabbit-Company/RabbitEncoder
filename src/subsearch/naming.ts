import { buildSubtitleTrackName, extractGroupFromTitle, extractSourceTag, type SubtitleTrackType } from "../tracks/tracks";
import { resolveTranslateLang } from "../translate/translate-languages";

/** Endings of a release name that are not a group: languages, formats and the halves of tags such as WEB-DL. */
const NOT_GROUP = /^(?:dl|rip|web|hd|sd|uhd|hdr|sdr|dv|x264|x265|h264|h265|hevc|avc|aac|ac3|eac3|ddp|dts|flac|opus|srt|ass|sub|subs|forced|hi|sdh|cc)$/i;
const LANGUAGE_SUFFIX = /(?:[._ ](?:[a-z]{2,3}|[a-z]{2}-[a-z]{2}|forced|sdh|hi|cc|srt|ass|vtt|sub))+$/i;
/** Uploaders that name nobody. */
const NO_UPLOADER = /^(?:os-auto|anonymous|)$/i;

/** The group of a scene release name, from its trailing "-Group". */
export function sceneGroup(release: string): string | null {
	const stem = release.trim().replace(LANGUAGE_SUFFIX, "");
	const m = stem.match(/-([A-Za-z0-9]{2,24})$/);
	return m && !NOT_GROUP.test(m[1]!) ? m[1]! : null;
}

/**
 * What a downloaded subtitle's track name credits, the way native tracks
 * credit their source or group: the streaming source in the release name,
 * its fansub or scene group, the uploader, or OpenSubtitles when nothing names
 * anyone.
 */
export function downloadedSubtitleCredit(release: string, uploader: string): string {
	const source = extractSourceTag(release);
	if (source) return source;
	// The bracket parser falls back to the whole name, which is no group.
	const bracketed = extractGroupFromTitle(release);
	if (bracketed && (release.includes(`[${bracketed}]`) || release.includes(`(${bracketed})`))) return bracketed;
	const scene = sceneGroup(release);
	if (scene) return scene;
	if (!NO_UPLOADER.test(uploader.trim())) return uploader.trim();
	return "OpenSubtitles";
}

/**
 * Language tag of a downloaded track, the way native tracks are tagged.
 * "chi" becomes "zh-Hans", the Simplified Chinese it was searched as, instead
 * of a bare "zh" that says nothing about the script.
 */
export function downloadedLanguageTag(language: string): string {
	return resolveTranslateLang(language)?.code ?? language;
}

/** The release name, or the file name without its extension when there is none. */
function releaseName(release: string, fileName: string): string {
	return release.trim() || fileName.replace(/\.[a-z0-9]{2,4}$/i, "");
}

/** The credit of a candidate, as its track name would show it. */
export function candidateCredit(release: string, uploader: string, fileName = ""): string {
	return downloadedSubtitleCredit(releaseName(release, fileName), uploader);
}

/**
 * Track name of a downloaded subtitle, with its credit and, from the release
 * name, whether it is a dubtitle. Without a release name the file name is used.
 * A credit entered by hand replaces the one read from the names.
 */
export function downloadedTrackName(type: SubtitleTrackType, release: string, uploader: string, fileName = "", credit?: string): string {
	const name = releaseName(release, fileName);
	return buildSubtitleTrackName(type, name, credit?.trim() || downloadedSubtitleCredit(name, uploader));
}
