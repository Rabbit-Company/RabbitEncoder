import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { createSemaphore } from "../core/concurrency";
import { Logger } from "../core/logger";
import { CancelledError, run } from "../core/process";
import type { JobSettings, SubtitleStreamInfo } from "../core/types";
import { stripCodeFences } from "../translate/generic";
import { chatComplete, type LlmChatOptions } from "../translate/llm-client";
import { resolveTranslateLang } from "../translate/translate-languages";
import { detectSubtitleTrackType, isTextSubtitleCodec } from "../tracks/tracks";
import { parsePgs, type PgsImage } from "./pgs";
import { encodeGrayPng } from "./png";

export const PGS_CODEC = "hdmv_pgs_subtitle";
const OCR_TIMEOUT_MS = 120_000;
/** A track with more unreadable pictures than this share is not used at all. */
const MAX_FAILED_SHARE = 0.1;

/** A vision model is set up, so the OCR tool can run. */
export function ocrConfigured(settings: JobSettings): boolean {
	return !!settings.ocrBaseUrl?.trim() && !!settings.ocrModel?.trim();
}

/** OCR is on for jobs and a vision model is set up. */
export function ocrEnabled(settings: JobSettings): boolean {
	return !!settings.ocrPictureSubtitles && ocrConfigured(settings);
}

const trackKey = (s: SubtitleStreamInfo) => `${resolveTranslateLang(s.language)?.code ?? s.language ?? "und"}:${detectSubtitleTrackType(s)}`;

/**
 * Picture tracks with no text track in their language and kind, one per
 * language and kind. Storyboards are left out. `textStreams` are the tracks
 * the text goes to, when that is another file than the pictures.
 */
export function unreadPictureTracks(streams: SubtitleStreamInfo[], textStreams: SubtitleStreamInfo[] = streams): SubtitleStreamInfo[] {
	const covered = new Set(textStreams.filter((s) => isTextSubtitleCodec(s.codec)).map(trackKey));
	return streams.filter((s) => {
		if (s.codec.toLowerCase() !== PGS_CODEC || detectSubtitleTrackType(s) === "storyboard" || covered.has(trackKey(s))) return false;
		covered.add(trackKey(s));
		return true;
	});
}

/** Flag args for a text track read from a picture track: its own flags, and the default only when `isDefault`. */
export function pictureTrackFlagArgs(flags: { forced?: boolean; hearingImpaired?: boolean; original?: boolean }, type: string, isDefault = false): string[] {
	return [
		"--default-track-flag",
		`0:${isDefault ? 1 : 0}`,
		"--forced-display-flag",
		`0:${flags.forced || type === "forced" ? 1 : 0}`,
		"--hearing-impaired-flag",
		`0:${flags.hearingImpaired || type === "sdh" ? 1 : 0}`,
		"--commentary-flag",
		`0:${type === "commentary" ? 1 : 0}`,
		"--original-flag",
		`0:${flags.original ? 1 : 0}`,
	];
}

export function ocrLlmOptions(settings: JobSettings, signal?: AbortSignal): LlmChatOptions {
	return {
		provider: settings.ocrProvider ?? "openai",
		baseUrl: settings.ocrBaseUrl ?? "",
		apiKey: settings.ocrApiKey || undefined,
		model: settings.ocrModel ?? "",
		temperature: 0,
		maxTokens: 512,
		timeoutMs: OCR_TIMEOUT_MS,
		thinking: "off",
		signal,
	};
}

