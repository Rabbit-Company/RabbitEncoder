import { basename, join } from "path";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { Logger } from "../core/logger";
import { CancelledError, run } from "../core/process";
import type { JobSettings, ProbeResult, SubtitleStreamInfo, SubtitleStyle } from "../core/types";
import { probeFile } from "../pipeline/probe";
import { downloadMissingSubtitles, subtitleDownloadEnabled, type DownloadedSubtitle } from "../subsearch/auto";
import { POPULAR_SUBTITLE_LANGUAGES } from "../subsearch/languages";
import { downloadedTrackName } from "../subsearch/naming";
import { detectSubtitleTrackType, buildSubtitleTrackName, isTextSubtitleCodec, type SubtitleTrackType } from "../tracks/tracks";
import { ocrEnabled, ocrPgsTrack, pictureTrackFlagArgs, unreadPictureTracks } from "../ocr/ocr";
import { dialogueStyleNames } from "../subtitles/ass-classifier";
import { styleSrtAss, restyleAssDialogueFont } from "../subtitles/ass-style";
import {
	dialogueLines,
	fillSpeakers,
	planTargetLanguages,
	translateSubtitleContent,
	type KeptSubDescriptor,
	type ReferenceTrack,
	type TimedLine,
} from "./subtitle-translate";
import { createSemaphore } from "../core/concurrency";
import { checkProvider, type LlmChatOptions } from "./llm-client";
import { prepareSeriesNotes } from "./series-notes";
import { normalizeTag, resolveTranslateLang, type TranslateLang } from "./translate-languages";

/**
 * A finished, on-disk translated subtitle ready to hand to mkvmerge. Shaped to
 * slot straight into the encoder's existing subtitle-append loop.
 */
export interface TranslatedTrack {
	/** Path to the translated (and, if applicable, styled) .ass/.srt file. */
	file: string;
	/** MKV language tag for --language (already normalized; caller sanitizes). */
	language: string;
	/** --track-name value (carries the organization as release group). */
	trackName: string;
	trackType: SubtitleTrackType;
	/** mkvmerge flag args (default/forced/etc.) for this track. */
	flagArgs: string[];
	/** "ass" | "srt" - for logging/inspection. */
	format: "ass" | "srt";
	/** Source subtitle stream index this was translated from (for output ordering). -1 for a download. */
	sourceIndex: number;
	/** Downloaded from OpenSubtitles instead of translated. */
	downloaded?: boolean;
	/** Read from a picture subtitle with OCR. */
	ocr?: boolean;
	/** Its dialogue uses the font group, so the final face is applied and attached before muxing. */
	restyle?: boolean;
}

export interface TranslateProgress {
	lang: string;
	langIndex: number;
	langCount: number;
	done: number;
	total: number;
}

export interface RunTranslateStepParams {
	/** Final selected subtitle list (sorted/filtered/deduped) - same list Mux uses. */
	subtitleStreams: SubtitleStreamInfo[];
	inputPath: string;
	tempDir: string;
	settings: JobSettings;
	/**
	 * The subtitle style (with `fontName` already set to the family Mux injects)
	 * used when converting SRT→ASS or restyling ASS, so the translated track
	 * matches the source's final design. Compose it exactly as the Mux styling
	 * pass does, e.g. `{ ...DEFAULT_STYLE_APPEARANCE, fontName: settings.fontGroup }`.
	 */
	subtitleStyle: SubtitleStyle;
	/** Release-group tag to stamp on translated track names (config.organization). */
	organization: string;
	/** Force a specific source stream index (translate-only pipeline). Auto-select when omitted. */
	forceSourceIndex?: number;
	/** Where per-series notes are kept. Without it, no notes are used. */
	seriesNotesDir?: string;
	/** App temp folder, where subtitle downloads are cached. Without it, nothing is downloaded. */
	downloadCacheDir?: string;
	/** The video's place in the library, for its name and .nfo files, when `inputPath` is a staged copy. */
	identityPath?: string;
	/** Probe of the input, used to sync downloads. Probed when missing. */
	probe?: ProbeResult;
	/** Download only, for example when the requested source track is missing. */
	skipAi?: boolean;
	signal?: AbortSignal;
	onProgress?: (p: TranslateProgress) => void;
	/** What the step is doing before translation starts, such as downloading subtitles. */
	onStatus?: (message: string) => void;
	/** Something the user should see although the step finished, such as languages left untranslated. */
	onWarning?: (message: string) => void;
}

