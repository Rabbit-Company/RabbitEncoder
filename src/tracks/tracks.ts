import type {
	AudioChannelBitrates,
	AudioCodecPriority,
	AudioPreviewResult,
	AudioPreviewTrack,
	AudioStreamInfo,
	AudioTrackType,
	SubtitleFansubTiebreak,
	SubtitleFormatPriority,
	SubtitleLangDetectMode,
	SubtitlePreviewResult,
	SubtitlePreviewTrack,
	SubtitleSourcePriority,
	SubtitleStreamInfo,
} from "../core/types";
import { run } from "../core/process";
import { Logger } from "../core/logger";
import { join } from "path";
import { readFileSync, unlinkSync, existsSync, statSync } from "fs";
import { classifyAssLines } from "../subtitles/ass-classifier";
import { LANG_ALIASES } from "../core/naming";
import { getOpusBitrateForLayout, normalizeLayout } from "../pipeline/probe";
import { planTargetLanguages, type KeptSubDescriptor } from "../translate/subtitle-translate";

export const DEFAULT_IGNORE_KEYWORD = "RabbitIgnore";

const BARE_SCORE_THRESHOLD = 3;
const MIN_LINES_FOR_LANG_DETECTION = 5;

type WithLanguage = { language?: string };
interface WithTitle {
	index: number;
	title?: string;
}

