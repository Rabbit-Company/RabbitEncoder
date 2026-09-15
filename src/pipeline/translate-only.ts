import { mkdirSync, rmSync, statSync, unlinkSync } from "fs";
import { basename, join, parse as parsePath } from "path";
import type { AppConfig, Job, JobStep, SubtitleStreamInfo } from "../core/types";
import { probeFile } from "./probe";
import { Logger } from "../core/logger";
import { CancelledError, humanSize, run } from "../core/process";
import { analyzeSubtitleStreams, isTextSubtitleCodec, normalizeLanguageGroup, sanitizeLanguageTag } from "../tracks/tracks";
import { runTranslateStep, type TranslatedTrack } from "../translate/translate-step";
import { DEFAULT_STYLE_APPEARANCE } from "../subtitles/subtitle-style"; // NOTE: match the import path encoder.ts uses for DEFAULT_STYLE_APPEARANCE
import { finalizeOutput } from "./output";

/**
 * Translate-only pipeline (`subtitleProcessing === "translate"`).
 *
 * Adds missing subtitle languages to a file WITHOUT touching anything else:
 * no video encode, no audio encode, no subtitle filtering/dedupe/reordering.
 * Implemented as an mkvmerge append: `mkvmerge -o out in.mkv new1.ass new2.ass`
 * copies every existing track, attachment (fonts!), chapter and tag 1:1, so
 * translated ASS keeps its styling for free and nothing can be corrupted.
 *
 */

const T_ANALYZE = 0;
const T_TRANSLATE = 1;
const T_MUX = 2;

function makeSteps(): JobStep[] {
	return [
		{ label: "Analyze", status: "pending", progress: 0 },
		{ label: "Translate", status: "pending", progress: 0 },
		{ label: "Mux & Finish", status: "pending", progress: 0 },
	];
}

/**
 * Order freshly-translated tracks among themselves by the configured subtitle
 * language priority ("*" = the rest, alphabetically). They are appended after
 * all existing tracks; interleaving them INTO the existing track order would
 * require a full remux with explicit --track-order over re-probed IDs, which
 * translate-only deliberately avoids (v1).
 */
export function orderTranslatedByPriority(tracks: TranslatedTrack[], priority: string[]): TranslatedTrack[] {
	const wildcard = priority.findIndex((p) => p === "*");
	const rank = (lang: string): number => {
		const group = normalizeLanguageGroup(lang);
		const idx = priority.findIndex((p) => p !== "*" && normalizeLanguageGroup(p) === group);
		if (idx >= 0) return idx;
		return wildcard >= 0 ? wildcard : priority.length;
	};
	return [...tracks].sort((a, b) => rank(a.language) - rank(b.language) || a.language.localeCompare(b.language));
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
		if (subtitleStreams.length === 0) {
			throw new Error("No subtitle streams found. Nothing to translate from.");
		}

		setStep(T_ANALYZE, { progress: 30, detail: `Analyzing ${subtitleStreams.length} subtitle track(s)` });

		await analyzeSubtitleStreams(
			subtitleStreams,
			job.inputPath,
			tempDir,
			{
				langDetect: job.settings.subtitleLangDetect,
				langDetectConfidence: job.settings.subtitleLangDetectConfidence,
				detectSignsSongs: job.settings.detectSignsSongs,
				detectSDH: job.settings.detectSDH,
				detectHonorifics: job.settings.detectHonorifics,
				signsSongsStyleRatio: job.settings.signsSongsStyleRatio,
				signsSongsLineRatio: job.settings.signsSongsLineRatio,
				sdhRatioThreshold: job.settings.sdhRatioThreshold,
				sdhMinLines: job.settings.sdhMinLines,
				honorificsMinCount: job.settings.honorificsMinCount,
				honorificsRatio: job.settings.honorificsRatio,
				assumeMislabeled: job.settings.assumeMislabeledTracks,
			},
			signal,
		);

		let forceSourceIndex: number | undefined;
		const pick = job.settings.translateSourceTrack;
		if (typeof pick === "number") {
			const stream = subtitleStreams.find((s) => s.index === pick);
			if (!stream) {
				Logger.warn(`[translate-only] Selected source track ${pick} not found. Falling back to auto selection.`);
			} else if (!isTextSubtitleCodec(stream.codec)) {
				throw new Error(`Selected source subtitle track ${pick} is image-based (${stream.codec}) and cannot be translated. Pick a text-based track.`);
			} else {
				forceSourceIndex = pick;
			}
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
			signal,
			onProgress: ({ done, total }) => {
				const overall = total > 0 ? Math.round((done / total) * 100) : 0;
				setStep(T_TRANSLATE, { progress: overall, detail: `Translating ${done}/${total} lines` });
			},
		});

		setStep(T_TRANSLATE, {
			status: "done",
			progress: 100,
			detail: translated.length ? `Added ${translated.length} track(s)` : "Nothing to translate",
		});

		// Mux & Finish
		checkCancelled();
		setStep(T_MUX, { status: "active", progress: 0 });
		updateJob({ status: "muxing" });

		const stem = parsePath(job.filename).name;

		let outputPath: string;

		if (translated.length === 0) {
			if (job.replaceSource) {
				setStep(T_MUX, { status: "done", progress: 100, detail: "Nothing to translate. Source unchanged." });
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

			setStep(T_MUX, { progress: 50, detail: "Nothing to translate. Moving to output." });
			outputPath = await finalizeOutput(job, config, job.inputPath, job.filename, signal);
		} else {
			const finalOutput = join(tempDir, "final.mkv");
			const ordered = orderTranslatedByPriority(translated, job.settings.subtitleLanguagePriority);

			const mkvArgs = ["mkvmerge", "-o", finalOutput, job.inputPath];
			for (const track of ordered) {
				mkvArgs.push("--language", `0:${sanitizeLanguageTag(track.language, `translated ${track.language}`)}`);
				mkvArgs.push("--track-name", `0:${track.trackName}`);
				mkvArgs.push(...track.flagArgs);
				mkvArgs.push(track.file);
			}

			setStep(T_MUX, { progress: 20, detail: `Appending ${ordered.length} translated track(s)` });
			Logger.info(`[translate-only] Muxing: ${ordered.map((t) => t.language).join(", ")} → ${basename(job.inputPath)}`);

			const res = await run(mkvArgs, { signal });
			checkCancelled();
			// mkvmerge: 0 = ok, 1 = completed with warnings, 2 = error.
			if (res.code !== 0 && res.code !== 1) {
				throw new Error(`mkvmerge failed (exit ${res.code}): ${(res.stderr || res.stdout).trim().slice(-500)}`);
			}
			if (res.code === 1) {
				Logger.warn(`[translate-only] mkvmerge finished with warnings: ${(res.stderr || res.stdout).trim().slice(-300)}`);
			}

			setStep(T_MUX, { progress: 85, detail: "Moving to output" });

			const outputFilename = `${stem}.mkv`;
			outputPath = await finalizeOutput(job, config, finalOutput, outputFilename, signal);

			if (!job.replaceSource) {
				try {
					unlinkSync(job.inputPath);
				} catch {}
			}
		}

		const finalName = basename(outputPath);

		setStep(T_MUX, { status: "done", progress: 100 });

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