/** Flag args for a freshly-created translated track (always the only track in its language). */
export function computeTranslatedFlagArgs(trackType: "full" | "honorifics"): string[] {
	// Both roles are dialogue-bearing and become the default for their (new) language.
	return [
		"--default-track-flag",
		"0:1",
		"--forced-display-flag",
		"0:0",
		"--hearing-impaired-flag",
		"0:0",
		"--commentary-flag",
		"0:0",
		"--original-flag",
		"0:0",
	];
}

/**
 * Flag args for a downloaded track. A full track becomes the default of its
 * language, an SDH one does not, and neither do extra languages, as dozens of
 * default tracks would confuse players.
 */
export function computeDownloadedFlagArgs(hearingImpaired: boolean, isDefault = true): string[] {
	return [
		"--default-track-flag",
		`0:${isDefault && !hearingImpaired ? 1 : 0}`,
		"--forced-display-flag",
		"0:0",
		"--hearing-impaired-flag",
		`0:${hearingImpaired ? 1 : 0}`,
		"--commentary-flag",
		"0:0",
		"--original-flag",
		"0:0",
	];
}

/** Target languages that have no full or honorifics track yet, each once. */
export function missingTargetLanguages(descriptors: KeptSubDescriptor[], targets: string[]): string[] {
	const have = new Set(
		descriptors.filter((d) => d.trackType === "full" || d.trackType === "honorifics").map((d) => resolveTranslateLang(d.language)?.code ?? d.language),
	);
	const out: string[] = [];
	for (const raw of targets) {
		const tag = raw.trim();
		const code = resolveTranslateLang(tag)?.code;
		if (!code || have.has(code)) continue;
		have.add(code);
		out.push(tag);
	}
	return out;
}

/** Synthetic stream numbers for styling downloads, clear of real stream indexes. */
const DOWNLOAD_INDEX_BASE = 900_000;

/** Downloads styled the way native tracks are, as tracks ready to mux. */
async function downloadedTracks(
	found: DownloadedSubtitle[],
	settings: JobSettings,
	subtitleStyle: SubtitleStyle,
	tempDir: string,
	signal?: AbortSignal,
): Promise<TranslatedTrack[]> {
	const out: TranslatedTrack[] = [];
	for (const [i, d] of found.entries()) {
		const trackType = d.hearingImpaired ? "sdh" : "full";
		const styled = await styleSource(
			d.file,
			d.format === "ass" ? "ass" : "subrip",
			trackType,
			settings,
			subtitleStyle,
			tempDir,
			DOWNLOAD_INDEX_BASE + i,
			signal,
		);
		const file = join(tempDir, `downloaded_${d.language}.${styled.format}`);
		writeFileSync(file, styled.content, "utf-8");
		out.push({
			file,
			language: normalizeTag(d.language),
			trackName: downloadedTrackName(trackType, d.release, d.uploader, d.fileName),
			trackType,
			flagArgs: computeDownloadedFlagArgs(d.hearingImpaired, !d.extra),
			format: styled.format,
			sourceIndex: -1,
			downloaded: true,
			restyle: styled.styled,
		});
	}
	return out;
}

/** Step detail for the tracks the Translate step added. */
export function describeAddedSubtitles(tracks: TranslatedTrack[]): string {
	const ocr = tracks.filter((t) => t.ocr).length;
	const downloaded = tracks.filter((t) => t.downloaded).length;
	const translated = tracks.length - downloaded - ocr;
	const parts: string[] = [];
	if (ocr) parts.push(`read ${ocr} with OCR`);
	if (downloaded) parts.push(`downloaded ${downloaded}`);
	if (translated) parts.push(`translated ${translated}`);
	if (!parts.length) return "Nothing to add";
	const text = `${parts.join(", ")} track(s)`;
	return text[0]!.toUpperCase() + text.slice(1);
}

/** Resolve the on-disk format the translated file will have. */
export function resolveOutputFormat(sourceCodec: string, convertSrtToAss: boolean): "ass" | "srt" {
	const c = sourceCodec.toLowerCase();
	if (c === "ass" || c === "ssa") return "ass";
	return convertSrtToAss ? "ass" : "srt";
}