export function ocrPrompt(language: string | undefined): string {
	const name = resolveTranslateLang(language)?.name;
	return (
		`This image is one subtitle from a film or series${name ? `, in ${name}` : ""}. ` +
		"Write out its text exactly as shown, keeping the line breaks, letters with accents and punctuation. " +
		"Put <i> and </i> around words in italics. Reply with the subtitle text only."
	);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/**
 * Subtitle text from a model's answer. OCR models often answer in HTML or
 * markdown, chat models sometimes add quotes or a label. Italics are kept as
 * <i>, as SRT has them.
 */
export function cleanOcrText(raw: string): string {
	let t = stripCodeFences(raw)
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/?(?:p|div|li|h\d)[^>]*>/gi, "\n")
		.replace(/<(\/?)(?:em|i)(?:\s[^>]*)?>/gi, "<$1i>")
		.replace(/<(?!\/?i>)[^>]+>/g, "")
		.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) =>
			e.startsWith("#x")
				? String.fromCodePoint(parseInt(e.slice(2), 16))
				: e.startsWith("#")
					? String.fromCodePoint(parseInt(e.slice(1), 10))
					: (ENTITIES[e.toLowerCase()] ?? m),
		);
	t = t.replace(/^\s*(?:subtitle|text|transcription)\s*:\s*/i, "");
	const lines = t
		.split(/\r?\n/)
		.map((line) =>
			line
				.trim()
				.replace(/^[*_]{1,2}(.+?)[*_]{1,2}$/, "<i>$1</i>")
				.replace(/^#+\s*/, ""),
		)
		.filter(Boolean);
	let out = lines.join("\n");
	// Quotes around the whole answer are the model's, quotes inside are the subtitle's.
	const quoted = out.match(/^["“„]([^"“”„]*)["”]$/);
	if (quoted) out = quoted[1]!.trim();
	return out.replace(/<i>\s*<\/i>/g, "").trim();
}

function srtTime(ms: number): string {
	const v = Math.max(0, Math.round(ms));
	const p = (n: number, w = 2) => String(n).padStart(w, "0");
	return `${p(Math.floor(v / 3_600_000))}:${p(Math.floor(v / 60_000) % 60)}:${p(Math.floor(v / 1000) % 60)},${p(v % 1000, 3)}`;
}

export function buildOcrSrt(images: PgsImage[], texts: Map<string, string>): string {
	const cues = images.filter((image) => texts.get(image.hash));
	return cues.map((image, i) => `${i + 1}\n${srtTime(image.startMs)} --> ${srtTime(image.endMs)}\n${texts.get(image.hash)}\n`).join("\n");
}

export interface OcrTrackParams {
	inputPath: string;
	stream: SubtitleStreamInfo;
	tempDir: string;
	settings: JobSettings;
	signal?: AbortSignal;
	onProgress?: (done: number, total: number) => void;
}

/**
 * Reads a PGS track with the vision model and returns it as SRT. Pictures
 * shown more than once are read once.
 */
export async function ocrPgsTrack(p: OcrTrackParams): Promise<string> {
	const sup = join(p.tempDir, `ocr_${p.stream.index}.sup`);
	const res = await run(["ffmpeg", "-v", "error", "-y", "-i", p.inputPath, "-map", `0:${p.stream.index}`, "-c:s", "copy", "-f", "sup", sup], {
		signal: p.signal,
	});
	if (p.signal?.aborted) throw new CancelledError();
	if (res.code !== 0 || !existsSync(sup)) throw new Error(`Could not extract picture subtitle track ${p.stream.index}: ${res.stderr.slice(-300)}`);

	const images = parsePgs(new Uint8Array(readFileSync(sup)));
	const unique = [...new Map(images.map((image) => [image.hash, image])).values()];
	if (!unique.length) return "";
	const llm = ocrLlmOptions(p.settings, p.signal);
	const prompt = ocrPrompt(p.stream.language);
	const sem = createSemaphore(Math.max(1, p.settings.ocrConcurrency ?? 4));
	const texts = new Map<string, string>();
	let done = 0;
	let failed = 0;
	let lastError = "";
	p.onProgress?.(0, unique.length);
	await Promise.all(
		unique.map((image) =>
			sem.run(async () => {
				if (p.signal?.aborted) throw new CancelledError();
				try {
					const answer = await chatComplete({ text: prompt, images: [encodeGrayPng(image.pixels, image.width, image.height)] }, llm);
					texts.set(image.hash, cleanOcrText(answer));
				} catch (error) {
					if (p.signal?.aborted) throw new CancelledError();
					failed++;
					lastError = error instanceof Error ? error.message : String(error);
				}
				p.onProgress?.(++done, unique.length);
			}),
		),
	);
	if (failed > Math.max(2, unique.length * MAX_FAILED_SHARE))
		throw new Error(`OCR failed for ${failed} of ${unique.length} subtitle pictures of track ${p.stream.index}: ${lastError}`);
	if (failed) Logger.warn(`[ocr] ${failed} of ${unique.length} pictures of track ${p.stream.index} could not be read and are left out: ${lastError}`);
	Logger.info(`[ocr] Read track ${p.stream.index} (${p.stream.language || "und"}): ${images.length} subtitles, ${unique.length} different pictures`);
	return buildOcrSrt(images, texts);
}
