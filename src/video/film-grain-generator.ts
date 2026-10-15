import { randomUUID } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "fs";
import { dirname, join } from "path";
import type { AppConfig, FilmGrainSampling, FilmGrainRange, FilmGrainSize, Job, ProbeResult } from "../core/types";
import { CancelledError, run } from "../core/process";
import { probeFile } from "../pipeline/probe";
import { filmGrainSegmentCount, writeRepresentativeFilmGrainTable } from "./film-grain-table";
import { parseRegrainEvent, progressFromEvent, type FilmGrainProgress, type RegrainEvent } from "./film-grain-progress";
import { Logger } from "../core/logger";
import { detectFilmGrainCrop, type FilmGrainCrop } from "./film-grain-crop";
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
	justEnough?: boolean;
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
	justEnough: boolean,
	signal?: AbortSignal,
	onProgress?: (progress: FilmGrainProgress) => void,
): Promise<GeneratedFilmGrainTable> {
	// regrain uses every core, so a job never has two runs at once. A run that
	// is being cancelled has to stop before the next one starts.
	while (active.has(job.id)) await active.get(job.id)!.catch(() => {});
	const promise = generate(job, config, sourcePath, sampling, range, justEnough, signal, onProgress).finally(() => {
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
			job.settings.filmGrainJustEnough === true,
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
	justEnough: boolean,
	signal?: AbortSignal,
	onProgress?: (progress: FilmGrainProgress) => void,
): Promise<GeneratedFilmGrainTable> {
	if (signal?.aborted) throw new CancelledError();
	if (!existsSync(job.inputPath)) throw new Error("Denoised job input is no longer accessible");
	if (!existsSync(sourcePath)) throw new Error("Original source is no longer accessible");
	if (realpathSync(sourcePath) === realpathSync(job.inputPath)) throw new Error("Original and denoised input must be different files");
	const tableDir = join(config.tempDir, "film-grain-tables");
	mkdirSync(tableDir, { recursive: true });
	const tablePath = join(tableDir, `${job.id}-${randomUUID()}.tbl`);
	const segments = await measureFilmGrain({
		sourcePath,
		denoisedPath: job.inputPath,
		denoisedProbe: job.probe,
		tablePath,
		sampling,
		range,
		justEnough,
		signal,
		onProgress,
	});
	return { tablePath, segments };
}

export interface MeasureFilmGrainOptions {
	/** The video with grain. */
	sourcePath: string;
	denoisedPath: string;
	denoisedProbe?: ProbeResult;
	tablePath: string;
	sampling: FilmGrainSampling;
	range: FilmGrainRange;
	justEnough: boolean;
	/** Where the denoised frame sits inside the source, when known. It is detected when the sizes differ and this is missing. */
	crop?: FilmGrainCrop;
	signal?: AbortSignal;
	onProgress?: (progress: FilmGrainProgress) => void;
}

/** Measure the grain between a grainy and a denoised video into a table that covers the whole video. Returns its segment count. */
export async function measureFilmGrain(opts: MeasureFilmGrainOptions): Promise<number> {
	const { sourcePath, denoisedPath, signal } = opts;
	if (signal?.aborted) throw new CancelledError();
	const workDir = mkdtempSync(join(dirname(opts.tablePath), "generate-"));
	try {
		const original = await probeFile(sourcePath);
		const denoised = opts.denoisedProbe ?? (await probeFile(denoisedPath));
		if (Math.abs(original.videoStreamFps - denoised.videoStreamFps) > 0.01) throw new Error("Original and denoised videos must have the same frame rate");
		if (denoised.width > original.width || denoised.height > original.height)
			throw new Error("Denoised video is larger than the original, so it cannot be a crop of it");
		if (signal?.aborted) throw new CancelledError();
		const args = ["regrain", "diff", sourcePath, denoisedPath, "-o", join(workDir, "grain.tbl"), "-y", "--progress", "json", "--scan", SCAN[opts.sampling]];
		if (opts.justEnough) args.push("--just-enough");
		// A denoising server that crops first hands back a smaller frame. regrain then
		// measures only the matching area of the original.
		if (original.width !== denoised.width || original.height !== denoised.height) {
			const crop =
				opts.crop ?? (await detectFilmGrainCrop(sourcePath, denoisedPath, original, denoised, Math.min(original.duration, denoised.duration), workDir, signal));
			args.push("--crop", `${crop.w}:${crop.h}:${crop.x}:${crop.y}`);
			Logger.info(`[film-grain] Denoised input is ${crop.w}x${crop.h}. Measuring the ${original.width}x${original.height} original at +${crop.x}+${crop.y}.`);
		}
		const window =
			opts.range === "representative" ? representativeFilmGrainWindow(Math.min(original.duration, denoised.duration), denoised.videoStreamFps) : null;
		if (window) args.push("--start", window.startSeconds.toFixed(3), "--duration", (window.frames / denoised.videoStreamFps).toFixed(3));
		if (signal?.aborted) throw new CancelledError();
		const result = await runRegrain(args, signal, opts.onProgress);
		if (signal?.aborted || result.error?.code === "cancelled") throw new CancelledError();
		if (result.code !== 0 || !result.summary) throw new Error(regrainErrorText(result.error, result.stderr, result.code));
		for (const warning of result.summary.warnings ?? []) Logger.warn(`[film-grain] ${warning.message}`);
		const tempTable = join(workDir, "grain.tbl");
		if (!existsSync(tempTable)) throw new Error("regrain wrote no film grain table");
		// The encode applies a stored table scene by scene, so a table has to cover the whole video.
		// A window's timestamps do not, and it is stored as its one representative segment.
		if (window) return writeRepresentativeFilmGrainTable(tempTable, opts.tablePath);
		const segments = filmGrainSegmentCount(tempTable);
		renameSync(tempTable, opts.tablePath);
		return segments;
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
}

/** Write a table with grain of a chosen strength for the whole video. Returns its segment count, 0 when the strength adds no grain. */
export async function generateSyntheticFilmGrainTable(
	tablePath: string,
	grain: { strength: number; size: FilmGrainSize; chroma: number },
	signal?: AbortSignal,
): Promise<number> {
	const res = await run(
		[
			"regrain",
			"--progress",
			"json",
			"generate",
			"-o",
			tablePath,
			"-y",
			"--strength",
			String(grain.strength),
			"--size",
			grain.size,
			"--chroma",
			String(grain.chroma),
		],
		{ signal },
	);
	if (signal?.aborted) throw new CancelledError();
	if (res.code !== 0 || !existsSync(tablePath)) {
		const failure = res.stdout
			.split("\n")
			.map(parseRegrainEvent)
			.find((event) => event?.event === "error");
		const reason = failure?.event === "error" ? failure.message : (res.stderr || res.stdout).trim().slice(-500) || `exit ${res.code}`;
		throw new Error(`Synthetic film grain failed: ${reason}`);
	}
	return filmGrainSegmentCount(tablePath);
}