/** Build the descriptors planTargetLanguages consumes, applying the honorifics language convention. */
export function buildKeptDescriptors(
	streams: SubtitleStreamInfo[],
	detectType: (s: SubtitleStreamInfo) => string = (s) => detectSubtitleTrackType(s),
): KeptSubDescriptor[] {
	return streams.map((s) => {
		const trackType = detectType(s);
		const language = trackType === "honorifics" ? "en-JP" : s.language || "und";
		return { index: s.index, codec: s.codec, language, trackType };
	});
}

/**
 * Extract a single subtitle track from the source to a text file. ASS is copied
 * verbatim (design preserved); everything else is transcoded to SRT.
 */
async function extractSource(
	inputPath: string,
	stream: SubtitleStreamInfo,
	tempDir: string,
	signal?: AbortSignal,
): Promise<{ path: string; codec: string } | null> {
	const ocrFile = ocrFiles.get(stream);
	if (ocrFile) return { path: ocrFile, codec: "subrip" };
	const isAss = ["ass", "ssa"].includes(stream.codec.toLowerCase());
	const ext = isAss ? "ass" : "srt";
	const out = join(tempDir, `translate_src_${stream.index}.${ext}`);
	const codecArgs = isAss ? ["-c:s", "copy"] : ["-c:s", "srt"];
	const res = await run(
		["ffmpeg", "-y", "-i", inputPath, "-map", `0:${stream.index}`, ...codecArgs, "-vn", "-an", "-map_chapters", "-1", "-map_metadata", "-1", out],
		{ signal },
	);
	if (res.code !== 0 || !existsSync(out)) {
		Logger.warn(`[translate] Failed to extract source track ${stream.index}: ${res.stderr || res.stdout}`);
		return null;
	}
	return { path: out, codec: stream.codec };
}

/**
 * Apply the same styling the native track would receive, so the translated
 * track matches the source's final design. SRT→ASS conversion and ASS dialogue
 * restyle mirror the Mux settings. Returns the styled content + final format.
 *
 * `styled` tells whether the dialogue font was set here. The final face, its
 * family name and the group's appearance are applied later by
 * `finishAddedTracks`, once the fonts kept in the output are known.
 */
export async function styleSource(
	srcPath: string,
	sourceCodec: string,
	trackType: string,
	settings: JobSettings,
	subtitleStyle: SubtitleStyle,
	tempDir: string,
	streamIndex: number,
	signal?: AbortSignal,
): Promise<{ content: string; format: "ass" | "srt"; styled: boolean }> {
	const c = sourceCodec.toLowerCase();
	const isAss = c === "ass" || c === "ssa";
	const isSrt = c === "subrip" || c === "srt";

	if (isSrt && settings.convertSrtToAss) {
		const assPath = join(tempDir, `translate_src_${streamIndex}.conv.ass`);
		const r = await run(["ffmpeg", "-y", "-i", srcPath, "-map", "0:s:0", "-c:s", "ass", assPath], { signal });
		if (r.code === 0 && existsSync(assPath)) {
			const styled = styleSrtAss(readFileSync(assPath, "utf-8"), subtitleStyle);
			return { content: styled, format: "ass", styled: true };
		}
		Logger.warn(`[translate] SRT→ASS conversion failed for source ${streamIndex}; translating as SRT`);
		return { content: readFileSync(srcPath, "utf-8"), format: "srt", styled: false };
	}

	if (isAss) {
		const content = readFileSync(srcPath, "utf-8");
		const targets = new Set(settings.assRestyleTargets ?? []);
		if (settings.restyleAssFont && targets.has(trackType))
			return { content: restyleAssDialogueFont(content, subtitleStyle, true), format: "ass", styled: true };
		return { content, format: "ass", styled: false };
	}

	return { content: readFileSync(srcPath, "utf-8"), format: "srt", styled: false };
}

function llmOptions(settings: JobSettings, signal?: AbortSignal): LlmChatOptions {
	return {
		provider: settings.translateProvider ?? "openai",
		baseUrl: settings.translateBaseUrl,
		apiKey: settings.translateApiKey || undefined,
		model: settings.translateModel,
		timeoutMs: settings.translateTimeoutMs,
		maxTokens: settings.translateMaxTokens,
		thinking: settings.translateThinking,
		signal,
	};
}

