import { mkdirSync, rmSync, statSync, unlinkSync } from "fs";
import { basename, join, parse as parsePath } from "path";
import type { AppConfig, Job, JobSettings, JobStep, SubtitleStreamInfo, TranslateSourceMatch } from "../core/types";
import { probeFile } from "./probe";
import { Logger } from "../core/logger";
import { CancelledError, humanSize, run } from "../core/process";
import { analyzeSubtitleStreams, detectSubtitleTrackType, isTextSubtitleCodec, normalizeLanguageGroup, sanitizeLanguageTag } from "../tracks/tracks";
import { resolveTranslateLang } from "../translate/translate-languages";
import { buildKeptDescriptors, describeAddedSubtitles, missingTargetLanguages, runTranslateStep, type TranslatedTrack } from "../translate/translate-step";
import { subtitleDownloadEnabled } from "../subsearch/auto";
import { ocrEnabled, PGS_CODEC } from "../ocr/ocr";
import { prepareRemuxAddition } from "../subtitles/added-tracks";
import { seriesNotesDir } from "../translate/series-notes";
import { DEFAULT_STYLE_APPEARANCE } from "../subtitles/subtitle-style"; // NOTE: match the import path encoder.ts uses for DEFAULT_STYLE_APPEARANCE
import { finalizeOutput } from "./output";
import { mkvtoolnixProgress } from "./prepare-progress";
import { identifyMatroska } from "./repair";

/**
 * Translate-only pipeline (`subtitleProcessing === "translate"`).
 *
 * Adds missing subtitle languages to a file WITHOUT touching anything else:
 * no video encode, no audio encode, no subtitle filtering/dedupe/reordering.
 * Implemented as an mkvmerge append: `mkvmerge -o out in.mkv new1.ass new2.ass`
 * copies every existing track, attachment (fonts!), chapter and tag 1:1, so
 * translated ASS keeps its styling for free and nothing can be corrupted.
 * --track-order slots the new tracks among the existing subtitles by language
 * priority without moving any existing track.
 *
 */

const T_ANALYZE = 0;
const T_TRANSLATE = 1;
const T_MUX = 2;
const T_WRITE = 3;

function makeSteps(): JobStep[] {
	return [
		{ label: "Analyze", status: "pending", progress: 0 },
		{ label: "Translate", status: "pending", progress: 0 },
		{ label: "Mux", status: "pending", progress: 0 },
		{ label: "Write Output", status: "pending", progress: 0 },
	];
}

/** Language group for priority matching, so "slv", "sl" and "sl-SI" count as one. */
function languageGroup(lang: string | undefined): string {
	return resolveTranslateLang(lang)?.code ?? normalizeLanguageGroup(lang);
}

interface PriorityKey {
	rank: number;
	/** Group name, used to sort languages alphabetically within "*". */
	alpha: string;
}

/** Sort key from the subtitle language priority ("*" = the rest, alphabetically). */
function priorityKey(priority: string[]): (lang: string | undefined) => PriorityKey {
	const wildcard = priority.findIndex((p) => p === "*");
	const groups = priority.map((p) => (p === "*" ? "*" : languageGroup(p)));
	return (lang) => {
		const group = languageGroup(lang);
		const idx = groups.indexOf(group);
		if (idx >= 0) return { rank: idx, alpha: "" };
		return { rank: wildcard >= 0 ? wildcard : priority.length, alpha: group };
	};
}

function compareKeys(a: PriorityKey, b: PriorityKey): number {
	return a.rank - b.rank || a.alpha.localeCompare(b.alpha);
}

/** Order freshly translated tracks among themselves by the subtitle language priority. */
export function orderTranslatedByPriority<T extends Pick<TranslatedTrack, "language">>(tracks: T[], priority: string[]): T[] {
	const key = priorityKey(priority);
	return [...tracks].sort((a, b) => compareKeys(key(a.language), key(b.language)) || a.language.localeCompare(b.language));
}

export interface ExistingTrack {
	id: number;
	type: string;
	language?: string;
}

/**
 * mkvmerge --track-order for appending translated subtitles. Existing tracks
 * keep their order. Each new track (file i + 1, track 0) goes right after the
 * last subtitle track that sorts before or with it, or before the first
 * subtitle track when none does.
 */
