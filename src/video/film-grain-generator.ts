import { randomUUID } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "fs";
import { dirname, join } from "path";
import type { AppConfig, FilmGrainSampling, FilmGrainRange, FilmGrainSize, Job, ProbeResult } from "../core/types";
import { CancelledError, run } from "../core/process";
import { probeFile } from "../pipeline/probe";
import { filmGrainSegmentCount, writeRepresentativeFilmGrainTable } from "./film-grain-table";
import { parseRegrainEvent, progressFromEvent, type FilmGrainProgress, type RegrainEvent } from "./film-grain-progress";
import { Logger } from "../core/logger";
import { decodedFrameSize, detectFilmGrainGeometry, type FilmGrainCrop } from "./film-grain-crop";
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

/** Runs regrain with `--progress json` and hands every event to `onEvent` as it arrives. */
export async function streamRegrain(
	cmd: string[],
	signal: AbortSignal | undefined,
	onEvent: (event: RegrainEvent) => void,
): Promise<{ code: number; stderr: string }> {
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
	const stderrText = new Response(proc.stderr).text();
	try {
		const decoder = new TextDecoder();
		let buffered = "";
		for await (const chunk of proc.stdout) {
			// The stats summary of a long table is one line of tens of megabytes, so only the new text is searched.
			let searchFrom = buffered.length;
			buffered += decoder.decode(chunk, { stream: true });
			let newline: number;
			while ((newline = buffered.indexOf("\n", searchFrom)) >= 0) {
				const event = parseRegrainEvent(buffered.slice(0, newline));
				buffered = buffered.slice(newline + 1);
				searchFrom = 0;
				if (event) onEvent(event);
			}
		}
		const last = parseRegrainEvent(buffered + decoder.decode());
		if (last) onEvent(last);
		const code = await proc.exited;
		return { code, stderr: (await stderrText).trim().slice(-2000) };
	} finally {
		if (killTimer) clearTimeout(killTimer);
		signal?.removeEventListener("abort", onAbort);
	}
}

export async function runRegrain(
	cmd: string[],
	signal?: AbortSignal,
	onProgress?: (progress: FilmGrainProgress) => void,
): Promise<{ code: number; summary?: Extract<RegrainEvent, { event: "summary" }>; error?: Extract<RegrainEvent, { event: "error" }>; stderr: string }> {
	let summary: Extract<RegrainEvent, { event: "summary" }> | undefined;
	let error: Extract<RegrainEvent, { event: "error" }> | undefined;
	const { code, stderr } = await streamRegrain(cmd, signal, (event) => {
		if (event.event === "progress" && event.frames !== undefined) onProgress?.(progressFromEvent(event));
		else if (event.event === "summary") summary = event;
		else if (event.event === "error") error = event;
	});
	return { code, summary, error, stderr };
}

export function regrainErrorText(error: Extract<RegrainEvent, { event: "error" }> | undefined, stderr: string, code: number): string {
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
	/** The size regrain scales the source to after the crop, for a denoised video that was downscaled. */
	scale?: { w: number; h: number };
	/** Measure luma grain only. */
	lumaOnly?: boolean;
	/** Accept a variable frame rate, or frames that do not match the nominal one, when both videos hold the same frames in the same order, as the pipeline's own files do. */
	allowVfr?: boolean;
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
		const source = decodedFrameSize(original);
		const target = decodedFrameSize(denoised);
		if (target.width > source.width || target.height > source.height)
			throw new Error(
				`Denoised video is ${target.width}x${target.height} and larger than the ${source.width}x${source.height} original, so it cannot be cut from it`,
			);
		if (signal?.aborted) throw new CancelledError();
		const args = ["regrain", "diff", sourcePath, denoisedPath, "-o", join(workDir, "grain.tbl"), "-y", "--progress", "json", "--scan", SCAN[opts.sampling]];
		if (opts.justEnough) args.push("--just-enough");
		if (opts.lumaOnly) args.push("--no-chroma");
		if (opts.allowVfr) args.push("--allow-vfr");
		// A denoising server that crops or downscales first hands back a smaller frame. regrain then
		// measures only the matching area of the original.
		let { crop, scale } = opts;
		if (!crop && !scale && (source.width !== target.width || source.height !== target.height)) {
			({ crop, scale } = await detectFilmGrainGeometry(
				sourcePath,
				denoisedPath,
				source,
				target,
				Math.min(original.duration, denoised.duration),
				workDir,
				signal,
			));
		}
		// regrain sizes the original from ffprobe, which ignores the container crop that ffmpeg decodes with.
		if (!crop && original.containerCrop) crop = { w: source.width, h: source.height, x: 0, y: 0 };
		if (crop) args.push("--crop", `${crop.w}:${crop.h}:${crop.x}:${crop.y}`);
		if (scale) args.push("--scale", `${scale.w}x${scale.h}`);
		if (crop || scale) {
			const area = crop ? `${crop.w}x${crop.h} at +${crop.x}+${crop.y}` : `all ${source.width}x${source.height}`;
			Logger.info(
				`[film-grain] Denoised input is ${target.width}x${target.height}. Measuring ${area} of the original${scale ? `, scaled to ${scale.w}x${scale.h}` : ""}.`,
			);
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

/** Synthetic grain of a deviation on the 0 to 255 scale, or the sensor noise of a camera at an ISO for a frame size. */
export type SyntheticGrain = { size: FilmGrainSize; chroma: number } & ({ strength: number } | { iso: number; resolution: { width: number; height: number } });

/** The regrain generate run that writes `grain` to `tablePath`. */
export function syntheticGrainArgs(tablePath: string, grain: SyntheticGrain): string[] {
	const amount =
		"iso" in grain
			? ["--iso", String(grain.iso), "--resolution", `${grain.resolution.width}x${grain.resolution.height}`]
			: ["--strength", String(grain.strength)];
	return ["regrain", "--progress", "json", "generate", "-o", tablePath, "-y", ...amount, "--size", grain.size, "--chroma", String(grain.chroma)];
}

/** Write a table with grain of a chosen strength or ISO for the whole video. Returns its segment count, 0 when it adds no grain. */
export async function generateSyntheticFilmGrainTable(tablePath: string, grain: SyntheticGrain, signal?: AbortSignal): Promise<number> {
	const res = await run(syntheticGrainArgs(tablePath, grain), { signal });
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
