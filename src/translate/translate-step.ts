import { join } from "path";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { Logger } from "../core/logger";
import { run } from "../core/process";
import type { JobSettings, SubtitleStreamInfo, SubtitleStyle } from "../core/types";
import { detectSubtitleTrackType, buildSubtitleTrackName, isTextSubtitleCodec } from "../tracks/tracks";
import { dialogueStyleNames } from "../subtitles/ass-classifier";
import { styleSrtAss, restyleAssDialogueFont } from "../subtitles/ass-style";
import { planTargetLanguages, translateSubtitleContent, type KeptSubDescriptor, type TranslateContentOptions } from "./subtitle-translate";
import { createSemaphore } from "../core/concurrency";
import { checkProvider, type LlmChatOptions } from "./llm-client";
import type { GenericOptions } from "./generic";

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
	trackType: "full" | "honorifics";
	/** mkvmerge flag args (default/forced/etc.) for this track. */
	flagArgs: string[];
	/** "ass" | "srt" - for logging/inspection. */
	format: "ass" | "srt";
	/** Source subtitle stream index this was translated from (for output ordering). */
	sourceIndex: number;
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
	signal?: AbortSignal;
	onProgress?: (p: TranslateProgress) => void;
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
 * Font-family note: restyle injects `restyleFamily` (the family Mux attaches).
 * In the rare case Mux picks a numbered alias due to a same-named source font,
 * the family can differ - logged, and libass falls back gracefully.
 */
async function styleSource(
	srcPath: string,
	sourceCodec: string,
	trackType: string,
	settings: JobSettings,
	subtitleStyle: SubtitleStyle,
	tempDir: string,
	streamIndex: number,
	signal?: AbortSignal,
): Promise<{ content: string; format: "ass" | "srt" }> {
	const c = sourceCodec.toLowerCase();
	const isAss = c === "ass" || c === "ssa";
	const isSrt = c === "subrip" || c === "srt";

	if (isSrt && settings.convertSrtToAss) {
		const assPath = join(tempDir, `translate_src_${streamIndex}.conv.ass`);
		const r = await run(["ffmpeg", "-y", "-i", srcPath, "-map", "0:s:0", "-c:s", "ass", assPath], { signal });
		if (r.code === 0 && existsSync(assPath)) {
			const styled = styleSrtAss(readFileSync(assPath, "utf-8"), subtitleStyle);
			return { content: styled, format: "ass" };
		}
		Logger.warn(`[translate] SRT→ASS conversion failed for source ${streamIndex}; translating as SRT`);
		return { content: readFileSync(srcPath, "utf-8"), format: "srt" };
	}

	if (isAss) {
		let content = readFileSync(srcPath, "utf-8");
		const targets = new Set(settings.assRestyleTargets ?? []);
		if (settings.restyleAssFont && targets.has(trackType)) {
			content = restyleAssDialogueFont(content, subtitleStyle, true);
		}
		return { content, format: "ass" };
	}

	return { content: readFileSync(srcPath, "utf-8"), format: "srt" };
}

/**
 * The Translate pipeline step. Selects a source track (honorifics preferred,
 * else the top text track), extracts + styles it once, and produces one
 * translated track per missing target language. Returns finished tracks for the
 * caller to append at mux time.
 *
 * Throws if translation is enabled but llm is unreachable or the model is
 * missing (the user explicitly asked to translate; shipping without it silently
 * would be worse).
 */
export async function runTranslateStep(params: RunTranslateStepParams): Promise<TranslatedTrack[]> {
	const { subtitleStreams, inputPath, tempDir, settings, subtitleStyle, organization, forceSourceIndex, signal, onProgress } = params;

	const targets = settings.translateTargetLanguages ?? [];
	if (!settings.translateSubtitles || targets.length === 0) return [];

	const provider = settings.translateProvider ?? "openai";
	const model = settings.translateModel;

	const descriptors = buildKeptDescriptors(subtitleStreams);
	const plan = planTargetLanguages(descriptors, targets, { forceSourceIndex });
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
	const { content: styledSource, format } = await styleSource(
		extracted.path,
		extracted.codec,
		sourceTrackType,
		settings,
		subtitleStyle,
		tempDir,
		sourceStream.index,
		signal,
	);

	const dialogueStyles = format === "ass" ? dialogueStyleNames(styledSource) : new Set<string>();

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
				isDialogueStyle: (style) => dialogueStyles.has(style),
				llm: {
					source: prod.source,
					target: prod.target,
					provider,
					baseUrl: settings.translateBaseUrl,
					apiKey: settings.translateApiKey || undefined,
					model,
					timeoutMs: settings.translateTimeoutMs,
					maxTokens: settings.translateMaxTokens,
					signal,
				},
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
			};

			Logger.info(`[translate] Produced ${prod.target.name} (${prod.trackType}) from track ${sourceStream.index}`);
		}),
	);

	return out;
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
