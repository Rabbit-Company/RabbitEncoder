import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "fs";
import { basename, extname, join, parse as parsePath } from "path";
import type { AppConfig, Job, JobStep, SubtitleAddPlan, SubtitleAddTrack } from "../core/types";
import { Logger } from "../core/logger";
import { CancelledError, humanSize, run } from "../core/process";
import { sanitizeLanguageTag } from "../tracks/tracks";
import { finalizeOutput } from "./output";
import { mkvtoolnixProgress } from "./prepare-progress";
import { identifyMatroska } from "./repair";
import { computeDownloadedFlagArgs, styleSource } from "../translate/translate-step";
import { DEFAULT_STYLE_APPEARANCE } from "../subtitles/subtitle-style";
import { prepareRemuxAddition, type AddedTrack } from "../subtitles/added-tracks";
import { orderTranslatedByPriority, planTrackOrder, type ExistingTrack } from "./translate-only";

const S_MUX = 0;
const S_WRITE = 1;

export function describeSubtitleAddPlan(plan: SubtitleAddPlan): string {
	return `Adding ${plan.tracks.map((t) => t.language).join(", ")} subtitles`;
}

/**
 * Appends downloaded subtitles to a video with mkvmerge, which copies every
 * other track, attachment, chapter and tag unchanged, then replaces the video.
 */
export async function runSubtitleAddJob(job: Job, config: AppConfig, updateJob: (partial: Partial<Job>) => void, signal?: AbortSignal): Promise<void> {
	const plan = job.subtitleAddPlan!;
	const tempDir = join(config.tempDir, job.id);
	mkdirSync(tempDir, { recursive: true });
	const steps: JobStep[] = [
		{ label: "Mux", status: "pending", progress: 0 },
		{ label: "Write Output", status: "pending", progress: 0 },
	];
	const setStep = (idx: number, partial: Partial<JobStep>) => {
		const step = steps[idx]!;
		if (partial.status === "active" && step.status !== "active") step.startedAt = Date.now();
		if ((partial.status === "done" || partial.status === "error") && !step.finishedAt) step.finishedAt = Date.now();
		Object.assign(step, partial);
		updateJob({
			steps: [...steps],
			progress: Math.round((steps.reduce((sum, s) => sum + s.progress, 0) / steps.length) * 100) / 100,
			currentStage: steps.find((s) => s.status === "active")?.label || job.currentStage,
		});
	};

	try {
		const missing = plan.tracks.filter((t) => !existsSync(t.file));
		if (missing.length) throw new Error("The downloaded subtitles are no longer available. Search again.");

		setStep(S_MUX, { status: "active", progress: 0, detail: "Styling subtitles" });
		updateJob({ status: "muxing" });
		// The same styling native tracks get: SRT to ASS and the dialogue font, per the settings.
		const styled: Array<SubtitleAddTrack & AddedTrack> = [];
		for (const [i, track] of plan.tracks.entries()) {
			const ass = extname(track.file).toLowerCase() === ".ass";
			const style = { ...DEFAULT_STYLE_APPEARANCE, fontName: job.settings.fontGroup };
			const result = await styleSource(track.file, ass ? "ass" : "subrip", track.hearingImpaired ? "sdh" : "full", job.settings, style, tempDir, i, signal);
			const file = join(tempDir, `added_${i}.styled.${result.format}`);
			writeFileSync(file, result.content, "utf-8");
			styled.push({ ...track, file, format: result.format, restyle: result.styled });
		}
		const addition = await prepareRemuxAddition(plan.targetPath, styled, job.settings, tempDir, signal);
		if (signal?.aborted) throw new CancelledError();

		setStep(S_MUX, { progress: 5, detail: describeSubtitleAddPlan(plan) });
		const ordered = orderTranslatedByPriority(styled, job.settings.subtitleLanguagePriority);
		const identified = await identifyMatroska(plan.targetPath, signal);
		const existing: ExistingTrack[] = (identified.tracks ?? []).map((t) => ({
			id: t.id,
			type: t.type,
			language: t.properties.language_ietf || t.properties.language,
		}));
		const finalOutput = join(tempDir, "final.mkv");
		const args = ["mkvmerge", "--gui-mode", "-o", finalOutput, plan.targetPath];
		for (const track of ordered) {
			args.push("--language", `0:${sanitizeLanguageTag(track.language, `downloaded ${track.language}`)}`);
			args.push("--track-name", `0:${track.trackName}`, "--sub-charset", "0:UTF-8");
			args.push(...computeDownloadedFlagArgs(track.hearingImpaired, !track.extra), ...(addition.compressionArgs.get(track.file) ?? []), track.file);
		}
		args.push(...addition.fontArgs);
		args.push(
			"--track-order",
			planTrackOrder(
				existing,
				ordered.map((t) => t.language),
				job.settings.subtitleLanguagePriority,
			),
		);
		Logger.info(`[subsearch] Muxing ${ordered.map((t) => t.language).join(", ")} into ${basename(plan.targetPath)}`);
		const res = await run(args, {
			signal,
			onStdoutLine: (line) => {
				const percent = mkvtoolnixProgress(line);
				if (percent !== null) setStep(S_MUX, { progress: percent });
			},
		});
		if (signal?.aborted) throw new CancelledError();
		if (res.code !== 0 && res.code !== 1) throw new Error(`mkvmerge failed (exit ${res.code}): ${(res.stderr || res.stdout).trim().slice(-500)}`);
		setStep(S_MUX, { status: "done", progress: 100 });

		setStep(S_WRITE, { status: "active", progress: 0, detail: "Writing output" });
		updateJob({ status: "writing_output" });
		const outputPath = await finalizeOutput(job, config, finalOutput, `${parsePath(plan.targetPath).name}.mkv`, signal, (progress, detail) =>
			setStep(S_WRITE, { progress, detail }),
		);
		setStep(S_WRITE, { status: "done", progress: 100 });
		updateJob({
			status: "done",
			currentStage: "Complete",
			progress: 100,
			outputFilename: basename(outputPath),
			encodedFileSize: humanSize(statSync(outputPath).size),
			finishedAt: Date.now(),
		});
	} catch (err: any) {
		const active = steps.findIndex((s) => s.status === "active");
		if (active >= 0) steps[active]!.status = "error";
		if (err instanceof CancelledError) {
			updateJob({ status: "cancelled", currentStage: "Cancelled", steps: [...steps] });
			throw err;
		}
		Logger.error(err?.message);
		updateJob({ status: "error", currentStage: "Failed", steps: [...steps], error: err?.message || String(err) });
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
		if (job.status === "done" || job.status === "cancelled") rmSync(plan.workDir, { recursive: true, force: true });
	}
}