export function planTrackOrder(existing: ExistingTrack[], addedLanguages: string[], priority: string[]): string {
	const key = priorityKey(priority);
	const entries: Array<{ ref: string; key?: PriorityKey }> = existing.map((t) => ({
		ref: `0:${t.id}`,
		key: t.type === "subtitles" ? key(t.language) : undefined,
	}));
	addedLanguages.forEach((lang, i) => {
		const k = key(lang);
		let at = -1;
		let firstSub = -1;
		entries.forEach((e, idx) => {
			if (!e.key) return;
			if (firstSub < 0) firstSub = idx;
			if (compareKeys(e.key, k) <= 0) at = idx + 1;
		});
		if (at < 0) at = firstSub >= 0 ? firstSub : entries.length;
		entries.splice(at, 0, { ref: `${i + 1}:0`, key: k });
	});
	return entries.map((e) => e.ref).join(",");
}

const ANY_TYPE_PREFERENCE = ["full", "honorifics", "sdh"];

/**
 * First text track in the requested language and kind. Track indexes differ
 * between episodes, so batch translation picks the source this way instead.
 */
export function findTranslateSource(streams: SubtitleStreamInfo[], match: TranslateSourceMatch): SubtitleStreamInfo | undefined {
	const want = resolveTranslateLang(match.language)?.code;
	if (!want) return undefined;
	const candidates = streams.filter((s) => isTextSubtitleCodec(s.codec) && resolveTranslateLang(s.language)?.code === want);
	if (match.type !== "any") return candidates.find((s) => detectSubtitleTrackType(s) === match.type);
	const rank = (s: SubtitleStreamInfo) => {
		const idx = ANY_TYPE_PREFERENCE.indexOf(detectSubtitleTrackType(s));
		return idx >= 0 ? idx : ANY_TYPE_PREFERENCE.length;
	};
	return [...candidates].sort((a, b) => rank(a) - rank(b))[0];
}