const REFERENCE_TYPES = ["full", "honorifics", "sdh"];

/** Best dialogue-bearing text track in this language, other than the source. */
export function findReferenceTrack(streams: SubtitleStreamInfo[], language: string, sourceIndex: number): SubtitleStreamInfo | undefined {
	const want = resolveTranslateLang(language)?.code;
	if (!want) return undefined;
	return streams
		.filter((s) => s.index !== sourceIndex && isTextSubtitleCodec(s.codec) && resolveTranslateLang(s.language)?.code === want)
		.map((s) => ({ s, rank: REFERENCE_TYPES.indexOf(detectSubtitleTrackType(s)) }))
		.filter((c) => c.rank >= 0)
		.sort((a, b) => a.rank - b.rank)[0]?.s;
}

/** Reads the timed dialogue of subtitle tracks, extracting each track only once. */
function trackReader(inputPath: string, tempDir: string, signal?: AbortSignal): (stream: SubtitleStreamInfo) => Promise<TimedLine[]> {
	const cache = new Map<number, Promise<TimedLine[]>>();
	return (stream) => {
		let lines = cache.get(stream.index);
		if (!lines) {
			lines = (async () => {
				const extracted = await extractSource(inputPath, stream, tempDir, signal);
				if (!extracted) return [];
				const content = readFileSync(extracted.path, "utf-8");
				const format = ["ass", "ssa"].includes(extracted.codec.toLowerCase()) ? "ass" : "srt";
				const styles = format === "ass" ? dialogueStyleNames(content) : new Set<string>();
				return dialogueLines(content, format, (style) => styles.has(style));
			})();
			cache.set(stream.index, lines);
		}
		return lines;
	};
}

/** A donor must name at least this share of its dialogue, or its few names would be noise. */
const MIN_NAMED_SHARE = 0.5;

function isAssCodec(codec: string): boolean {
	return ["ass", "ssa"].includes(codec.toLowerCase());
}

interface HelperTracks {
	references: ReferenceTrack[];
	speakerDonors: TimedLine[][];
}

/**
 * Reference tracks for the requested languages, and tracks that can name
 * speakers the source leaves unnamed: same-language tracks first, since their
 * names are spelled like the source's, then the reference tracks.
 */
async function loadHelperTracks(
	streams: SubtitleStreamInfo[],
	source: SubtitleStreamInfo,
	sourceLang: TranslateLang,
	referenceLanguages: string[],
	read: (stream: SubtitleStreamInfo) => Promise<TimedLine[]>,
): Promise<HelperTracks> {
	const references: ReferenceTrack[] = [];
	const referenceStreams: SubtitleStreamInfo[] = [];
	const seen = new Set<string>([sourceLang.code]);
	for (const language of referenceLanguages) {
		const lang = resolveTranslateLang(language);
		if (!lang || seen.has(lang.code)) continue;
		seen.add(lang.code);
		const stream = findReferenceTrack(streams, language, source.index);
		if (!stream) {
			Logger.info(`[translate] No ${lang.name} text subtitle track to use as a reference`);
			continue;
		}
		const lines = await read(stream);
		if (lines.length === 0) continue;
		Logger.info(`[translate] Using ${lang.name} track ${stream.index} as a reference (${lines.length} lines)`);
		references.push({ lang, lines });
		referenceStreams.push(stream);
	}

	const speakerDonors: TimedLine[][] = [];
	const sameLanguage = streams
		.filter((s) => s.index !== source.index && resolveTranslateLang(s.language)?.code === sourceLang.code)
		.map((s) => ({ s, rank: REFERENCE_TYPES.indexOf(detectSubtitleTrackType(s)) }))
		.filter((c) => c.rank >= 0)
		.sort((a, b) => a.rank - b.rank)
		.map((c) => c.s);
	for (const stream of [...sameLanguage, ...referenceStreams]) {
		if (!isAssCodec(stream.codec)) continue;
		const lines = await read(stream);
		const named = lines.filter((l) => l.name?.trim()).length;
		if (lines.length === 0 || named / lines.length < MIN_NAMED_SHARE) continue;
		Logger.info(`[translate] Track ${stream.index} can name speakers (${named}/${lines.length} lines named)`);
		speakerDonors.push(lines);
	}
	return { references, speakerDonors };
}

