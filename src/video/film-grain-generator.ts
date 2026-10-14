import { randomUUID } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "fs";
import { join } from "path";
import type { AppConfig, FilmGrainSampling, FilmGrainRange, Job } from "../core/types";
import { CancelledError } from "../core/process";
import { probeFile } from "../pipeline/probe";
import { filmGrainSegmentCount, writeRepresentativeFilmGrainTable } from "./film-grain-table";
import { parseRegrainEvent, progressFromEvent, type FilmGrainProgress, type RegrainEvent } from "./film-grain-progress";
import { Logger } from "../core/logger";
import { detectFilmGrainCrop } from "./film-grain-crop";
import { representativeFilmGrainWindow } from "./film-grain-window";

export interface GeneratedFilmGrainTable {
	tablePath: string;
	segments: number;
}

/** A film grain table generation started by hand from a job's advanced settings. */
export interface FilmGrainRun {
	status: "running" | "done" | "error" | "cancelled";
	sourcePath: string;
	sampling: FilmGrainSampling;
	range: FilmGrainRange;
	startedAt: number;
	finishedAt?: number;
	progress?: FilmGrainProgress;
	tablePath?: string;
	segments?: number;
	error?: string;
}

const active = new Map<string, Promise<GeneratedFilmGrainTable>>();

/** True when the job is set to measure its own table and does not have one yet. */
export function needsFilmGrainTable(job: Job): boolean {
	return (
		job.autoFilmGrain === true &&
		!!job.originalSourcePath &&
		job.settings.videoEncode === "av1" &&
		job.settings.subtitleProcessing !== "translate" &&
		(!job.settings.filmGrainTablePath || !existsSync(job.settings.filmGrainTablePath))
	);
}

export async function generateFilmGrainTable(
	job: Job,
	config: AppConfig,
	sourcePath: string,
	sampling: FilmGrainSampling,
	range: FilmGrainRange,
	signal?: AbortSignal,
	onProgress?: (progress: FilmGrainProgress) => void,
): Promise<GeneratedFilmGrainTable> {
	// regrain uses every core, so a job never has two runs at once. A run that
	// is being cancelled has to stop before the next one starts.
	while (active.has(job.id)) await active.get(job.id)!.catch(() => {});
	const promise = generate(job, config, sourcePath, sampling, range, signal, onProgress).finally(() => {
		if (active.get(job.id) === promise) active.delete(job.id);
	});
	active.set(job.id, promise);
	return promise;
}