export interface SubtitleAnalysisOptions {
	langDetect?: SubtitleLangDetectMode;
	langDetectConfidence?: number;
	detectSignsSongs?: boolean;
	detectSDH?: boolean;
	detectHonorifics?: boolean;
	signsSongsStyleRatio?: number;
	signsSongsLineRatio?: number;
	sdhRatioThreshold?: number;
	sdhMinLines?: number;
	honorificsMinCount?: number;
	honorificsRatio?: number;
	assumeMislabeled?: boolean;
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Drop tracks whose title contains the ignore keyword (case-insensitive
 * substring, so "[RabbitIgnore]", "RabbitIgnore: staff mix" etc. all match).
 *
 * Unlike the language filter this has NO keep-all fallback: it's an explicit
 * per-track instruction from whoever tagged the source, so dropping every
 * track is a legitimate outcome.
 */
export function filterIgnoredTracks<T extends WithTitle>(streams: T[], keyword: string | undefined, logTag: string): T[] {
	const kw = (keyword ?? DEFAULT_IGNORE_KEYWORD).trim();
	if (!kw) return streams;

	const re = new RegExp(escapeRegex(kw), "i");
	return streams.filter((s) => {
		if (s.title && re.test(s.title)) {
			Logger.info(`[${logTag}] Track ${s.index} dropped — title contains "${kw}": ${JSON.stringify(s.title)}`);
			return false;
		}
		return true;
	});
}

export function normalizeLanguageCode(input: string | undefined): string {
	if (!input) return "und";
	const s = input.toLowerCase().trim();
	return LANG_ALIASES[s] || s;
}

/**
 * Validate a language tag for mkvmerge's --language flag. mkvmerge rejects
 * anything that isn't a well-formed BCP 47 tag and aborts the whole mux, so a
 * malformed value must never reach it. Anything non-string or malformed logs
 * its raw value (as JSON) and falls back to "und".
 */
export function sanitizeLanguageTag(lang: unknown, ctx?: string): string {
	if (typeof lang !== "string") {
		if (lang != null) {
			Logger.warn(`[mux] Non-string language value ${JSON.stringify(lang)}${ctx ? ` (${ctx})` : ""} — falling back to "und"`);
		}
		return "und";
	}
	const tag = lang.trim();
	if (!tag) return "und";
	if (/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(tag)) return tag;
	Logger.warn(`[mux] Invalid language tag ${JSON.stringify(tag)}${ctx ? ` (${ctx})` : ""} — falling back to "und"`);
	return "und";
}

export interface SubtitleTypeFilterOptions {
	removeSDH?: boolean;
	removeCommentary?: boolean;
	removeForcedSignsSongs?: boolean;
	removeStoryboard?: boolean;
	removeHonorifics?: boolean;
	dropPicture?: boolean;
}

/** Drop subtitle tracks by detected type and/or bitmap codec. */
export function filterSubtitleTypes(streams: SubtitleStreamInfo[], options: SubtitleTypeFilterOptions = {}): SubtitleStreamInfo[] {
	return streams.filter((s) => {
		if (options.dropPicture && !isTextSubtitleCodec(s.codec)) return false;
		const type = detectSubtitleTrackType(s);
		if (options.removeSDH && type === "sdh") return false;
		if (options.removeCommentary && type === "commentary") return false;
		if (options.removeForcedSignsSongs && type === "forced") return false;
		if (options.removeStoryboard && type === "storyboard") return false;
		if (options.removeHonorifics && type === "honorifics") return false;
		return true;
	});
}

/**
 * Keep only tracks whose language matches the allowed list.
 * Empty list = no filter. `und`/missing-language tracks are dropped when active.
 * If the filter would drop every track, keep all and warn (avoid producing
 * a silent or sub-less encode from a typo).
 */
export function filterStreamsByLanguage<T extends WithLanguage>(streams: T[], allowed: string[], logTag: string): T[] {
	if (!allowed || allowed.length === 0) return streams;

	const allowedSet = new Set(allowed.map(normalizeLanguageCode));
	const filtered = streams.filter((s) => {
		if (!s.language) return false;
		return allowedSet.has(normalizeLanguageCode(s.language));
	});

	if (filtered.length === 0 && streams.length > 0) {
		Logger.warn(`[${logTag}] Language filter [${allowed.join(", ")}] matched no tracks, keeping all ${streams.length} as fallback`);
		return streams;
	}

	return filtered;
}

const UNCENSORED_PATTERN = /\b(uncensored|uncen|uncut)\b/i;
const COMMENTARY_PATTERN = /\b(commentary|director'?s?\s+commentary)\b/i;
const DESCRIPTIVE_PATTERN = /\b(descriptive|description|audio\s*desc(?:ription)?|visually\s*impaired|\bAD\b)\b/i;
const KARAOKE_PATTERN = /\b(karaoke|off[\s-]?vocal|instrumental|no[\s-]?vocal)\b/i;
const COMPATIBILITY_PATTERN = /compatibility/i;

export interface AudioDetectOptions {
	commentary?: boolean; // default true
	descriptive?: boolean; // default true
	karaoke?: boolean; // default true
}

export function detectAudioTrackType(stream: AudioStreamInfo, detect: AudioDetectOptions = {}): AudioTrackType {
	const title = stream.title;
	if (!title) return "main";
	const wantCommentary = detect.commentary ?? true;
	const wantDescriptive = detect.descriptive ?? true;
	const wantKaraoke = detect.karaoke ?? true;
	if (wantCommentary && COMMENTARY_PATTERN.test(title)) return "commentary";
	if (wantDescriptive && DESCRIPTIVE_PATTERN.test(title)) return "descriptive";
	if (wantKaraoke && KARAOKE_PATTERN.test(title)) return "karaoke";
	return "main";
}

/** Returns 0 if the track title marks it uncensored, 1 otherwise. */
function uncensoredPriority(stream: { title?: string }): number {
	return stream.title && UNCENSORED_PATTERN.test(stream.title) ? 0 : 1;
}

export interface AudioSortOptions {
	languagePriority?: string[];
	preferUncensored?: boolean; // default true
	detect?: AudioDetectOptions;
}

/**
 * Sort audio streams by language priority, then main > commentary/descriptive/karaoke,
 * then channel count, then (optionally) uncensored.
 */
export function sortAudioStreams(streams: AudioStreamInfo[], opts: AudioSortOptions = {}): AudioStreamInfo[] {
	const tier = buildLangTier(opts.languagePriority ?? ["jpn", "eng", "*"], { undLast: false });
	const preferUncensored = opts.preferUncensored ?? true;
	const detect = opts.detect;

	const typePriority = (stream: AudioStreamInfo): number => {
		const type = detectAudioTrackType(stream, detect);
		if (type === "main") return 0;
		if (type === "commentary") return 1;
		return 2; // descriptive / karaoke
	};

	return [...streams].sort((a, b) => {
		const ta = tier(a.language);
		const tb = tier(b.language);
		if (ta !== tb) return ta - tb;

		// Alphabetical tiebreak within the same tier (the wildcard bucket).
		const la = canonLang(a.language);
		const lb = canonLang(b.language);
		if (la !== lb) return la.localeCompare(lb);

		const tyA = typePriority(a);
		const tyB = typePriority(b);
		if (tyA !== tyB) return tyA - tyB;

		const chanA = a.channels || 2;
		const chanB = b.channels || 2;
		if (chanA !== chanB) return chanA - chanB;

		if (preferUncensored) return uncensoredPriority(a) - uncensoredPriority(b);
		return 0;
	});
}

const LOSSLESS_CODECS = new Set(["flac", "truehd", "mlp", "dts", "pcm_s16le", "pcm_s24le", "pcm_s32le"]);

export interface AudioDedupeOptions {
	collapseChannels?: boolean;
	codecPriority?: AudioCodecPriority; // default "lossless-first"
	preferUncensored?: boolean; // default true
	detect?: AudioDetectOptions;
}

export function deduplicateAudioStreams(streams: AudioStreamInfo[], options: AudioDedupeOptions = {}): AudioStreamInfo[] {
	const collapseChannels = options.collapseChannels ?? false;
	const codecPriority = options.codecPriority ?? "lossless-first";
	const preferUncensored = options.preferUncensored ?? true;
	const detect = options.detect;
	const bestMap = new Map<string, AudioStreamInfo>();

	const keyOf = (s: AudioStreamInfo): string => {
		const lang = (s.language || "und").toLowerCase();
		const type = detectAudioTrackType(s, detect);
		return collapseChannels ? `${lang}:${type}` : `${lang}:${s.channels}:${type}`;
	};

	const isBetter = (candidate: AudioStreamInfo, existing: AudioStreamInfo): boolean => {
		if (preferUncensored) {
			const cUnc = uncensoredPriority(candidate) === 0;
			const eUnc = uncensoredPriority(existing) === 0;
			if (cUnc !== eUnc) return cUnc; // uncensored wins outright
		}

		if (collapseChannels && (candidate.channels || 0) !== (existing.channels || 0)) {
			return (candidate.channels || 0) > (existing.channels || 0);
		}

		const cLossless = LOSSLESS_CODECS.has(candidate.codec?.toLowerCase() || "");
		const eLossless = LOSSLESS_CODECS.has(existing.codec?.toLowerCase() || "");

		if (codecPriority === "smallest-first") {
			// Prefer lossy, then the lower bitrate (smaller file).
			if (cLossless !== eLossless) return !cLossless;
			return (candidate.bitrate || Infinity) < (existing.bitrate || Infinity);
		}

		// lossless-first (current default): lossless, then highest bitrate.
		if (cLossless !== eLossless) return cLossless;
		return (candidate.bitrate || 0) > (existing.bitrate || 0);
	};

	for (const stream of streams) {
		const key = keyOf(stream);
		const existing = bestMap.get(key);
		if (!existing || isBetter(stream, existing)) bestMap.set(key, stream);
	}

	return streams.filter((s) => bestMap.get(keyOf(s)) === s);
}

export interface AudioTypeFilterOptions {
	removeCommentary?: boolean;
	removeDescriptive?: boolean;
	removeKaraoke?: boolean;
	dropCompatibility?: boolean;
}

/** Drop audio tracks by detected type and/or "compatibility" downmixes. */
export function filterAudioTypes(streams: AudioStreamInfo[], options: AudioTypeFilterOptions = {}, detect?: AudioDetectOptions): AudioStreamInfo[] {
	return streams.filter((s) => {
		if (options.dropCompatibility && s.title && COMPATIBILITY_PATTERN.test(s.title)) return false;
		const type = detectAudioTrackType(s, detect);
		if (options.removeCommentary && type === "commentary") return false;
		if (options.removeDescriptive && type === "descriptive") return false;
		if (options.removeKaraoke && type === "karaoke") return false;
		return true;
	});
}

/** @deprecated use filterAudioTypes. Kept for callers expecting the old name. */
export function filterOutCommentaryAudio(streams: AudioStreamInfo[]): AudioStreamInfo[] {
	return filterAudioTypes(streams, { removeCommentary: true });
}

export type SubtitleTrackType = "full" | "sdh" | "forced" | "commentary" | "honorifics" | "storyboard";

const SUB_FORCED_PATTERN = /\b(signs?[\s/&]*songs?|songs?[\s/&]*signs?|forced|typesett?ing|TS\b|OP\/?ED|karaoke|kara)\b/i;
const SUB_SDH_PATTERN = /\b(sdh|cc|closed\s*captions?|hearing\s*impaired|descriptive)\b/i;
const SUB_COMMENTARY_PATTERN = /\b(commentary|director'?s?\s+commentary|staff\s+commentary|cast\s+commentary|audio\s+commentary)\b/i;
const SUB_HONORIFICS_PATTERN = /\b(honorifics?|honours?|honourifics?|\bhon\b)\b/i;
const SUB_STORYBOARD_PATTERN = /\bstoryboard/i;

export function detectSubtitleTrackType(stream: SubtitleStreamInfo): SubtitleTrackType {
	const title = stream.title || "";

	if (SUB_HONORIFICS_PATTERN.test(title)) return "honorifics";
	if (SUB_COMMENTARY_PATTERN.test(title)) return "commentary";
	if (SUB_SDH_PATTERN.test(title)) return "sdh";
	if (SUB_FORCED_PATTERN.test(title)) return "forced";
	if (SUB_STORYBOARD_PATTERN.test(title)) return "storyboard";

	if (stream.isHearingImpaired) return "sdh";
	if (stream.isForced) return "forced";

	return "full";
}

const GROUP_BLOCKLIST = new Set([
	// Subtitle track types / content descriptors
	"cc",
	"sdh",
	"hi",
	"ad",
	"forced",
	"full",
	"fullsub",
	"fullsubs",
	"full_subs",
	"full_subtitles",
	"default",
	"descriptive",
	"hearing_impaired",
	"commentary",
	"signs",
	"sign",
	"songs",
	"song",
	"signs_songs",
	"signs_and_songs",
	"sings_and_songs",
	"dialogue",
	"dialog",
	"narrative",
	"narration",
	"captions",
	"caption",
	"lyrics",
	"lyric",
	"karaoke",
	"kara",
	"honorifics",
	"honorific",
	"honours",
	"honors",
	"honor",
	"hon",
	"subtitles",
	"subtitle",
	"subs",
	"sub",
	"ts",
	"op",
	"ed",
	"oped",
	"ncop",
	"nced",

	// Subtitle / file formats
	"pgs",
	"ass",
	"ssa",
	"srt",
	"vtt",
	"webvtt",
	"vobsub",
	"vobsubs",
	"idx",
	"sup",
	"smi",
	"sami",
	"sbv",
	"stl",
	"ttml",
	"dfxp",
	"mks",
	"mov_text",

	// Styling / version / status descriptors
	"styled",
	"unstyled",
	"restyled",
	"fixed",
	"fix",
	"patched",
	"final",
	"complete",
	"raw",
	"raws",
	"vanilla",
	"plain",
	"text",
	"graphics",
	"main",
	"alt",
	"alternate",
	"retail",
	"official",
	"multi",
	"multisub",
	"multisubs",
	"dual",

	// Media / episode descriptors
	"movie",
	"film",
	"ova",
	"ona",
	"oad",
	"special",
	"specials",
	"episode",
	"ep",
	"season",
	"volume",
	"vol",
	"disc",
	"disk",
	"bonus",
	"extra",
	"extras",
	"menu",
	"preview",
	"trailer",
	"intro",
	"outro",
	"credits",
	"creditless",

	// Dub-related
	"dub",
	"dubs",
	"dubbed",
	"dubtitle",
	"dubtitles",

	// French release / subtitle descriptors
	"vo",
	"vf",
	"vff",
	"vfq",
	"vfi",
	"vost",
	"vostfr",

	// Language names (English)
	"english",
	"japanese",
	"spanish",
	"french",
	"german",
	"italian",
	"portuguese",
	"russian",
	"chinese",
	"mandarin",
	"cantonese",
	"korean",
	"arabic",
	"dutch",
	"polish",
	"thai",
	"vietnamese",
	"viet",
	"hindi",
	"turkish",
	"swedish",
	"norwegian",
	"danish",
	"finnish",
	"greek",
	"hebrew",
	"czech",
	"slovak",
	"slovenian",
	"slovene",
	"hungarian",
	"romanian",
	"ukrainian",
	"croatian",
	"serbian",
	"bosnian",
	"bulgarian",
	"macedonian",
	"albanian",
	"belarusian",
	"indonesian",
	"malay",
	"filipino",
	"tagalog",
	"persian",
	"farsi",
	"estonian",
	"latvian",
	"lithuanian",
	"icelandic",
	"catalan",
	"basque",
	"welsh",
	"georgian",
	"armenian",
	"bengali",
	"tamil",
	"telugu",
	"urdu",
	"malayalam",
	"kannada",
	"marathi",
	"burmese",
	"khmer",
	"lao",
	"mongolian",
	"nepali",
	"sinhala",

	// Region / variant words
	"us",
	"uk",
	"gb",
	"la",
	"spain",
	"españa",
	"espana",
	"iberian",
	"castilian",
	"latin",
	"latam",
	"latino",
	"latina",
	"latin_america",
	"latin_american",
	"mexico",
	"mexican",
	"argentina",
	"brazil",
	"brasil",
	"brazilian",
	"portugal",
	"europe",
	"european",
	"parisian",
	"france",
	"canada",
	"canadian",
	"quebec",
	"quebecois",
	"britain",
	"british",
	"america",
	"american",
	"mainland",
	"taiwan",
	"taiwanese",
	"hongkong",
	"hong_kong",
	"simplified",
	"traditional",

	// ISO 639 two-letter codes (whole-token match only)
	"en",
	"ja",
	"es",
	"fr",
	"de",
	"it",
	"pt",
	"ru",
	"zh",
	"ko",
	"ar",
	"nl",
	"pl",
	"th",
	"vi",
	"tr",
	"sv",
	"da",
	"fi",
	"el",
	"he",
	"cs",
	"sk",
	"sl",
	"hu",
	"ro",
	"uk",
	"hr",
	"sr",
	"bg",
	"id",
	"ms",
	"tl",
	"fa",
	"et",
	"lv",
	"lt",
	"ca",
	"cy",
	"bn",
	"ta",
	"te",
	"ur",
	"ml",
	"kn",
	"mr",
	"my",
	"km",
	"lo",
	"mn",
	"ne",
	"si",

	// ISO 639 three-letter codes (terminology + bibliographic)
	"eng",
	"jpn",
	"spa",
	"fre",
	"fra",
	"ger",
	"deu",
	"ita",
	"por",
	"rus",
	"chi",
	"zho",
	"kor",
	"ara",
	"dut",
	"nld",
	"pol",
	"tha",
	"vie",
	"tur",
	"swe",
	"nor",
	"dan",
	"fin",
	"gre",
	"ell",
	"heb",
	"cze",
	"ces",
	"slo",
	"slk",
	"slv",
	"hun",
	"rum",
	"ron",
	"ukr",
	"hrv",
	"srp",
	"bos",
	"bul",
	"mac",
	"mkd",
	"alb",
	"sqi",
	"bel",
	"ind",
	"may",
	"msa",
	"fil",
	"tgl",
	"per",
	"fas",
	"est",
	"lav",
	"lit",
	"ice",
	"isl",
	"cat",
	"baq",
	"eus",
	"wel",
	"cym",
	"geo",
	"kat",
	"arm",
	"hye",
	"ben",
	"tam",
	"tel",
	"urd",
	"mal",
	"kan",
	"mar",
	"bur",
	"mya",
	"khm",
	"lao",
	"mon",
	"nep",
	"sin",
	"hin",
]);

function normalizeToken(s: string): string {
	return s
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, "_");
}

function isBlockedToken(s: string): boolean {
	return GROUP_BLOCKLIST.has(normalizeToken(s));
}

function looksLikeGroupName(s: string): boolean {
	const trimmed = s.trim();

	// Reject empty / too short / too long
	if (!trimmed || trimmed.length < 2 || trimmed.length > 40) return false;

	// Allow common group-name chars, including spaces
	if (!/^[A-Za-z0-9._&@+\- /]+$/.test(trimmed)) return false;

	// Reject pure language/tag words
	if (isBlockedToken(trimmed)) return false;

	// Reject tokens that are just numbers
	if (/^\d+$/.test(trimmed)) return false;

	return true;
}

/** True when every word in the string is a blocked language/descriptor token. */
function isAllLanguageWords(s: string): boolean {
	const words = s.split(/[\s/_-]+/).filter(Boolean);
	return words.length > 0 && words.every((w) => isBlockedToken(w));
}

/**
 * Confidence that a token is a release/fansub group name. Higher = more
 * group-like. Used to rank bracket candidates, and to gate the risky bare-title
 * path (which requires a score >= BARE_SCORE_THRESHOLD before it accepts).
 */
function scoreGroupCandidate(s: string): number {
	const t = s.trim();
	let score = 0;

	// Fansub suffix ("Kaleido-subs", "BlubberSubs") - but not a bare "sub"/"subs".
	if (/(?:fan)?subs?\b/i.test(t) && !/^(?:fan)?subs?$/i.test(t)) score += 4;
	// Hyphen joining two alpha parts ("Erai-raws", "GST-subs").
	if (/[A-Za-z]+-[A-Za-z]+/.test(t)) score += 2;
	// Internal CamelCase ("SubsPlease", "BlubberSubs").
	if (/[a-z][A-Z]/.test(t)) score += 3;
	// All-caps acronym ("MTBB", "GJM", "ASW").
	if (/^[A-Z][A-Z0-9]+$/.test(t)) score += 3;
	// Official-studio keywords ("Sentai Filmworks").
	if (/\b(filmworks|studios?|media|entertainment|works|productions?|fansubs?)\b/i.test(t)) score += 2;
	// Group-ish punctuation / mixed digits.
	if (/[._@+]/.test(t)) score += 2;
	if (/-/.test(t)) score += 1;
	if (/[A-Za-z]/.test(t) && /\d/.test(t)) score += 1;

	// Penalty: a single plain word, no internal capital, not an acronym
	// (most likely a descriptor or language name).
	if (/^[A-Za-z]+$/.test(t) && !/[a-z][A-Z]/.test(t) && !/^[A-Z]+$/.test(t)) score -= 2;
	// Penalty: composed entirely of language/descriptor words.
	if (isAllLanguageWords(t)) score -= 5;

	return score;
}

export function normalizeLanguageGroup(lang: string | undefined): string {
	if (isEnglish(lang)) return "en";
	if (isJapanese(lang)) return "ja";
	if (isMalay(lang)) return "msa";
	if (isIndonesian(lang)) return "ind";
	if (isUndefined(lang)) return "und";
	return (lang || "und").toLowerCase();
}

/**
 * Detect editor/modifier credits that should not be treated as group names.
 * Matches patterns like "deanzel edit", "Tormaid/joseole99 edit", "v2 fix".
 */
function isEditCredit(s: string): boolean {
	return /\b(edit|edited|fix|fixed|patch|patched|mod|modified|restyle|restyled|retimed?|sync|synced)\b/i.test(s);
}

/**
 * Extract likely fansub/release group name from a subtitle title.
 *
 * Strategy 1 - Pipe-separated:   "Full Subtitles | Static-Subs (edit)" => "Static-Subs"
 * Strategy 2 - "@"-separated:    "Full Sub@Kaleido-subs"               => "Kaleido-subs"
 * Strategy 3 - Bracketed:        "English (SubsPlease)" / "[MTBB]"     => group
 * Strategy 4 - Bare title (risky, score-gated): "Erai-raws"           => "Erai-raws"
 *                                                "English"            => null
 */
export function extractGroupFromTitle(title: string | undefined): string | null {
	if (!title) return null;

	// Strategy 1: "{Type} | {Group} ({credits})"
	const pipeIndex = title.indexOf("|");
	if (pipeIndex >= 0) {
		const afterPipe = title.slice(pipeIndex + 1).trim();
		const parenIndex = afterPipe.indexOf("(");
		const groupPart = (parenIndex >= 0 ? afterPipe.slice(0, parenIndex) : afterPipe).trim();
		if (groupPart && looksLikeGroupName(groupPart) && !isEditCredit(groupPart)) {
			return groupPart;
		}
	}

	// Strategy 2: "{Whatever}@{Group}" - text after the last "@", minus any trailing tag/credit block.
	const atIndex = title.lastIndexOf("@");
	if (atIndex >= 0) {
		const afterAt = title
			.slice(atIndex + 1)
			.replace(/[\[(].*$/, "")
			.trim();
		if (afterAt && looksLikeGroupName(afterAt) && !isEditCredit(afterAt)) {
			return afterAt;
		}
	}

	// Strategy 3: bracketed [Group] / (Group), ranked by score.
	const matches = [...title.matchAll(/[\[(]([^[\]()]*)[\])]/g)].map((m) => m[1]?.trim()).filter((s): s is string => Boolean(s));
	const bracketCandidates = matches.filter((s) => looksLikeGroupName(s) && !isEditCredit(s));
	if (bracketCandidates.length > 0) {
		bracketCandidates.sort((a, b) => scoreGroupCandidate(b) - scoreGroupCandidate(a));
		return bracketCandidates[0] ?? null;
	}

	// Strategy 4 (risky): bare title with no delimiters/brackets. Trim blocked
	// descriptor/language words off both ends ("Full Subtitles Kaleido-subs" =>
	// "Kaleido-subs"), then accept the remainder only if it scores group-like.
	if (!/[|@\[\](){}]/.test(title)) {
		const tokens = title.trim().split(/\s+/).filter(Boolean);
		let start = 0;
		let end = tokens.length;
		while (start < end && isBlockedToken(tokens[start]!)) start++;
		while (end > start && isBlockedToken(tokens[end - 1]!)) end--;
		const candidate = tokens.slice(start, end).join(" ");
		if (
			candidate &&
			looksLikeGroupName(candidate) &&
			!isEditCredit(candidate) &&
			!isAllLanguageWords(candidate) &&
			scoreGroupCandidate(candidate) >= BARE_SCORE_THRESHOLD
		) {
			return candidate;
		}
	}

	return null;
}

export function isEnglish(lang: string | undefined): boolean {
	const l = (lang || "").toLowerCase();
	return l === "eng" || l === "en" || l === "english" || l === "enm" || l.startsWith("en-");
}

export function isJapanese(lang: string | undefined): boolean {
	const l = (lang || "").toLowerCase();
	return l === "jpn" || l === "ja" || l === "japanese" || l.startsWith("ja-");
}

export function isMalay(lang: string | undefined): boolean {
	const l = (lang || "").toLowerCase();
	return l === "may" || l === "msa" || l === "ms" || l === "malay" || l.startsWith("ms-");
}

export function isIndonesian(lang: string | undefined): boolean {
	const l = (lang || "").toLowerCase();
	return l === "ind" || l === "id" || l === "indonesian" || l.startsWith("id-");
}

export function isUndefined(lang: string | undefined): boolean {
	const l = (lang || "").toLowerCase();
	return !l || l === "und" || l === "undetermined";
}

function canonLang(x: string | undefined): string {
	if (isUndefined(x)) return "und";
	if (isEnglish(x)) return "en";
	if (isJapanese(x)) return "ja";
	return normalizeLanguageCode(x).toLowerCase();
}

/**
 * Build a tier function from an ordered priority list.
 *   - Listed tokens get tiers 0..n in order.
 *   - "*" marks where unlisted languages sort (alphabetically among themselves).
 *     If absent, unlisted languages sort after all listed ones.
 *   - undefined/"und": when `undLast`, always last; otherwise treated as a normal
 *     unlisted language.
 */
export function buildLangTier(order: string[], opts: { undLast?: boolean } = {}): (lang: string | undefined) => number {
	const undLast = opts.undLast ?? false;
	const tokens = (order && order.length ? order : ["*"]).map((t) => t.trim().toLowerCase());
	const wildcardIndex = tokens.indexOf("*");
	const restTier = wildcardIndex >= 0 ? wildcardIndex : tokens.length;
	const listed = new Map<string, number>();
	tokens.forEach((t, i) => {
		if (t !== "*") listed.set(canonLang(t), i);
	});

	return (lang: string | undefined): number => {
		const c = canonLang(lang);
		if (c === "und" && undLast) return Number.MAX_SAFE_INTEGER;
		const hit = listed.get(c);
		return hit !== undefined ? hit : restTier;
	};
}

const SOURCE_TAG_PATTERN =
	/\b([A-Z]{2}(?:BD|UHD|DVD)|Netflix|Crunchyroll|Funimation|HiDive|HIDIVE|Amazon|Disney\+?|DSNP|AppleTV\+?|ATV|Hulu|VRV|ADN|Wakanim|B-Global|Bilibili|NF|CR|AMZN)\b/i;

export function extractSourceTag(title: string | undefined): string | null {
	if (!title) return null;
	const match = title.match(SOURCE_TAG_PATTERN);
	if (!match) return null;
	const raw = match[1]!;
	// Normalize BD/DVD/UHD tags to uppercase
	if (/^[A-Z]{2}(?:BD|UHD|DVD)$/i.test(raw)) return raw.toUpperCase();
	// Canonical casing for known services
	const canonical: Record<string, string> = {
		netflix: "NF",
		nf: "NF",
		crunchyroll: "CR",
		cr: "CR",
		funimation: "Funi",
		hidive: "HIDIVE",
		amazon: "AMZN",
		amzn: "AMZN",
		"disney+": "DSNP",
		disney: "DSNP",
		dsnp: "DSNP",
		"appletv+": "ATV",
		appletv: "ATV",
		atv: "ATV",
		hulu: "Hulu",
		vrv: "VRV",
		adn: "ADN",
		wakanim: "Wakanim",
		"b-global": "B-Global",
		bilibili: "Bilibili",
	};
	return canonical[raw.toLowerCase()] ?? raw;
}

/**
 * Build a clean track name for an audio stream.
 * "main" returns "" (no meaningful canonical name); other types get a label,
 * optionally suffixed with the detected source/group tag.
 *
 * `format` is reserved for a future user template and is currently ignored.
 */
export function buildAudioTrackName(trackType: AudioTrackType, sourceTitle?: string, format?: string): string {
	// TODO(name-format): when `format` is non-empty, render via the user template.
	void format;
	if (trackType === "main") return "";

	const title = sourceTitle || "";
	const labels: Record<Exclude<AudioTrackType, "main">, string> = {
		commentary: "Commentary",
		descriptive: "Audio Description",
		karaoke: "Karaoke",
	};
	const label = labels[trackType];

	const source = extractSourceTag(title);
	if (source) return `${label} [${source}]`;
	const group = extractGroupFromTitle(title);
	if (group) return `${label} [${group}]`;
	return label;
}

/**
 * Build a clean track name for a subtitle stream.
 *
 * Examples:
 *   "Full Subtitles [SubsPlease]"
 *   "Full Subtitles"
 *   "Full Subtitles (Honorifics) [MTBB]"
 *   "SDH [Group]"
 *   "Signs & Songs"
 *   "Full Subtitles [MTBB]"
 */
export function buildSubtitleTrackName(trackType: SubtitleTrackType, sourceTitle?: string, groupOverride?: string): string {
	const title = sourceTitle || "";
	const isDubtitle = /dubtitle|\bdub\b/i.test(title);

	const labels: Record<SubtitleTrackType, string> = {
		full: isDubtitle ? "Full Dubtitles" : "Full Subtitles",
		honorifics: isDubtitle ? "Full Dubtitles (Honorifics)" : "Full Subtitles (Honorifics)",
		sdh: "SDH",
		forced: "Signs & Songs",
		commentary: "Commentary",
		storyboard: "Storyboards",
	};
	let label = labels[trackType];

	if (groupOverride) return `${label} [${groupOverride}]`;

	const source = extractSourceTag(title);
	if (source) return `${label} [${source}]`;

	const group = extractGroupFromTitle(title);
	if (group) return `${label} [${group}]`;

	return label;
}

/**
 * Determine the source/group priority for a subtitle stream.
 *
 * Priority tiers:
 *   0: BD/DVD sources (JPBD=0, USBD=1, ITBD=2, other BD/DVD=3)
 *   1: Streaming sources (NF=0, CR=1, AMZN=2, DSNP=3, ATV=4, HIDIVE=5, ADN=6, other=7)
 *   2: Release groups (alphabetically)
 *   3: Unknown (no source or group detected)
 */
function sourceGroupPriority(stream: SubtitleStreamInfo): { tier: number; rank: number; name: string } {
	const title = stream.title || "";

	// Check for a recognized source tag first
	const source = extractSourceTag(title);
	if (source) {
		// BD/DVD/UHD sources
		if (/^[A-Z]{2}(BD|UHD|DVD)$/i.test(source)) {
			const prefix = source.slice(0, 2).toUpperCase();
			const bdOrder: Record<string, number> = { JP: 0, US: 1, IT: 2 };
			return { tier: 0, rank: bdOrder[prefix] ?? 3, name: source };
		}

		// Streaming sources
		const streamingOrder: Record<string, number> = {
			NF: 0,
			CR: 1,
			AMZN: 2,
			DSNP: 3,
			ATV: 4,
			HIDIVE: 5,
			ADN: 6,
		};
		const streamingRank = streamingOrder[source.toUpperCase()];
		if (streamingRank !== undefined) {
			return { tier: 1, rank: streamingRank, name: source };
		}

		// Known service but not in the priority list - treat as other streaming
		return { tier: 1, rank: 7, name: source };
	}

	// Check for a release group
	const group = extractGroupFromTitle(title);
	if (group) {
		return { tier: 2, rank: 0, name: group };
	}

	// No source or group detected
	return { tier: 3, rank: 0, name: "" };
}

export interface SubtitleSortOptions {
	sourcePriority?: SubtitleSourcePriority;
	fansubTiebreak?: SubtitleFansubTiebreak;
	formatPriority?: SubtitleFormatPriority;
	languagePriority?: string[];
}

/**
 * Sort subtitle streams:
 *   1. Language: English first, Japanese second, others alphabetically, undefined last
 *   2. Type: full > honorifics > forced > sdh > commentary > storyboard
 *   3. Format: text-based before picture-based (PGS, VOBSUB...)
 *   4. Source/group:
 *      - BD/DVD: JPBD > USBD > ITBD > other BD/DVD
 *      - Streaming: NF > CR > AMZN > DSNP > ATV > HIDIVE > ADN > other
 *      - Release groups (alphabetically)
 *      - Unknown (no source or group) last
 */
export function sortSubtitleStreams(streams: SubtitleStreamInfo[], options: SubtitleSortOptions = {}): SubtitleStreamInfo[] {
	const sourcePriority = options.sourcePriority ?? "official-first";
	const fansubTiebreak = options.fansubTiebreak ?? "alphabetical";
	const formatPref = options.formatPriority ?? "text-first";

	const langTier = buildLangTier(options.languagePriority ?? ["eng", "jpn", "*"], { undLast: true });

	const typePriority = (stream: SubtitleStreamInfo): number => {
		const type = detectSubtitleTrackType(stream);
		switch (type) {
			case "full":
				return 0;
			case "honorifics":
				return 1;
			case "sdh":
				return 2;
			case "forced":
				return 3;
			case "commentary":
				return 4;
			case "storyboard":
				return 5;
			default:
				return 6;
		}
	};

	const formatPriority = (stream: SubtitleStreamInfo): number => {
		const isText = isTextSubtitleCodec(stream.codec);
		return formatPref === "picture-first" ? (isText ? 1 : 0) : isText ? 0 : 1;
	};

	// Remap source tiers when fansubs should rank first:
	// groups(2) -> 0, BD(0) -> 1, streaming(1) -> 2, unknown(3) -> 3
	const effectiveTier = (tier: number): number => {
		if (sourcePriority !== "fansub-first") return tier;
		switch (tier) {
			case 2:
				return 0;
			case 0:
				return 1;
			case 1:
				return 2;
			default:
				return 3;
		}
	};

	return [...streams].sort((a, b) => {
		// 1. Language
		const langA = langTier(a.language);
		const langB = langTier(b.language);
		if (langA !== langB) return langA - langB;

		// Alphabetical tiebreak within the wildcard bucket (regional variants preserved).
		if (langA === langB) {
			const la = normalizeLanguageGroup(a.language);
			const lb = normalizeLanguageGroup(b.language);
			if (la !== lb) return la.localeCompare(lb);
		}

		// 2. Type
		const typeA = typePriority(a);
		const typeB = typePriority(b);
		if (typeA !== typeB) return typeA - typeB;

		// 3. Format (text before bitmap)
		const fmtA = formatPriority(a);
		const fmtB = formatPriority(b);
		if (fmtA !== fmtB) return fmtA - fmtB;

		// 4. Uncensored
		const uncA = uncensoredPriority(a);
		const uncB = uncensoredPriority(b);
		if (uncA !== uncB) return uncA - uncB;

		// 5. Source/group
		const sgA = sourceGroupPriority(a);
		const sgB = sourceGroupPriority(b);
		const tierA = effectiveTier(sgA.tier);
		const tierB = effectiveTier(sgB.tier);
		if (tierA !== tierB) return tierA - tierB;
		if (sgA.rank !== sgB.rank) return sgA.rank - sgB.rank;

		// Within release groups (original tier 2)
		if (sgA.tier === 2 && sgB.tier === 2) {
			if (fansubTiebreak === "source-order") return a.index - b.index;
			return sgA.name.toLowerCase().localeCompare(sgB.name.toLowerCase());
		}

		return 0;
	});
}

/**
 * Deduplicate subtitle streams: keep only the first stream per
 * (language group + track type) combination.
 *
 * Input is already sorted best-first by sortSubtitleStreams,
 * so the first occurrence is the highest-quality candidate.
 *
 * Regional variants (es-ES vs es-419, pt-PT vs pt-BR, zh-Hant vs zh-Hans)
 * are kept as separate keys since normalizeLanguageGroup preserves them.
 */
export function deduplicateSubtitleStreams(streams: SubtitleStreamInfo[], options: { acrossFormat?: boolean } = {}): SubtitleStreamInfo[] {
	const acrossFormat = options.acrossFormat ?? true;
	const seen = new Set<string>();
	const kept: SubtitleStreamInfo[] = [];

	for (const stream of streams) {
		const langGroup = normalizeLanguageGroup(stream.language);
		const type = detectSubtitleTrackType(stream);
		const fmt = isTextSubtitleCodec(stream.codec) ? "t" : "p";
		const key = acrossFormat ? `${langGroup}:${type}` : `${langGroup}:${type}:${fmt}`;

		if (seen.has(key)) {
			Logger.info(`[subtitle] Dedup: dropping track ${stream.index} (${stream.language || "und"}:${type}) — already kept a better candidate`);
			continue;
		}
		seen.add(key);
		kept.push(stream);
	}
	return kept;
}

interface LanguageDetectorResult {
	file: string;
	total_words: number;
	detected: {
		language: string;
		iso_639_1: string;
		iso_639_2: string;
		bcp47: string | null;
		matched_words: number;
		confidence: number;
	};
}

/**
 * Run language-detector on a subtitle file and return the parsed result.
 */
async function detectLanguage(filePath: string, signal?: AbortSignal): Promise<LanguageDetectorResult | null> {
	const res = await run(["language-detector", "-f", "json", filePath], { signal });

	if (res.code !== 0) {
		if (res.code !== 127) {
			Logger.warn(`[subtitle] language-detector failed for ${filePath}: ${res.stderr || res.stdout}`);
		}
		return null;
	}

	try {
		const result = JSON.parse(res.stdout) as LanguageDetectorResult;
		if (!result.detected || result.total_words === 0) return null;
		return result;
	} catch {
		Logger.warn(`[subtitle] Failed to parse language-detector output for ${filePath}`);
		return null;
	}
}

// Subtitle codec helpers & extraction

const TEXT_SUB_CODECS = new Set(["subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text", "subviewer", "microdvd"]);
const ASS_CODECS = new Set(["ass", "ssa"]);

const PGS_SUB_CODECS = new Set(["hdmv_pgs_subtitle", "pgssub", "pgs"]);
const DVD_SUB_CODECS = new Set(["dvd_subtitle", "dvdsub"]);

export function isTextSubtitleCodec(codec: string): boolean {
	return TEXT_SUB_CODECS.has(codec.toLowerCase());
}

export function isPgsSubtitleCodec(codec: string): boolean {
	return PGS_SUB_CODECS.has(codec.toLowerCase());
}

export function isDvdSubtitleCodec(codec: string): boolean {
	return DVD_SUB_CODECS.has(codec.toLowerCase());
}

interface SubtitleExtraction {
	text: string;
	format: "ass" | "srt";
	filePath: string;
}

/**
 * Extract every text subtitle track in ONE ffmpeg pass (one read of the source)
 * instead of one read per track. Returns index -> on-disk path for tracks that
 * produced a non-empty file. Failures are non-fatal (except real aborts): a
 * failed or partial pass just yields fewer entries, and the caller falls back
 * to per-track extraction for whatever is missing.
 */
export async function extractAllSubtitles(
	inputPath: string,
	textStreams: SubtitleStreamInfo[],
	tempDir: string,
	signal?: AbortSignal,
): Promise<Map<number, string>> {
	const planned = new Map<number, string>();
	const args = ["ffmpeg", "-loglevel", "error", "-y", "-i", inputPath];

	for (const stream of textStreams) {
		const isAss = ASS_CODECS.has(stream.codec.toLowerCase());
		const ext = isAss ? "ass" : "srt";
		const out = join(tempDir, `sub_analyze_all_${stream.index}.${ext}`);
		const codecArgs = isAss ? ["-c:s", "copy"] : ["-c:s", "srt"];
		args.push("-map", `0:${stream.index}`, ...codecArgs, out);
		planned.set(stream.index, out);
	}

	if (planned.size === 0) return new Map();

	try {
		const res = await run(args, { signal });
		if (res.code !== 0) {
			Logger.warn(
				`[subtitle] Combined extraction pass exited ${res.code} (${res.stderr || res.stdout}); ` + `falling back to per-track extraction where needed`,
			);
		}
	} catch (err) {
		if (signal?.aborted) throw err; // genuine cancellation: propagate
		Logger.warn(`[subtitle] Combined extraction pass failed (${(err as Error).message}); ` + `falling back to per-track extraction`);
	}

	// Keep only tracks that produced a usable (non-empty) file.
	const extracted = new Map<number, string>();
	for (const [index, file] of planned) {
		try {
			if (statSync(file).size > 0) extracted.set(index, file);
		} catch {
			/* missing -> per-track fallback handles it */
		}
	}
	return extracted;
}

async function extractSubtitleForAnalysis(
	inputPath: string,
	stream: SubtitleStreamInfo,
	tempDir: string,
	signal?: AbortSignal,
	preExtractedPath?: string,
): Promise<SubtitleExtraction | null> {
	const isAss = ASS_CODECS.has(stream.codec.toLowerCase());
	const ext = isAss ? "ass" : "srt";

	let outPath = preExtractedPath;
	if (!outPath) {
		outPath = join(tempDir, `sub_analyze_${stream.index}.${ext}`);
		const codecArgs = isAss ? ["-c:s", "copy"] : ["-c:s", "srt"];
		const res = await run(["ffmpeg", "-y", "-i", inputPath, "-map", `0:${stream.index}`, ...codecArgs, "-vn", "-an", outPath], { signal });
		if (res.code !== 0) {
			Logger.warn(`[subtitle] Failed to extract track ${stream.index} for analysis: ${res.stderr || res.stdout}`);
			return null;
		}
	}

	try {
		const text = readFileSync(outPath, "utf-8");
		return { text, format: isAss ? "ass" : "srt", filePath: outPath };
	} catch {
		return null;
	}
}

function cleanupExtraction(extraction: SubtitleExtraction): void {
	try {
		if (existsSync(extraction.filePath)) unlinkSync(extraction.filePath);
	} catch {}
}

// Content analysis
const HONORIFIC_PATTERN = /\b\w+[-–](?:san|kun|chan|sama|sensei|senpai|k[oō]hai|dono|tan|n[ei]e|n[ei]i|b[oō]|shi|jo)\b/gi;

const SDH_SPEAKER_PATTERN = /^[A-Z][A-Z\s.'-]{1,30}:/;
const SDH_BRACKET_PATTERN = /\[[^\]]{2,60}\]/;
const SDH_PAREN_PATTERN = /\([^)]{2,60}\)/;
const SDH_MUSIC_PATTERN = /[♪♫♬]/;

const SRT_TIMESTAMP_PATTERN = /^\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/;

function stripSubtitleTags(text: string): string {
	return text
		.replace(/<[^>]+>/g, "")
		.replace(/\{[^}]*\}/g, "")
		.replace(/\\N/g, "\n")
		.trim();
}

interface SubtitleContentAnalysis {
	dialogueLineCount: number;
	assStyles: {
		signStyleLines: number;
		dialogueStyleLines: number;
		otherStyleLines: number;
		totalLines: number;
	} | null;
	sdhRatio: number;
	honorificCount: number;
}

function analyzeSrtContent(srtText: string): SubtitleContentAnalysis {
	const lines = srtText.split("\n");
	let dialogueLineCount = 0;
	let sdhLineCount = 0;
	let totalTextLines = 0;
	let honorificCount = 0;

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (SRT_TIMESTAMP_PATTERN.test(line)) {
			dialogueLineCount++;
			continue;
		}
		if (!line || /^\d+$/.test(line)) continue;

		const cleaned = stripSubtitleTags(line);
		if (!cleaned) continue;
		totalTextLines++;

		if (SDH_SPEAKER_PATTERN.test(cleaned) || SDH_BRACKET_PATTERN.test(cleaned) || SDH_PAREN_PATTERN.test(cleaned) || SDH_MUSIC_PATTERN.test(cleaned)) {
			sdhLineCount++;
		}

		const honMatches = cleaned.match(HONORIFIC_PATTERN);
		if (honMatches) honorificCount += honMatches.length;
	}

	return {
		dialogueLineCount,
		assStyles: null,
		sdhRatio: totalTextLines > 0 ? sdhLineCount / totalTextLines : 0,
		honorificCount,
	};
}

function analyzeAssContent(assText: string): SubtitleContentAnalysis {
	const classified = classifyAssLines(assText);
	let signStyleLines = 0;
	let dialogueStyleLines = 0;
	let otherStyleLines = 0;
	let sdhLineCount = 0;
	let honorificCount = 0;
	let totalTextLines = 0;
	let dialogueTextLines = 0;

	for (const { text, kind } of classified) {
		if (kind === "sign" || kind === "song") signStyleLines++;
		else if (kind === "dialogue") dialogueStyleLines++;
		else otherStyleLines++;

		const cleaned = stripSubtitleTags(text);
		if (!cleaned) continue;
		totalTextLines++;

		if (kind === "dialogue") {
			dialogueTextLines++;
			if (SDH_SPEAKER_PATTERN.test(cleaned) || SDH_BRACKET_PATTERN.test(cleaned) || SDH_PAREN_PATTERN.test(cleaned) || SDH_MUSIC_PATTERN.test(cleaned)) {
				sdhLineCount++;
			}
		}

		const honMatches = cleaned.match(HONORIFIC_PATTERN);
		if (honMatches) honorificCount += honMatches.length;
	}

	return {
		dialogueLineCount: classified.length,
		assStyles: { signStyleLines, dialogueStyleLines, otherStyleLines, totalLines: classified.length },
		sdhRatio: dialogueTextLines > 0 ? sdhLineCount / dialogueTextLines : 0,
		honorificCount,
	};
}

function analyzeContent(extraction: SubtitleExtraction): SubtitleContentAnalysis {
	return extraction.format === "ass" ? analyzeAssContent(extraction.text) : analyzeSrtContent(extraction.text);
}

// Title-based regional variant detection patterns
const SPANISH_EUROPEAN_PATTERN = /\b(european|castilian|espa[ñn]a|spain)\b|es[-_]es\b/i;
const SPANISH_LATAM_PATTERN = /\b(latin[\s_-]*americ\w*|latino|latam|lat[-_]am)\b|es[-_](419|mx|ar|co|cl|pe|ve)\b/i;
const PORTUGUESE_EUROPEAN_PATTERN = /\b(european|portugal|portugu[eê]s\s*europeu)\b|pt[-_]pt\b/i;
const PORTUGUESE_BRAZILIAN_PATTERN = /\b(brazil\w*|brasil\w*)\b|pt[-_]br\b/i;
const FRENCH_CANADIAN_PATTERN = /\b(canad\w*|qu[eé]b[eé]c\w*)\b|fr[-_]ca\b/i;
const FRENCH_EUROPEAN_PATTERN = /\b(france|parisian|fran[cç]ais\s*(?:de\s*)?france|european)\b|fr[-_]fr\b/i;
const CHINESE_TRADITIONAL_PATTERN = /\b(traditional|繁體|繁体|taiwan\w*|hong\s*kong)\b|zh[-_](hant|tw|hk)\b/i;
const CHINESE_SIMPLIFIED_PATTERN = /\b(simplified|简体|简體|mainland)\b|zh[-_](hans|cn)\b/i;

/**
 * Extract a regional language variant from the subtitle track title.
 *
 * When the title contains explicit regional hints (e.g. "Latin America",
 * "Castilian", "Brazilian"), we trust that over the language-detector
 * which cannot reliably distinguish regional variants of the same language.
 *
 * Returns a BCP47 code if a variant is detected, null otherwise.
 */
function extractRegionalVariant(stream: SubtitleStreamInfo): string | null {
	const title = stream.title || "";
	if (!title) return null;

	const lang = (stream.language || "").toLowerCase();

	// Spanish: es-ES (European/Castilian) vs es-419 (Latin America)
	if (lang === "spa" || lang === "es" || lang.startsWith("es-")) {
		if (SPANISH_EUROPEAN_PATTERN.test(title)) return "es-ES";
		if (SPANISH_LATAM_PATTERN.test(title)) return "es-419";
	}

	// Portuguese: pt-PT (European) vs pt-BR (Brazilian)
	if (lang === "por" || lang === "pt" || lang.startsWith("pt-")) {
		if (PORTUGUESE_EUROPEAN_PATTERN.test(title)) return "pt-PT";
		if (PORTUGUESE_BRAZILIAN_PATTERN.test(title)) return "pt-BR";
	}

	// French: fr-FR (France) vs fr-CA (Canadian)
	if (lang === "fre" || lang === "fra" || lang === "fr" || lang.startsWith("fr-")) {
		if (FRENCH_EUROPEAN_PATTERN.test(title)) return "fr-FR";
		if (FRENCH_CANADIAN_PATTERN.test(title)) return "fr-CA";
	}

	// Chinese: zh-Hant (Traditional) vs zh-Hans (Simplified)
	if (lang === "zho" || lang === "chi" || lang === "zh" || lang.startsWith("zh-")) {
		if (CHINESE_TRADITIONAL_PATTERN.test(title)) return "zh-Hant";
		if (CHINESE_SIMPLIFIED_PATTERN.test(title)) return "zh-Hans";
	}

	return null;
}

/**
 * Comprehensive subtitle analysis. Mutates streams in place.
 *
 * Each text-based stream is extracted once; the file is reused for
 * both language-detector and content analysis before cleanup.
 *
 * Steps:
 *   1. Extract all text-based streams & run content analysis
 *   2. Language detection via language-detector (sets language to BCP47 or ISO 639-2)
 *   3. Bitmap fallback (PGS/VOBSUB when no English found)
 *   4. ASS style-based Signs & Songs detection
 *   5. Line-count-based Signs & Songs detection
 *   6. SDH content detection
 *   7. Honorifics detection (pair comparison)
 */
export async function analyzeSubtitleStreams(
	streams: SubtitleStreamInfo[],
	inputPath: string,
	tempDir: string,
	options: SubtitleAnalysisOptions = {},
	signal?: AbortSignal,
): Promise<void> {
	if (streams.length === 0) return;

	const langDetect = options.langDetect ?? "enabled";
	const langDetectConfidence = options.langDetectConfidence ?? 0.05;
	const detectSignsSongs = options.detectSignsSongs ?? true;
	const detectSDH = options.detectSDH ?? true;
	const detectHonorifics = options.detectHonorifics ?? true;
	const signsSongsStyleRatio = options.signsSongsStyleRatio ?? 0.8;
	const signsSongsLineRatio = options.signsSongsLineRatio ?? 0.1;
	const sdhRatioThreshold = options.sdhRatioThreshold ?? 0.2;
	const sdhMinLines = options.sdhMinLines ?? 10;
	const honorificsMinCount = options.honorificsMinCount ?? 5;
	const honorificsRatio = options.honorificsRatio ?? 3;
	const assumeMislabeled = options.assumeMislabeled ?? true;

	for (const stream of streams) {
		const lang = (stream.language || "").toLowerCase();

		if (lang === "enm" || lang === "en-jp" || lang === "en_jp") {
			const origLang = stream.language;
			stream.language = "en-JP";
			if (origLang !== "en-JP") {
				Logger.info(`[subtitle] Track ${stream.index}: normalizing language "${origLang}" → "en-JP" (honorifics)`);
			}
			const title = stream.title || "";
			if (!SUB_HONORIFICS_PATTERN.test(title)) {
				stream.title = title ? `${title} [Honorifics]` : "Honorifics";
				Logger.info(`[subtitle] Track ${stream.index}: adding [Honorifics] marker based on language code`);
			}
		}

		// Bibliographic -> terminology (ger -> deu, fre -> fra...)
		const normalized = normalizeBibliographicLanguage(stream.language);
		if (normalized && normalized !== stream.language) {
			Logger.info(`[subtitle] Track ${stream.index}: normalizing language "${stream.language}" → "${normalized}" (bibliographic → terminology)`);
			stream.language = normalized;
		}
	}

	// Step 1: Extract & content-analyze
	const contentCache = new Map<number, SubtitleContentAnalysis>();
	const extractions = new Map<number, SubtitleExtraction>();

	const textStreams = streams.filter((s) => isTextSubtitleCodec(s.codec));
	if (textStreams.length > 0) {
		Logger.info(`[subtitle] Analyzing ${textStreams.length} text-based subtitle track(s)`);
	}

	const preExtracted = await extractAllSubtitles(inputPath, textStreams, tempDir, signal);

	for (const stream of textStreams) {
		const pre = preExtracted.get(stream.index);

		let extraction = pre ? await extractSubtitleForAnalysis(inputPath, stream, tempDir, signal, pre) : null;
		if (!extraction) {
			extraction = await extractSubtitleForAnalysis(inputPath, stream, tempDir, signal);
		}
		if (!extraction) continue;

		extractions.set(stream.index, extraction);
		const analysis = analyzeContent(extraction);
		contentCache.set(stream.index, analysis);

		const styleSummary =
			analysis.assStyles != null
				? `, styles: ${analysis.assStyles.dialogueStyleLines}d/${analysis.assStyles.signStyleLines}s/${analysis.assStyles.otherStyleLines}o`
				: "";

		Logger.info(
			`[subtitle] Track ${stream.index} (${stream.language || "und"}, ${stream.codec}): ` +
				`${analysis.dialogueLineCount} lines, ` +
				`SDH ${(analysis.sdhRatio * 100).toFixed(0)}%, ` +
				`honorifics ${analysis.honorificCount}` +
				styleSummary,
		);
	}

	// Step 2: Language detection via language-detector
	for (const stream of textStreams) {
		const extraction = extractions.get(stream.index);
		if (!extraction) continue;

		const titleVariant = extractRegionalVariant(stream);
		if (titleVariant) {
			const origLang = stream.language || "und";
			Logger.info(`[subtitle] Track ${stream.index}: title "${stream.title}" → regional variant ${titleVariant} (from "${origLang}")`);
			stream.language = titleVariant;
			continue;
		}

		const analysis = contentCache.get(stream.index);
		if (analysis?.assStyles) {
			const { signStyleLines, totalLines } = analysis.assStyles;
			if (totalLines >= 5 && signStyleLines / totalLines >= 0.8) {
				Logger.info(`[subtitle] Track ${stream.index}: skipping language detection — ${signStyleLines}/${totalLines} sign/fx lines would confuse detector`);
				continue;
			}
		}

		if (isMalay(stream.language)) {
			Logger.info(
				`[subtitle] Track ${stream.index}: skipping language detection — Malay/Indonesian are too similar to distinguish reliably, trusting "${stream.language}"`,
			);
			stream.language = "msa";
			continue;
		}

		if (isIndonesian(stream.language)) {
			Logger.info(
				`[subtitle] Track ${stream.index}: skipping language detection — Malay/Indonesian are too similar to distinguish reliably, trusting "${stream.language}"`,
			);
			stream.language = "ind";
			continue;
		}

		const dialogueLineCount = analysis?.dialogueLineCount ?? 0;
		const origLangLower = (stream.language || "").toLowerCase();
		const origIsKnown = origLangLower !== "" && origLangLower !== "und";
		if (origIsKnown && dialogueLineCount < MIN_LINES_FOR_LANG_DETECTION) {
			Logger.info(
				`[subtitle] Track ${stream.index}: skipping language detection — only ${dialogueLineCount} dialogue lines, trusting declared "${stream.language}"`,
			);
			continue;
		}

		if (langDetect === "disabled") {
			Logger.info(`[subtitle] Track ${stream.index}: language detector disabled — keeping declared "${stream.language || "und"}"`);
			continue;
		}
		if (langDetect === "und-only" && origIsKnown) {
			Logger.info(`[subtitle] Track ${stream.index}: language detector in "only if undefined" mode — keeping declared "${stream.language}"`);
			continue;
		}

		const result = await detectLanguage(extraction.filePath, signal);

		if (result === null) {
			continue;
		}

		const rawLangCode = result.detected.bcp47 || result.detected.iso_639_2;
		// We don't distinguish between US and GB English (both collapse to "eng").
		const lowerRaw = rawLangCode.toLowerCase();
		const langCode = lowerRaw === "en-us" || lowerRaw === "en-gb" ? "eng" : rawLangCode;

		const confidence = result.detected.confidence;
		const origLang = stream.language || "und";

		if (confidence < langDetectConfidence) {
			Logger.info(
				`[subtitle] Track ${stream.index}: language-detector confidence too low ` +
					`(${(confidence * 100).toFixed(1)}% < ${(langDetectConfidence * 100).toFixed(1)}%) — keeping "${origLang}"`,
			);
			continue;
		}

		const changed = origLang.toLowerCase() !== langCode.toLowerCase();

		Logger[changed ? "warn" : "info"](
			`[subtitle] Track ${stream.index}: language-detector → ${result.detected.language} ` +
				`[${langCode}], ${(confidence * 100).toFixed(1)}% confidence — ` +
				`${changed ? "relabeling" : "confirmed"} from "${origLang}"`,
		);

		stream.language = langCode;
	}

	// Clean up all extracted temp files
	for (const extraction of extractions.values()) {
		cleanupExtraction(extraction);
	}
	extractions.clear();

	// Step 3: Bitmap fallback
	const hasFullEnglishSubs = streams.some((s) => isEnglish(s.language) && detectSubtitleTrackType(s) === "full");
	const hasJapaneseSubs = streams.some((s) => isJapanese(s.language));

	if (assumeMislabeled) {
		if (!hasFullEnglishSubs && hasJapaneseSubs) {
			const hasAnyEnglish = streams.some((s) => isEnglish(s.language));
			const reason = hasAnyEnglish ? "Only Signs & Songs English tracks found" : "No English tracks found (including after language detection)";
			Logger.warn(`[subtitle] ${reason} but Japanese tracks exist — assuming mislabeled, relabeling Japanese to English`);
			for (const s of streams) {
				if (isJapanese(s.language)) {
					s.language = "en";
				}
			}
		}
	}

	// Step 4: ASS style-based Signs & Songs
	if (detectSignsSongs) {
		for (const stream of streams) {
			if (detectSubtitleTrackType(stream) !== "full") continue;

			const analysis = contentCache.get(stream.index);
			if (!analysis?.assStyles) continue;

			const { signStyleLines, dialogueStyleLines, totalLines } = analysis.assStyles;
			if (totalLines >= 5 && signStyleLines / totalLines >= signsSongsStyleRatio && dialogueStyleLines < 50) {
				Logger.warn(
					`[subtitle] Track ${stream.index}: ${signStyleLines}/${totalLines} lines use sign/typeset ` + `ASS styles — reclassifying as Signs & Songs`,
				);
				stream.isForced = true;
			}
		}

		// Step 5: Line-count-based Signs & Songs
		const fullStreams = streams.filter((s) => detectSubtitleTrackType(s) === "full" && contentCache.has(s.index));

		if (fullStreams.length >= 2) {
			const lineCounts = new Map<number, number>();
			for (const s of fullStreams) {
				lineCounts.set(s.index, contentCache.get(s.index)!.dialogueLineCount);
			}

			const maxLines = Math.max(...lineCounts.values());
			for (const [streamIndex, lineCount] of lineCounts) {
				if (maxLines > 0 && lineCount > 0 && lineCount <= maxLines * signsSongsLineRatio && lineCount < 100) {
					const stream = streams.find((s) => s.index === streamIndex);
					if (stream) {
						Logger.warn(`[subtitle] Track ${streamIndex}: only ${lineCount} lines vs ${maxLines} ` + `in largest full track — reclassifying as Signs & Songs`);
						stream.isForced = true;
					}
				}
			}
		}
	}

	// Step 6: SDH content detection
	if (detectSDH) {
		for (const stream of streams) {
			const currentType = detectSubtitleTrackType(stream);
			if (currentType === "sdh" || currentType === "forced") continue;

			const analysis = contentCache.get(stream.index);
			if (!analysis) continue;

			if (analysis.sdhRatio >= sdhRatioThreshold && analysis.dialogueLineCount >= sdhMinLines) {
				Logger.warn(`[subtitle] Track ${stream.index}: ${(analysis.sdhRatio * 100).toFixed(0)}% SDH markers — reclassifying as SDH`);
				stream.isHearingImpaired = true;
			}
		}
	}

	// Step 7: Honorifics detection
	if (detectHonorifics) {
		const englishFullStreams = streams.filter((s) => isEnglish(s.language) && detectSubtitleTrackType(s) === "full" && contentCache.has(s.index));
		const hasExistingHonorifics = streams.some((s) => isEnglish(s.language) && detectSubtitleTrackType(s) === "honorifics");

		if (englishFullStreams.length >= 2 && !hasExistingHonorifics) {
			let maxHonStream: SubtitleStreamInfo | null = null;
			let maxHon = 0;
			let minHon = Infinity;

			for (const stream of englishFullStreams) {
				const count = contentCache.get(stream.index)!.honorificCount;
				if (count > maxHon) {
					maxHon = count;
					maxHonStream = stream;
				}
				if (count < minHon) {
					minHon = count;
				}
			}

			if (maxHonStream && maxHon >= honorificsMinCount && (minHon === 0 || maxHon >= minHon * honorificsRatio)) {
				Logger.warn(`[subtitle] Track ${maxHonStream.index}: ${maxHon} honorific suffixes ` + `(vs ${minHon} in others) — reclassifying as Honorifics`);
				const existingTitle = maxHonStream.title || "";
				if (!SUB_HONORIFICS_PATTERN.test(existingTitle)) {
					maxHonStream.title = existingTitle ? `${existingTitle} [Honorifics]` : "Honorifics";
				}
			}
		}
	}

	// Summary
	const summary = streams.map((s) => {
		const lang = s.language || "und";
		const type = detectSubtitleTrackType(s);
		return `${lang}:${type}`;
	});
	Logger.info(`[subtitle] Final classification: ${summary.join(", ")}`);
}

/**
 * ISO 639-2/B (bibliographic) -> 639-2/T (terminology) mapping.
 *
 * MKV/Matroska prefers terminology codes, and language-detector returns them
 * too.
 */
const BIBLIOGRAPHIC_TO_TERMINOLOGY: Record<string, string> = {
	alb: "sqi", // Albanian
	arm: "hye", // Armenian
	baq: "eus", // Basque
	tib: "bod", // Tibetan
	bur: "mya", // Burmese
	cze: "ces", // Czech
	chi: "zho", // Chinese
	wel: "cym", // Welsh
	dut: "nld", // Dutch
	fre: "fra", // French
	geo: "kat", // Georgian
	ger: "deu", // German
	gre: "ell", // Greek
	ice: "isl", // Icelandic
	mac: "mkd", // Macedonian
	mao: "mri", // Maori
	may: "msa", // Malay
	per: "fas", // Persian
	rum: "ron", // Romanian
	slo: "slk", // Slovak
};

/**
 * Normalize an ISO 639-2/B bibliographic code to its 639-2/T terminology
 * equivalent. Preserves case-style of the input subtag, leaves BCP47 region
 * suffixes alone, and returns non-bibliographic codes unchanged.
 */
export function normalizeBibliographicLanguage(lang: string | undefined): string | undefined {
	if (!lang) return lang;
	const [base, ...rest] = lang.split("-");
	const mapped = BIBLIOGRAPHIC_TO_TERMINOLOGY[base!.toLowerCase()];
	if (!mapped) return lang;
	return rest.length > 0 ? `${mapped}-${rest.join("-")}` : mapped;
}

/**
 * Map a language code (BCP47, ISO 639-1, ISO 639-2/3) to a flag emoji.
 */
export function languageToFlag(lang: string | undefined): string {
	const BCP47_TO_COUNTRY: Record<string, string> = {
		"es-es": "ES",
		"es-419": "MX",
		"es-mx": "MX",
		"es-ar": "AR",
		"es-co": "CO",
		"es-cl": "CL",
		"es-pe": "PE",
		"es-ve": "VE",
		"pt-pt": "PT",
		"pt-br": "BR",
		"fr-fr": "FR",
		"fr-ca": "CA",
		"zh-hant": "TW",
		"zh-hans": "CN",
		"zh-tw": "TW",
		"zh-hk": "HK",
		"zh-cn": "CN",
		"en-gb": "GB",
		"en-us": "US",
		"en-au": "AU",
	};

	const LANG_TO_COUNTRY: Record<string, string> = {
		en: "US",
		ja: "JP",
		de: "DE",
		fr: "FR",
		es: "ES",
		it: "IT",
		pt: "BR",
		ru: "RU",
		zh: "CN",
		ko: "KR",
		ar: "SA",
		hi: "IN",
		th: "TH",
		vi: "VN",
		pl: "PL",
		nl: "NL",
		sv: "SE",
		da: "DK",
		fi: "FI",
		nb: "NO",
		no: "NO",
		cs: "CZ",
		sk: "SK",
		hu: "HU",
		ro: "RO",
		bg: "BG",
		hr: "HR",
		sr: "RS",
		sl: "SI",
		uk: "UA",
		el: "GR",
		tr: "TR",
		he: "IL",
		id: "ID",
		ms: "MY",
		tl: "PH",
		// ISO 639-2/3
		eng: "US",
		jpn: "JP",
		deu: "DE",
		ger: "DE",
		fra: "FR",
		fre: "FR",
		spa: "ES",
		ita: "IT",
		por: "BR",
		rus: "RU",
		zho: "CN",
		chi: "CN",
		kor: "KR",
		ara: "SA",
		hin: "IN",
		tha: "TH",
		vie: "VN",
		pol: "PL",
		nld: "NL",
		dut: "NL",
		swe: "SE",
		dan: "DK",
		fin: "FI",
		nob: "NO",
		nor: "NO",
		ces: "CZ",
		cze: "CZ",
		slk: "SK",
		slo: "SK",
		hun: "HU",
		ron: "RO",
		rum: "RO",
		bul: "BG",
		hrv: "HR",
		srp: "RS",
		slv: "SI",
		ukr: "UA",
		ell: "GR",
		gre: "GR",
		tur: "TR",
		heb: "IL",
		ind: "ID",
		msa: "MY",
		may: "MY",
		tgl: "PH",
		fil: "PH",
		enm: "US", // Middle English (honorifics)
	};

	const GLOBE = "\u{1F310}";

	if (!lang || lang === "und" || lang === "undetermined") return GLOBE;

	const fullLower = lang.toLowerCase();
	const bcp47Country = BCP47_TO_COUNTRY[fullLower];
	if (bcp47Country) {
		return String.fromCodePoint(...[...bcp47Country].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
	}

	const base = lang.split("-")[0]!.toLowerCase();
	const country = LANG_TO_COUNTRY[base];
	if (!country) return GLOBE;

	return String.fromCodePoint(...[...country].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

// Which subtitle types are eligible to carry the Default flag, and in what
// preference order within a language group. Lower = preferred. Types absent
// here (forced, commentary, storyboard) never become Default.
export const SUB_DEFAULT_PRIORITY: Record<string, number> = { full: 0, sdh: 1 };

/** The one stream index that carries the Default flag per language group. */
export function computeSubtitleDefaultIndexByLang(streams: SubtitleStreamInfo[]): Map<string, number> {
	const bestPrio = new Map<string, number>();
	const winner = new Map<string, number>();
	for (const stream of streams) {
		const prio = SUB_DEFAULT_PRIORITY[detectSubtitleTrackType(stream)];
		if (prio === undefined) continue; // forced/commentary/storyboard: skip
		const langGroup = normalizeLanguageGroup(stream.language || "und");
		const cur = bestPrio.get(langGroup);
		if (cur === undefined || prio < cur) {
			bestPrio.set(langGroup, prio);
			winner.set(langGroup, stream.index);
		}
	}
	return winner;
}

/**
 * Compute MKV flags for a subtitle track exactly as the encoder would.
 */
function computeOutputFlags(
	trackType: SubtitleTrackType,
	langGroup: string,
	streamIndex: number,
	defaultIndexByLang: Map<string, number>,
	forcedAssigned: Set<string>,
) {
	const isDefault = defaultIndexByLang.get(langGroup) === streamIndex;
	switch (trackType) {
		case "full":
			return { isDefault, isForced: false, isHearingImpaired: false, isCommentary: false };
		case "sdh":
			return { isDefault, isForced: false, isHearingImpaired: true, isCommentary: false };
		case "honorifics":
			return { isDefault: true, isForced: false, isHearingImpaired: false, isCommentary: false };
		case "forced": {
			const alreadyForced = forcedAssigned.has(langGroup);
			if (!alreadyForced) forcedAssigned.add(langGroup);
			return { isDefault: false, isForced: !alreadyForced, isHearingImpaired: false, isCommentary: false };
		}
		case "commentary":
			return { isDefault: false, isForced: false, isHearingImpaired: false, isCommentary: true };
		default:
			return { isDefault: false, isForced: false, isHearingImpaired: false, isCommentary: false };
	}
}

/**
 * Run the full subtitle analysis pipeline without encoding and return
 * a before/after comparison.
 */
export async function previewSubtitles(
	inputPath: string,
	sourceStreams: SubtitleStreamInfo[],
	tempDir: string,
	options: {
		dedupe?: boolean;
		languages?: string[];
		langDetect?: SubtitleLangDetectMode;
		langDetectConfidence?: number;
		detectSignsSongs?: boolean;
		detectSDH?: boolean;
		detectHonorifics?: boolean;
		// Source / format ordering
		sourcePriority?: SubtitleSourcePriority;
		fansubTiebreak?: SubtitleFansubTiebreak;
		formatPriority?: SubtitleFormatPriority;
		// Drop filters
		dropPicture?: boolean;
		removeSDH?: boolean;
		removeCommentary?: boolean;
		removeForcedSignsSongs?: boolean;
		removeStoryboard?: boolean;
		removeHonorifics?: boolean;
		// Dedupe + naming
		dedupeAcrossFormat?: boolean;
		renameTracks?: boolean;
		// Advanced detection tuning
		signsSongsStyleRatio?: number;
		signsSongsLineRatio?: number;
		sdhRatioThreshold?: number;
		sdhMinLines?: number;
		honorificsMinCount?: number;
		honorificsRatio?: number;
		assumeMislabeled?: boolean;

		languagePriority?: string[];

		// Subtitle translation planning
		translate?: {
			enabled: boolean;
			targetLanguages: string[];
			strategy?: "translategemma" | "generic";
			convertSrtToAss?: boolean;
			organization?: string;
		};
	} = {},
): Promise<SubtitlePreviewResult> {
	const source: SubtitlePreviewTrack[] = sourceStreams.map((s) => {
		const trackType = detectSubtitleTrackType(s);
		return {
			index: s.index,
			codec: s.codec,
			language: s.language || "und",
			flag: languageToFlag(s.language),
			title: s.title || "",
			trackName: s.title || "",
			trackType,
			isDefault: s.isDefault || false,
			isForced: s.isForced || false,
			isHearingImpaired: s.isHearingImpaired || false,
			isCommentary: false,
			isOriginal: s.isOriginal || false,
			isText: isTextSubtitleCodec(s.codec),
			isTranslated: false,
		};
	});

	const cloned: SubtitleStreamInfo[] = filterIgnoredTracks(sourceStreams, DEFAULT_IGNORE_KEYWORD, "subtitle").map((s) => ({
		index: s.index,
		codec: s.codec,
		language: s.language,
		title: s.title,
		isForced: s.isForced,
		isDefault: s.isDefault,
		isHearingImpaired: s.isHearingImpaired,
		isOriginal: s.isOriginal,
	}));

	await analyzeSubtitleStreams(cloned, inputPath, tempDir, {
		langDetect: options.langDetect,
		langDetectConfidence: options.langDetectConfidence,
		detectSignsSongs: options.detectSignsSongs,
		detectSDH: options.detectSDH,
		detectHonorifics: options.detectHonorifics,
		signsSongsStyleRatio: options.signsSongsStyleRatio,
		signsSongsLineRatio: options.signsSongsLineRatio,
		sdhRatioThreshold: options.sdhRatioThreshold,
		sdhMinLines: options.sdhMinLines,
		honorificsMinCount: options.honorificsMinCount,
		honorificsRatio: options.honorificsRatio,
		assumeMislabeled: options.assumeMislabeled,
	});

	const sorted = sortSubtitleStreams(cloned, {
		sourcePriority: options.sourcePriority,
		fansubTiebreak: options.fansubTiebreak,
		formatPriority: options.formatPriority,
	});

	const langFiltered = filterStreamsByLanguage(sorted, options.languages || [], "subtitle");

	const typeFiltered = filterSubtitleTypes(langFiltered, {
		removeSDH: options.removeSDH,
		removeCommentary: options.removeCommentary,
		removeForcedSignsSongs: options.removeForcedSignsSongs,
		removeStoryboard: options.removeStoryboard,
		removeHonorifics: options.removeHonorifics,
		dropPicture: options.dropPicture,
	});

	const finalStreams = options.dedupe ? deduplicateSubtitleStreams(typeFiltered, { acrossFormat: options.dedupeAcrossFormat ?? true }) : typeFiltered;

	const renameTracks = options.renameTracks ?? true;

	const defaultIndexByLang = computeSubtitleDefaultIndexByLang(finalStreams);
	const forcedAssigned = new Set<string>();

	let output: SubtitlePreviewTrack[] = finalStreams.map((s) => {
		const trackType = detectSubtitleTrackType(s);
		const lang = s.language || "und";
		const langGroup = normalizeLanguageGroup(lang);
		const trackName = renameTracks ? buildSubtitleTrackName(trackType, s.title) : s.title || buildSubtitleTrackName(trackType, s.title);

		let effectiveLang = lang;
		if (trackType === "honorifics") effectiveLang = "en-JP";

		const flags = computeOutputFlags(trackType, langGroup, s.index, defaultIndexByLang, forcedAssigned);

		return {
			index: s.index,
			codec: s.codec,
			language: effectiveLang,
			flag: languageToFlag(effectiveLang),
			title: s.title || "",
			trackName,
			trackType,
			...flags,
			isOriginal: s.isOriginal || false,
			isText: isTextSubtitleCodec(s.codec),
			isTranslated: false,
		};
	});

	const t = options.translate;
	if (t?.enabled && (t.targetLanguages?.length ?? 0) > 0) {
		const descriptors: KeptSubDescriptor[] = finalStreams.map((s) => {
			const trackType = detectSubtitleTrackType(s);
			return { index: s.index, codec: s.codec, language: trackType === "honorifics" ? "en-JP" : s.language || "und", trackType };
		});

		const plan = planTargetLanguages(descriptors, t.targetLanguages);

		if (plan.productions.length > 0) {
			const SYNTH_BASE = 1_000_000;

			const synthStreams: SubtitleStreamInfo[] = plan.productions.map((prod, i) => {
				const base = finalStreams.find((s) => s.index === prod.sourceIndex)!;
				const isAss = ["ass", "ssa"].includes(prod.sourceCodec.toLowerCase());
				return {
					...base,
					index: SYNTH_BASE + i,
					codec: isAss || t.convertSrtToAss ? "ass" : "subrip",
					language: prod.targetTag,
					title: buildSubtitleTrackName(prod.trackType, undefined, t.organization),
				};
			});

			const synthTracks: SubtitlePreviewTrack[] = plan.productions.map((prod, i) => ({
				index: SYNTH_BASE + i,
				codec: synthStreams[i]!.codec,
				language: prod.targetTag,
				flag: languageToFlag(prod.targetTag),
				title: "",
				trackName: buildSubtitleTrackName(prod.trackType, undefined, t.organization),
				trackType: prod.trackType,
				// Mirrors computeTranslatedFlagArgs: default for its (new) language, nothing else.
				isDefault: true,
				isForced: false,
				isHearingImpaired: false,
				isCommentary: false,
				isOriginal: false,
				isText: true,
				isTranslated: true,
			}));

			const combined = sortSubtitleStreams([...finalStreams, ...synthStreams], {
				sourcePriority: options.sourcePriority,
				fansubTiebreak: options.fansubTiebreak,
				formatPriority: options.formatPriority,
				languagePriority: options.languagePriority,
			});

			const byIndex = new Map<number, SubtitlePreviewTrack>();
			for (const tk of output) byIndex.set(tk.index, tk);
			for (const tk of synthTracks) byIndex.set(tk.index, tk);
			output = combined.map((s) => byIndex.get(s.index)).filter((x): x is SubtitlePreviewTrack => !!x);
		}
	}

	return { source, output };
}

export function previewAudio(
	sourceStreams: AudioStreamInfo[],
	bitrates: AudioChannelBitrates,
	options: {
		languages?: string[];
		languagePriority?: string[];
		collapseChannels?: boolean;
		dedupe?: boolean;
		removeCommentary?: boolean;
		removeDescriptive?: boolean;
		removeKaraoke?: boolean;
		dropCompatibility?: boolean;
		codecPriority?: AudioCodecPriority;
		preferUncensored?: boolean;
		renameTracks?: boolean;
		trackNameFormat?: string;
		detect?: AudioDetectOptions;
	} = {},
): AudioPreviewResult {
	const detect = options.detect;

	const source: AudioPreviewTrack[] = sourceStreams.map((s) => ({
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

	const ignoredTracks = filterIgnoredTracks(sourceStreams, DEFAULT_IGNORE_KEYWORD, "audio");
	const langFiltered = filterStreamsByLanguage(ignoredTracks, options.languages || [], "audio");
	const typeFiltered = filterAudioTypes(
		langFiltered,
		{
			removeCommentary: options.removeCommentary,
			removeDescriptive: options.removeDescriptive,
			removeKaraoke: options.removeKaraoke,
			dropCompatibility: options.dropCompatibility ?? true,
		},
		detect,
	);
	const sorted = sortAudioStreams(typeFiltered, {
		languagePriority: options.languagePriority,
		preferUncensored: options.preferUncensored,
		detect,
	});
	const finalStreams =
		(options.dedupe ?? true)
			? deduplicateAudioStreams(sorted, {
					collapseChannels: options.collapseChannels,
					codecPriority: options.codecPriority,
					preferUncensored: options.preferUncensored,
					detect,
				})
			: sorted;

	const renameTracks = options.renameTracks ?? false;
	const defaultAssigned = new Set<string>();

	const output: AudioPreviewTrack[] = finalStreams.map((s) => {
		const trackType = detectAudioTrackType(s, detect);
		const lang = s.language || "und";
		const langGroup = normalizeLanguageGroup(lang);
		const layout = normalizeLayout(s.channelLayout, s.channels);

		const isDefault = trackType === "main" && !defaultAssigned.has(langGroup);
		if (isDefault) defaultAssigned.add(langGroup);

		return {
			index: s.index,
			codec: "opus",
			language: lang,
			flag: languageToFlag(lang),
			title: renameTracks ? buildAudioTrackName(trackType, s.title, options.trackNameFormat) : "",
			trackType,
			channels: s.channels,
			channelLayout: layout,
			bitrate: s.bitrate,
			outputBitrate: getOpusBitrateForLayout(layout, bitrates),
			isDefault,
			isOriginal: s.isOriginal || false,
		};
	});

	return { source, output };
}