export interface PrepareNotesForFileParams {
	inputPath: string;
	/** All subtitle streams of the file, analyzed, to find tracks that name speakers. */
	streams: SubtitleStreamInfo[];
	/** Source subtitle track, picked the way a translate job would pick it. */
	stream: SubtitleStreamInfo;
	source: TranslateLang;
	referenceLanguages: string[];
	tempDir: string;
	settings: JobSettings;
	seriesNotesDir: string;
	signal?: AbortSignal;
}

/**
 * Create or extend the series notes from one episode without translating it,
 * so they can be reviewed before a batch runs. The episode counts as used.
 */
export async function prepareSeriesNotesForFile(p: PrepareNotesForFileParams): Promise<string | undefined> {
	const read = trackReader(p.inputPath, p.tempDir, p.signal);
	const lines = await read(p.stream);
	if (lines.length === 0) throw new Error(`Could not read dialogue from subtitle track ${p.stream.index}`);
	const { speakerDonors } = await loadHelperTracks(p.streams, p.stream, p.source, p.referenceLanguages, read);
	fillSpeakers(lines, speakerDonors);
	return prepareSeriesNotes({
		dir: p.seriesNotesDir,
		filename: basename(p.inputPath),
		source: p.source,
		lines,
		llm: llmOptions(p.settings, p.signal),
	});
}

/**
 * The Translate pipeline step. Selects a source track (honorifics preferred,
 * else the top text track), extracts + styles it once, and produces one
 * translated track per missing target language. Returns finished tracks for the
 * caller to append at mux time.
 *
 * Missing languages are downloaded from OpenSubtitles first when that is set
 * up, and only the rest are translated.
 *
 * Throws if translation is enabled but llm is unreachable or the model is
 * missing (the user explicitly asked to translate; shipping without it silently
 * would be worse). When some languages were downloaded, the job keeps them
 * instead and reports the failure through `onWarning`.
 */
export async function runTranslateStep(params: RunTranslateStepParams): Promise<TranslatedTrack[]> {
	const { inputPath, tempDir, settings, subtitleStyle, signal } = params;

	const targets = settings.translateTargetLanguages ?? [];
	const extraCount = settings.subtitleDownloadExtraLanguages ?? 0;
	const translating = settings.translateSubtitles && (targets.length > 0 || extraCount > 0);
	const ocr = ocrEnabled(settings);
	if (!translating && !ocr) return [];

	// Text read from picture subtitles counts as a track the file has, and can be translated from.
	const read = ocr ? await ocrPictureTracks(params) : { tracks: [], streams: [], byPictureIndex: new Map<number, number>() };
	if (!translating) return read.tracks;
	const subtitleStreams = [...params.subtitleStreams, ...read.streams];
	const forced = params.forceSourceIndex;
	params = { ...params, subtitleStreams, forceSourceIndex: forced !== undefined ? (read.byPictureIndex.get(forced) ?? forced) : undefined };

	const descriptors = buildKeptDescriptors(subtitleStreams);

	// Subtitles people made beat machine translation, so missing languages are downloaded first.
	const download = subtitleDownloadEnabled(settings) && !!params.downloadCacheDir;
	let downloaded: TranslatedTrack[] = [];
	if (download) {
		const probe = params.probe ?? (await probeFile(inputPath));
		const base = {
			inputPath,
			identityPath: params.identityPath ?? inputPath,
			probe,
			settings,
			cacheDir: params.downloadCacheDir!,
			workDir: join(tempDir, "subtitle-download"),
			signal,
			onStatus: params.onStatus,
		};
		const missing = missingTargetLanguages(descriptors, targets);
		// The most used languages come after the targets, so they never take the targets' quota.
		const targetCodes = new Set(targets.map((t) => resolveTranslateLang(t)?.code));
		const extras = missingTargetLanguages(descriptors, POPULAR_SUBTITLE_LANGUAGES.slice(0, extraCount)).filter(
			(t) => !targetCodes.has(resolveTranslateLang(t)?.code),
		);
		if (missing.length || extras.length) {
			params.onStatus?.(`Searching OpenSubtitles for ${[...missing, ...(extras.length ? [`${extras.length} more languages`] : [])].join(", ")}`);
			const found = await downloadMissingSubtitles({ ...base, languages: missing, extraLanguages: extras });
			downloaded = await downloadedTracks(found, settings, subtitleStyle, tempDir, signal);
		}
	}
	const kept = [...read.tracks, ...downloaded];
	const covered = new Set(downloaded.map((t) => resolveTranslateLang(t.language)?.code));
	const aiTargets = missingTargetLanguages(descriptors, targets).filter((t) => !covered.has(resolveTranslateLang(t)?.code));
	if (params.skipAi || (download && settings.subtitleDownloadAiFallback === false) || aiTargets.length === 0) {
		if (aiTargets.length) Logger.info(`[translate] Not translating ${aiTargets.join(", ")} with AI`);
		return kept;
	}

	try {
		return [...kept, ...(await translateWithAi(params, descriptors, aiTargets, downloaded))];
	} catch (error) {
		// Subtitles already made are kept when the AI provider fails, so an encode is not lost for one language.
		if (!kept.length || error instanceof CancelledError || signal?.aborted) throw error;
		const warning = `AI translation failed, ${aiTargets.join(", ")} not translated: ${error instanceof Error ? error.message : String(error)}`;
		Logger.warn(`[translate] ${warning}`);
		params.onWarning?.(warning);
		return kept;
	}
}