/** Measure the table for a job that needs one and store its path in the job settings. */
export async function ensureFilmGrainTable(
	job: Job,
	config: AppConfig,
	signal?: AbortSignal,
	onProgress?: (progress: FilmGrainProgress) => void,
): Promise<void> {
	if (!needsFilmGrainTable(job)) return;
	try {
		const generated = await generateFilmGrainTable(
			job,
			config,
			job.originalSourcePath!,
			job.settings.filmGrainSampling,
			job.settings.filmGrainRange ?? "full",
			signal,
			onProgress,
		);
		job.settings.filmGrainTablePath = generated.tablePath;
	} catch (error) {
		if (error instanceof CancelledError) throw error;
		throw new Error(`Film grain table generation failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

// Regrain measures with every frame at "all", and reads only part of the video at the other levels.
const SCAN: Record<FilmGrainSampling, string> = { all: "full", half: "half", quarter: "quarter", eighth: "eighth" };

async function runRegrain(
	cmd: string[],
	signal?: AbortSignal,
	onProgress?: (progress: FilmGrainProgress) => void,
): Promise<{ code: number; summary?: Extract<RegrainEvent, { event: "summary" }>; error?: Extract<RegrainEvent, { event: "error" }>; stderr: string }> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	// regrain stops its ffmpeg processes and removes partial output on SIGTERM.
	const onAbort = () => {
		try {
			proc.kill("SIGTERM");
		} catch {}
		killTimer = setTimeout(() => {
			try {
				proc.kill("SIGKILL");
			} catch {}
		}, 5000);
	};
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });
	let summary: Extract<RegrainEvent, { event: "summary" }> | undefined;
	let error: Extract<RegrainEvent, { event: "error" }> | undefined;
	const stderrText = new Response(proc.stderr).text();
	try {
		const decoder = new TextDecoder();
		let buffered = "";
		for await (const chunk of proc.stdout) {
			buffered += decoder.decode(chunk, { stream: true });
			let newline: number;
			while ((newline = buffered.indexOf("\n")) >= 0) {
				const event = parseRegrainEvent(buffered.slice(0, newline));
				buffered = buffered.slice(newline + 1);
				if (event?.event === "progress") onProgress?.(progressFromEvent(event));
				else if (event?.event === "summary") summary = event;
				else if (event?.event === "error") error = event;
			}
		}
		const code = await proc.exited;
		return { code, summary, error, stderr: (await stderrText).trim().slice(-2000) };
	} finally {
		if (killTimer) clearTimeout(killTimer);
		signal?.removeEventListener("abort", onAbort);
	}
}

function regrainErrorText(error: Extract<RegrainEvent, { event: "error" }> | undefined, stderr: string, code: number): string {
	if (error?.code === "frame_count_mismatch") return "Original and denoised videos have different frame counts";
	if (error) return error.message.charAt(0).toUpperCase() + error.message.slice(1);
	const lines = stderr.split(/\r?\n/).filter((line) => line.trim());
	return lines.slice(-5).join("\n") || `regrain exited with code ${code}`;
}

async function generate(
	job: Job,
	config: AppConfig,
	sourcePath: string,
	sampling: FilmGrainSampling,
	range: FilmGrainRange,
	signal?: AbortSignal,
	onProgress?: (progress: FilmGrainProgress) => void,
): Promise<GeneratedFilmGrainTable> {
	if (signal?.aborted) throw new CancelledError();
	if (!existsSync(job.inputPath)) throw new Error("Denoised job input is no longer accessible");
	if (!existsSync(sourcePath)) throw new Error("Original source is no longer accessible");
	if (realpathSync(sourcePath) === realpathSync(job.inputPath)) throw new Error("Original and denoised input must be different files");
	const tableDir = join(config.tempDir, "film-grain-tables");
	mkdirSync(tableDir, { recursive: true });
	const workDir = mkdtempSync(join(tableDir, "generate-"));
	try {
		const original = await probeFile(sourcePath);
		const denoised = job.probe ?? (await probeFile(job.inputPath));
		if (Math.abs(original.videoStreamFps - denoised.videoStreamFps) > 0.01) throw new Error("Original and denoised videos must have the same frame rate");
		if (denoised.width > original.width || denoised.height > original.height)
			throw new Error("Denoised video is larger than the original, so it cannot be a crop of it");
		if (signal?.aborted) throw new CancelledError();
		const args = ["regrain", "diff", sourcePath, job.inputPath, "-o", join(workDir, "grain.tbl"), "-y", "--progress", "json", "--scan", SCAN[sampling]];
		// A denoising server that crops first hands back a smaller frame. regrain then
		// measures only the matching area of the original.
		if (original.width !== denoised.width || original.height !== denoised.height) {
			const crop = await detectFilmGrainCrop(sourcePath, job.inputPath, original, denoised, Math.min(original.duration, denoised.duration), workDir, signal);
			args.push("--crop", `${crop.w}:${crop.h}:${crop.x}:${crop.y}`);
			Logger.info(`[film-grain] Denoised input is ${crop.w}x${crop.h}. Measuring the ${original.width}x${original.height} original at +${crop.x}+${crop.y}.`);
		}
		const window = range === "representative" ? representativeFilmGrainWindow(Math.min(original.duration, denoised.duration), denoised.videoStreamFps) : null;
		if (window) args.push("--start", window.startSeconds.toFixed(3), "--duration", (window.frames / denoised.videoStreamFps).toFixed(3));
		if (signal?.aborted) throw new CancelledError();
		const result = await runRegrain(args, signal, onProgress);
		if (signal?.aborted || result.error?.code === "cancelled") throw new CancelledError();
		if (result.code !== 0 || !result.summary) throw new Error(regrainErrorText(result.error, result.stderr, result.code));
		for (const warning of result.summary.warnings ?? []) Logger.warn(`[film-grain] ${warning.message}`);
		const tempTable = join(workDir, "grain.tbl");
		if (!existsSync(tempTable)) throw new Error("regrain wrote no film grain table");
		const tablePath = join(tableDir, `${job.id}-${randomUUID()}.tbl`);
		// The encode applies a stored table scene by scene, so a table has to cover the whole video.
		// A window's timestamps do not, and it is stored as its one representative segment.
		if (window) return { tablePath, segments: writeRepresentativeFilmGrainTable(tempTable, tablePath) };
		const segments = filmGrainSegmentCount(tempTable);
		renameSync(tempTable, tablePath);
		return { tablePath, segments };
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
}
