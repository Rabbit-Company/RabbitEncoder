import { randomUUID } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync } from "fs";
import { join } from "path";
import type { AppConfig, FilmGrainSampling, FilmGrainRange, Job } from "../core/types";
import { CancelledError, run } from "../core/process";
import { probeFile } from "../pipeline/probe";
import { filmGrainSegmentCount, writeRepresentativeFilmGrainTable } from "./film-grain-table";
import { parseFilmGrainProgress, type FilmGrainProgress } from "./film-grain-progress";
import { Logger } from "../core/logger";
import { detectFilmGrainCrop, filmGrainCropFilter } from "./film-grain-crop";
import { cutFilmGrainWindow, representativeFilmGrainWindow, verifyFilmGrainWindows } from "./film-grain-window";

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
	// grav1synth uses every core, so a job never has two runs at once. A run that
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

async function runDiffWithProgress(
	cmd: string[],
	signal?: AbortSignal,
	onProgress?: (progress: FilmGrainProgress) => void,
): Promise<{ code: number; stderr: string; stdout: string }> {
	let output = "";
	let progressOutput = "";
	let lastFrames = -1;
	let lastEmit = 0;
	const decoder = new TextDecoder();
	const terminalEnv: Record<string, string | undefined> = { ...process.env, TERM: "xterm-256color" };
	delete terminalEnv.NO_COLOR;
	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn(cmd, {
			env: terminalEnv,
			terminal: {
				cols: 120,
				rows: 24,
				data: (_terminal, bytes) => {
					const chunk = decoder.decode(bytes, { stream: true });
					output = (output + chunk).slice(-16384);
					progressOutput = (progressOutput + chunk).slice(-4096);
					const progress = parseFilmGrainProgress(progressOutput);
					if (progress && (progress.frames !== lastFrames || progress.totalFrames === undefined) && Date.now() - lastEmit >= 500) {
						lastFrames = progress.frames;
						lastEmit = Date.now();
						onProgress?.(progress);
					}
				},
			},
		});
	} catch {
		// Older Bun runtimes may not support PTYs. Encoding still works without live progress.
		return run(cmd, { signal });
	}
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	const onAbort = () => {
		try {
			proc.kill("SIGTERM");
		} catch {}
		killTimer = setTimeout(() => {
			try {
				proc.kill("SIGKILL");
			} catch {}
		}, 3000);
	};
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const code = await proc.exited;
		// The PTY can deliver its final bytes just after the process exits.
		await Bun.sleep(50);
		const progress = parseFilmGrainProgress(progressOutput);
		if (progress) onProgress?.(progress);
		return { code, stderr: output.trim(), stdout: "" };
	} finally {
		if (killTimer) clearTimeout(killTimer);
		signal?.removeEventListener("abort", onAbort);
		proc.terminal?.close();
	}
}

function diffErrorText(output: string): string {
	return output
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.split(/[\r\n]+/)
		.map((line) => line.trim())
		.filter((line) => line && !/\b\d{1,3}%\s+\d+\/\d+\b/.test(line))
		.slice(-10)
		.join("\n");
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
		// A denoising server that crops first hands back a smaller frame. The original
		// gets the same crop here so both sides of the diff cover the same pixels.
		let cropFilter: string | undefined;
		if (original.width !== denoised.width || original.height !== denoised.height) {
			const crop = await detectFilmGrainCrop(sourcePath, job.inputPath, original, denoised, Math.min(original.duration, denoised.duration), workDir, signal);
			cropFilter = filmGrainCropFilter(crop);
			Logger.info(
				`[film-grain] Denoised input is ${crop.w}x${crop.h}. Cropping the ${original.width}x${original.height} original at +${crop.x}+${crop.y} to match.`,
			);
		}
		let measuredSource = sourcePath;
		let measuredDenoised = job.inputPath;
		const window = range === "representative" ? representativeFilmGrainWindow(Math.min(original.duration, denoised.duration), denoised.videoStreamFps) : null;
		if (window) {
			measuredSource = join(workDir, "original-window.mkv");
			measuredDenoised = join(workDir, "denoised-window.mkv");
			await Promise.all([
				cutFilmGrainWindow(sourcePath, measuredSource, window, signal, cropFilter),
				cutFilmGrainWindow(job.inputPath, measuredDenoised, window, signal),
			]);
			await verifyFilmGrainWindows(measuredSource, measuredDenoised, workDir, window.frames, signal);
		} else if (cropFilter) {
			// grav1synth reads files only, so a full measurement needs a lossless cropped copy of the whole original.
			measuredSource = join(workDir, "original-cropped.mkv");
			await cutFilmGrainWindow(sourcePath, measuredSource, null, signal, cropFilter);
		}
		if (signal?.aborted) throw new CancelledError();
		const tempTable = join(workDir, "grain.tbl");
		// The count only feeds grav1synth's progress bar. Passing it skips a full read of the source.
		const frames = window ? window.frames : Math.round(original.duration * (original.videoDisplayFps || original.videoStreamFps));
		const framesArgs = Number.isFinite(frames) && frames > 0 ? ["--frames", String(frames)] : [];
		const result = await runDiffWithProgress(
			["grav1synth", "diff", measuredSource, measuredDenoised, "-o", tempTable, "--noise-sampling", sampling, ...framesArgs],
			signal,
			onProgress,
		);
		if (signal?.aborted) throw new CancelledError();
		if (/Videos did not have equal frame counts/i.test(result.stderr)) throw new Error("Original and denoised videos have different frame counts");
		if (result.code !== 0) throw new Error(diffErrorText(result.stderr || result.stdout) || `grav1synth exited with code ${result.code}`);
		if (!existsSync(tempTable) || statSync(tempTable).size <= "filmgrn1\n".length) throw new Error("grav1synth produced no film grain parameters");
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