/** Synthetic stream numbers for text read from picture subtitles, clear of real stream indexes. */
const OCR_INDEX_BASE = 800_000;
/** The SRT read from a picture subtitle, by the synthetic stream standing in for it. */
const ocrFiles = new WeakMap<SubtitleStreamInfo, string>();

interface OcrRead {
	tracks: TranslatedTrack[];
	/** Text streams standing in for the picture tracks, for choosing translation sources. */
	streams: SubtitleStreamInfo[];
	/** Synthetic stream index by the picture track it was read from. */
	byPictureIndex: Map<number, number>;
}

/**
 * Reads every picture subtitle (PGS) whose language and kind has no text
 * track yet. A track that cannot be read is reported and left out.
 */
async function ocrPictureTracks(params: RunTranslateStepParams): Promise<OcrRead> {
	const { subtitleStreams, inputPath, tempDir, settings, subtitleStyle, signal } = params;
	const pictures = unreadPictureTracks(subtitleStreams);
	const read: OcrRead = { tracks: [], streams: [], byPictureIndex: new Map() };
	for (const [n, stream] of pictures.entries()) {
		const label = `track ${stream.index} (${stream.language || "und"})`;
		try {
			const srt = await ocrPgsTrack({
				inputPath,
				stream,
				tempDir,
				settings,
				signal,
				onProgress: (done, total) => params.onStatus?.(`Reading picture subtitles ${n + 1}/${pictures.length} with OCR, ${done}/${total}`),
			});
			if (!srt.trim()) continue;
			const type = detectSubtitleTrackType(stream);
			const raw = join(tempDir, `ocr_${stream.index}.srt`);
			writeFileSync(raw, srt, "utf-8");
			const synthetic: SubtitleStreamInfo = { ...stream, index: OCR_INDEX_BASE + stream.index, codec: "subrip" };
			ocrFiles.set(synthetic, raw);
			read.streams.push(synthetic);
			read.byPictureIndex.set(stream.index, synthetic.index);
			const styled = await styleSource(raw, "subrip", type, settings, subtitleStyle, tempDir, synthetic.index, signal);
			const file = join(tempDir, `ocr_${stream.index}.final.${styled.format}`);
			writeFileSync(file, styled.content, "utf-8");
			read.tracks.push({
				file,
				language: stream.language || "und",
				trackName: buildSubtitleTrackName(type, stream.title, "OCR"),
				trackType: type,
				flagArgs: pictureTrackFlagArgs({ forced: stream.isForced, hearingImpaired: stream.isHearingImpaired, original: stream.isOriginal }, type),
				format: styled.format,
				sourceIndex: stream.index,
				ocr: true,
				restyle: styled.styled,
			});
		} catch (error) {
			if (error instanceof CancelledError || signal?.aborted) throw new CancelledError();
			const warning = `OCR of picture subtitle ${label} failed: ${error instanceof Error ? error.message : String(error)}`;
			Logger.warn(`[ocr] ${warning}`);
			params.onWarning?.(warning);
		}
	}
	return read;
}