/** Detect each subtitle track's language and kind, so the source match sees what a job would. */
export async function analyzeForTranslate(
	subtitleStreams: SubtitleStreamInfo[],
	inputPath: string,
	tempDir: string,
	settings: JobSettings,
	signal?: AbortSignal,
): Promise<void> {
	await analyzeSubtitleStreams(
		subtitleStreams,
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
}

export async function runTranslateOnlyJob(job: Job, config: AppConfig, updateJob: (partial: Partial<Job>) => void, signal?: AbortSignal): Promise<void> {
	const tempDir = join(config.tempDir, job.id);
	mkdirSync(tempDir, { recursive: true });

	const steps = makeSteps();

	function setStep(idx: number, partial: Partial<JobStep>) {
		const step = steps[idx]!;

		if (partial.status === "active" && step.status !== "active") {
			step.startedAt = Date.now();
			step.finishedAt = undefined;
		}

		if ((partial.status === "done" || partial.status === "error") && step.status !== "done" && step.status !== "error") {
			step.finishedAt = Date.now();
			if (!step.startedAt) step.startedAt = step.finishedAt;
		}

		Object.assign(step, partial);
		const overall = steps.reduce((sum, s) => sum + s.progress, 0) / steps.length;
		const activeStep = steps.find((s) => s.status === "active");

		updateJob({
			steps: [...steps],
			progress: Math.round(overall * 100) / 100,
			currentStage: activeStep?.label || job.currentStage,
		});
	}

	function checkCancelled() {
		if (signal?.aborted) throw new CancelledError();
	}

	try {
		// Analyze
		checkCancelled();
		setStep(T_ANALYZE, { status: "active", progress: 0 });
		updateJob({ status: "probing" });

		const probe = await probeFile(job.inputPath);
		updateJob({ probe });

		const subtitleStreams: SubtitleStreamInfo[] = probe.subtitleStreams ?? [];
		const canDownload = subtitleDownloadEnabled(job.settings);
		if (subtitleStreams.length === 0 && !canDownload) {
			throw new Error("No subtitle streams found. Nothing to translate from.");
		}
		// Without a source track the job can still download subtitles, it only skips AI translation.
		let noSource = subtitleStreams.length === 0 ? "the file has no subtitle track to translate from" : "";

		setStep(T_ANALYZE, { progress: 30, detail: `Analyzing ${subtitleStreams.length} subtitle track(s)` });

		await analyzeForTranslate(subtitleStreams, job.inputPath, tempDir, job.settings, signal);

		let forceSourceIndex: number | undefined;
		const pick = job.settings.translateSourceTrack;
		if (typeof pick === "number") {
			const stream = subtitleStreams.find((s) => s.index === pick);
			if (!stream) {
				Logger.warn(`[translate-only] Selected source track ${pick} not found. Falling back to auto selection.`);
			} else if (!isTextSubtitleCodec(stream.codec) && !(ocrEnabled(job.settings) && stream.codec.toLowerCase() === PGS_CODEC)) {
				throw new Error(
					`Selected source subtitle track ${pick} is image-based (${stream.codec}) and cannot be translated. Pick a text-based track, or turn on OCR for PGS.`,
				);
			} else {
				forceSourceIndex = pick;
			}
		} else if (job.settings.translateSourceMatch) {
			const match = job.settings.translateSourceMatch;
			// A picture track can be the source too, once OCR has read it.
			const pictures = ocrEnabled(job.settings)
				? subtitleStreams.filter((s) => s.codec.toLowerCase() === PGS_CODEC).map((s) => ({ ...s, codec: "subrip" }))
				: [];
			const stream = findTranslateSource(subtitleStreams, match) ?? findTranslateSource(pictures, match);
			const kind = match.type === "any" ? "text" : match.type;
			if (stream) forceSourceIndex = stream.index;
			else if (canDownload) {
				noSource = `there is no ${kind} text subtitle track in "${match.language}" to translate from`;
				Logger.warn(`[translate-only] Only downloading, ${noSource}`);
			} else throw new Error(`No ${kind} text subtitle track in "${match.language}" found to translate from.`);
		}

		setStep(T_ANALYZE, { status: "done", progress: 100, detail: `${subtitleStreams.length} track(s) analyzed` });

		// Translate
		checkCancelled();
		setStep(T_TRANSLATE, { status: "active", progress: 0 });
		updateJob({ status: "encoding_video" });

		const targets = job.settings.translateTargetLanguages ?? [];
		if (targets.length === 0) {
			throw new Error("Translate-only job has no target languages configured");
		}

		const translated = await runTranslateStep({
			subtitleStreams,
			inputPath: job.inputPath,
			tempDir,
			settings: { ...job.settings, translateSubtitles: true },
			subtitleStyle: { ...DEFAULT_STYLE_APPEARANCE, fontName: job.settings.fontGroup },
			organization: config.organization,
			forceSourceIndex,
			seriesNotesDir: seriesNotesDir(config),
			downloadCacheDir: config.tempDir,
			probe,
			skipAi: !!noSource,
			signal,
			onStatus: (message) => setStep(T_TRANSLATE, { detail: message }),
			onWarning: (warning) => updateJob({ warning }),
			onProgress: ({ done, total }) => {
				const overall = total > 0 ? Math.round((done / total) * 100) : 0;
				setStep(T_TRANSLATE, { progress: overall, detail: `Translating ${done}/${total} lines` });
			},
		});

		if (noSource && job.settings.subtitleDownloadAiFallback !== false) {
			const added = new Set(translated.map((t) => resolveTranslateLang(t.language)?.code));
			const left = missingTargetLanguages(buildKeptDescriptors(subtitleStreams), targets).filter((t) => !added.has(resolveTranslateLang(t)?.code));
			if (left.length) updateJob({ warning: `${left.join(", ")} not added: no good subtitle to download, and ${noSource}` });
		}

		setStep(T_TRANSLATE, {
			status: "done",
			progress: 100,
			detail: describeAddedSubtitles(translated),
		});

		// Mux
		checkCancelled();
		setStep(T_MUX, { status: "active", progress: 0 });
		updateJob({ status: "muxing" });

		const stem = parsePath(job.filename).name;

		let outputPath: string;

		if (translated.length === 0) {
			if (job.replaceSource) {
				setStep(T_MUX, { status: "done", progress: 100, detail: "Nothing to translate. Source unchanged." });
				setStep(T_WRITE, { status: "done", progress: 100, detail: "Source unchanged" });
				updateJob({
					status: "done",
					currentStage: "Complete",
					progress: 100,
					outputFilename: job.filename,
					encodedFileSize: humanSize(statSync(job.inputPath).size),
					finishedAt: Date.now(),
				});
				try {
					rmSync(tempDir, { recursive: true, force: true });
				} catch {}
				return;
			}

			setStep(T_MUX, { status: "done", progress: 100, detail: "Nothing to mux" });
			setStep(T_WRITE, { status: "active", progress: 0, detail: "Writing output" });
			updateJob({ status: "writing_output" });
			outputPath = await finalizeOutput(job, config, job.inputPath, job.filename, signal, (progress, detail) => {
				setStep(T_WRITE, { progress, detail });
			});
		} else {
			const finalOutput = join(tempDir, "final.mkv");
			const ordered = orderTranslatedByPriority(translated, job.settings.subtitleLanguagePriority);

			const identified = await identifyMatroska(job.inputPath, signal);
			const existing: ExistingTrack[] = (identified.tracks ?? []).map((t) => ({
				id: t.id,
				type: t.type,
				language: t.properties.language_ietf || t.properties.language,
			}));
			const trackOrder = planTrackOrder(
				existing,
				ordered.map((t) => t.language),
				job.settings.subtitleLanguagePriority,
			);

			setStep(T_MUX, { progress: 2, detail: "Preparing fonts" });
			const addition = await prepareRemuxAddition(job.inputPath, ordered, job.settings, tempDir, signal);
			checkCancelled();

			const mkvArgs = ["mkvmerge", "-o", finalOutput, job.inputPath];
			for (const track of ordered) {
				mkvArgs.push("--language", `0:${sanitizeLanguageTag(track.language, `translated ${track.language}`)}`);
				mkvArgs.push("--track-name", `0:${track.trackName}`);
				mkvArgs.push(...track.flagArgs);
				mkvArgs.push(...(addition.compressionArgs.get(track.file) ?? []));
				mkvArgs.push(track.file);
			}
			mkvArgs.push(...addition.fontArgs);
			mkvArgs.push("--track-order", trackOrder);

			setStep(T_MUX, { progress: 5, detail: `Adding ${ordered.length} track(s)` });
			Logger.info(`[translate-only] Muxing: ${ordered.map((t) => t.language).join(", ")} → ${basename(job.inputPath)}`);

			const res = await run([mkvArgs[0]!, "--gui-mode", ...mkvArgs.slice(1)], {
				signal,
				onStdoutLine: (line) => {
					const percent = mkvtoolnixProgress(line);
					if (percent !== null) setStep(T_MUX, { progress: Math.max(5, percent), detail: `Adding ${ordered.length} translated track(s)` });
				},
			});
			checkCancelled();
			// mkvmerge: 0 = ok, 1 = completed with warnings, 2 = error.
			if (res.code !== 0 && res.code !== 1) {
				throw new Error(`mkvmerge failed (exit ${res.code}): ${(res.stderr || res.stdout).trim().slice(-500)}`);
			}
			if (res.code === 1) {
				Logger.warn(`[translate-only] mkvmerge finished with warnings: ${(res.stderr || res.stdout).trim().slice(-300)}`);
			}

			setStep(T_MUX, { status: "done", progress: 100 });
			setStep(T_WRITE, { status: "active", progress: 0, detail: "Writing output" });
			updateJob({ status: "writing_output" });

			const outputFilename = `${stem}.mkv`;
			outputPath = await finalizeOutput(job, config, finalOutput, outputFilename, signal, (progress, detail) => {
				setStep(T_WRITE, { progress, detail });
			});

			if (!job.replaceSource) {
				try {
					unlinkSync(job.inputPath);
				} catch {}
			}
		}

		const finalName = basename(outputPath);

		setStep(T_WRITE, { status: "done", progress: 100 });

		updateJob({
			status: "done",
			currentStage: "Complete",
			progress: 100,
			outputFilename: job.replaceSource ? finalName : job.relativePath ? `${job.relativePath}/${finalName}` : finalName,
			encodedFileSize: humanSize(statSync(outputPath).size),
			finishedAt: Date.now(),
		});

		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	} catch (err: any) {
		Logger.error(err?.message);
		const activeIdx = steps.findIndex((s) => s.status === "active");
		if (activeIdx >= 0) steps[activeIdx]!.status = "error";

		if (err instanceof CancelledError) {
			updateJob({
				status: "cancelled",
				currentStage: "Cancelled",
				steps: [...steps],
			});
		} else {
			updateJob({
				status: "error",
				currentStage: "Failed",
				steps: [...steps],
				error: err?.message || String(err),
			});
		}

		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {}

		if (err instanceof CancelledError) throw err;
	}
}