/** Translates the target languages no download covered. */
async function translateWithAi(
	params: RunTranslateStepParams,
	descriptors: KeptSubDescriptor[],
	aiTargets: string[],
	downloaded: TranslatedTrack[],
): Promise<TranslatedTrack[]> {
	const { subtitleStreams, inputPath, tempDir, settings, subtitleStyle, organization, forceSourceIndex, seriesNotesDir, signal, onProgress } = params;
	const provider = settings.translateProvider ?? "openai";
	const model = settings.translateModel;

	const plan = planTargetLanguages(descriptors, aiTargets, { forceSourceIndex });
	for (const note of plan.skipped) Logger.info(`[translate] Skipped ${note}`);
	if (plan.productions.length === 0) {
		Logger.info("[translate] Nothing to translate (all target languages already present or unsupported)");
		return [];
	}

	// Preflight: fail fast with a clear message rather than shipping untranslated.
	const health = await checkProvider({ provider, baseUrl: settings.translateBaseUrl, apiKey: settings.translateApiKey || undefined, model }, signal);
	if (!health.ok) {
		throw new Error(`Subtitle translation is enabled but ${health.detail}`);
	}

	// All productions share one source track (planTargetLanguages guarantees it).
	const sourceIndex = plan.productions[0]!.sourceIndex;
	const sourceStream = subtitleStreams.find((s) => s.index === sourceIndex);
	if (!sourceStream || !isTextSubtitleCodec(sourceStream.codec)) {
		Logger.warn("[translate] Source track is missing or not text-based. Skipping translation.");
		return [];
	}

	const extracted = await extractSource(inputPath, sourceStream, tempDir, signal);
	if (!extracted) return [];

	const sourceTrackType = detectSubtitleTrackType(sourceStream);
	const {
		content: styledSource,
		format,
		styled: sourceStyled,
	} = await styleSource(extracted.path, extracted.codec, sourceTrackType, settings, subtitleStyle, tempDir, sourceStream.index, signal);

	const dialogueStyles = format === "ass" ? dialogueStyleNames(styledSource) : new Set<string>();
	const isDialogueStyle = (style: string) => dialogueStyles.has(style);

	const llmBase = llmOptions(settings, signal);

	const { references, speakerDonors } = await loadHelperTracks(
		subtitleStreams,
		sourceStream,
		plan.productions[0]!.source,
		settings.translateReferenceLanguages ?? [],
		trackReader(inputPath, tempDir, signal),
	);
	addDownloadedReferences(references, downloaded, plan.productions[0]!.source, settings.translateReferenceLanguages ?? []);

	let notes: string | undefined;
	if (seriesNotesDir && settings.translateSeriesNotes !== false) {
		const lines = dialogueLines(styledSource, format, isDialogueStyle);
		fillSpeakers(lines, speakerDonors);
		notes = await prepareSeriesNotes({ dir: seriesNotesDir, filename: basename(inputPath), source: plan.productions[0]!.source, lines, llm: llmBase });
	}

	const out: TranslatedTrack[] = new Array(plan.productions.length);
	const langCount = plan.productions.length;

	// ONE budget for every in-flight llm request - across all target languages
	// AND all chunks within each language. Languages and chunks fan out freely;
	// this cap keeps total requests <= what the server can serve in parallel.
	const sem = createSemaphore(Math.max(1, settings.translateConcurrency ?? 1));

	// Aggregate progress across concurrently-running languages.
	const perLangDone = new Array<number>(langCount).fill(0);
	const perLangTotal = new Array<number>(langCount).fill(0);
	const emitProgress = (li: number, lang: string) => {
		let done = 0;
		let total = 0;
		for (let i = 0; i < langCount; i++) {
			done += perLangDone[i]!;
			total += perLangTotal[i]!;
		}
		onProgress?.({ lang, langIndex: li, langCount, done, total });
	};

	await Promise.all(
		plan.productions.map(async (prod, li) => {
			const translated = await translateSubtitleContent(styledSource, {
				format,
				batchSize: settings.translateBatchSize,
				translateSignsSongs: settings.translateSignsSongs,
				isDialogueStyle,
				llm: { ...llmBase, source: prod.source, target: prod.target, notes },
				contextLines: settings.translateContextLines ?? 10,
				references,
				speakerDonors,
				sem,
				onProgress: (done, total) => {
					perLangDone[li] = done;
					perLangTotal[li] = total;
					emitProgress(li, prod.target.name);
				},
			});

			const ext = format === "ass" ? "ass" : "srt";
			const file = join(tempDir, `translated_${prod.targetTag}_${sourceStream.index}.${ext}`);
			writeFileSync(file, translated, "utf-8");

			out[li] = {
				file,
				language: prod.targetTag,
				trackName: buildSubtitleTrackName(prod.trackType, undefined, organization),
				trackType: prod.trackType,
				flagArgs: computeTranslatedFlagArgs(prod.trackType),
				format,
				sourceIndex: sourceStream.index,
				restyle: sourceStyled,
			};

			Logger.info(`[translate] Produced ${prod.target.name} (${prod.trackType}) from track ${sourceStream.index}`);
		}),
	);

	return out;
}

/** Downloads in a reference language the file lacked serve as references too. */
function addDownloadedReferences(references: ReferenceTrack[], downloaded: TranslatedTrack[], source: TranslateLang, referenceLanguages: string[]): void {
	const wanted = new Set(referenceLanguages.map((l) => resolveTranslateLang(l)?.code).filter(Boolean));
	for (const track of downloaded) {
		const lang = resolveTranslateLang(track.language);
		if (!lang || !wanted.has(lang.code) || lang.code === source.code || references.some((r) => r.lang.code === lang.code)) continue;
		const content = readFileSync(track.file, "utf-8");
		const styles = track.format === "ass" ? dialogueStyleNames(content) : new Set<string>();
		const lines = dialogueLines(content, track.format, (style) => styles.size === 0 || styles.has(style));
		if (!lines.length) continue;
		Logger.info(`[translate] Using the downloaded ${lang.name} subtitle as a reference (${lines.length} lines)`);
		references.push({ lang, lines });
	}
}

// Output ordering

/** One subtitle track's mkvmerge parameters, ready to append. */
export interface SubtitleEmit {
	language: string;
	trackName: string;
	flagArgs: string[];
	file: string;
}

export interface NativeEmitItem {
	stream: SubtitleStreamInfo;
	emit: SubtitleEmit;
}
export interface TranslatedEmitItem {
	sourceIndex: number;
	emit: SubtitleEmit;
}

const SYNTH_INDEX_BASE = 1_000_000;

/**
 * Order native + translated subtitle tracks identically to how native tracks
 * alone would be ordered. Each translated track is represented as a synthetic
 * stream cloned from its source (so every field the comparator reads is
 * populated), with language/title swapped to the target + organization group.
 * The real `sortSubtitleStreams` comparator is injected and run over the
 * combined set, then results map back to their mkvmerge args by index.
 *
 * Result: translated languages slot into the normal priority order - the only
 * visible difference is the organization release-group tag in their name.
 */
export function orderOutputSubtitles(
	natives: NativeEmitItem[],
	translated: TranslatedEmitItem[],
	sourceStreams: SubtitleStreamInfo[],
	sort: (streams: SubtitleStreamInfo[]) => SubtitleStreamInfo[],
): SubtitleEmit[] {
	const byIndex = new Map<number, SubtitleEmit>();
	const streams: SubtitleStreamInfo[] = [];

	for (const n of natives) {
		streams.push(n.stream);
		byIndex.set(n.stream.index, n.emit);
	}

	translated.forEach((t, i) => {
		const base = sourceStreams.find((s) => s.index === t.sourceIndex) ?? natives[0]?.stream;
		const synthIndex = SYNTH_INDEX_BASE + i;
		const codec = t.emit.file.toLowerCase().endsWith(".ass") ? "ass" : "subrip";
		const synth: SubtitleStreamInfo = {
			...(base as SubtitleStreamInfo),
			index: synthIndex,
			language: t.emit.language,
			title: t.emit.trackName,
			codec,
		};
		streams.push(synth);
		byIndex.set(synthIndex, t.emit);
	});

	const ordered = sort(streams);
	const out: SubtitleEmit[] = [];
	for (const s of ordered) {
		const emit = byIndex.get(s.index);
		if (emit) out.push(emit);
	}
	return out;
}
