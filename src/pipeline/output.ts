import { chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync } from "fs";
import { randomUUID } from "crypto";
import { basename, dirname, extname, join, parse as parsePath, resolve } from "path";
import { pipeline } from "stream/promises";
import { Transform } from "stream";
import type { AppConfig, Job } from "../core/types";
import { Logger } from "../core/logger";
import { CancelledError, humanSize } from "../core/process";

/**
 * Shared output finalization for every pipeline (full encode, translate-only).
 *
 * Both pipelines use this module for output paths, source recycling, and
 * progress while transferring files between filesystems.
 */

/**
 * Remove .nfo, .srt, .jpg and .png files associated with a video file.
 */
export function cleanupAssociatedFiles(videoPath: string): void {
	const dir = dirname(videoPath);
	const stem = parsePath(videoPath).name;

	try {
		const entries = readdirSync(dir);
		for (const entry of entries) {
			const entryStem = parsePath(entry).name;
			const entryExt = extname(entry).toLowerCase();

			const isAssociated = entryStem.startsWith(stem);

			if (isAssociated && [".nfo", ".srt", ".jpg", ".png"].includes(entryExt)) {
				const fullPath = join(dir, entry);
				try {
					unlinkSync(fullPath);
					Logger.info(`[library] Removed associated file: ${entry}`);
				} catch (err: any) {
					Logger.warn(`[library] Failed to remove ${entry}:`, { "error.message": err?.message });
				}
			}
		}
	} catch {}
}

/**
 * Resolve a non-colliding absolute output path.
 *
 * If `dir/filename` already exists (and is not `ignorePath` - the source we are
 * about to replace in place), a numeric suffix is appended before the
 * extension: `name.mkv`, `name (2).mkv`, ... - until a free path
 * is found. This guarantees two distinct source files can never be written to
 * the same output, so an encode can never silently overwrite an earlier one
 * even if the computed names happen to be identical.
 */
export function resolveUniqueOutputPath(dir: string, filename: string, ignorePath?: string): string {
	const ext = extname(filename);
	const stem = filename.slice(0, filename.length - ext.length);
	const ignore = ignorePath ? resolve(ignorePath) : null;

	let candidate = join(dir, filename);
	let n = 2;
	while (existsSync(candidate) && resolve(candidate) !== ignore) {
		candidate = join(dir, `${stem} (${n})${ext}`);
		n++;
	}
	return candidate;
}

/**
 * Move a library source into the recycle bin instead of deleting it.
 *
 * The source's absolute path is mirrored under `recycleBinDir`
 * (`/Animes/Show/Ep 1.mkv` -> `<bin>/Animes/Show/Ep 1.mkv`). An original that
 * is already in the bin under the same name is never overwritten; the new one
 * gets a numeric suffix instead. Throws if the source could not be moved, so
 * callers never go on to destroy an original that was not saved.
 */
export type OutputProgress = (percent: number, detail: string) => void;
export type ByteProgress = (copied: number, total: number, finished: boolean, bytesPerSecond?: number) => void;

export function formatTransferRate(bytesPerSecond: number): string {
	const megabitsPerSecond = (bytesPerSecond * 8) / 1_000_000;
	return megabitsPerSecond >= 1_000 ? `${(megabitsPerSecond / 1_000).toFixed(2)} Gbps` : `${megabitsPerSecond.toFixed(1)} Mbps`;
}

export function formatTransferDetail(label: string, copied: number, total: number, bytesPerSecond?: number): string {
	const amount = total > 1 ? `${label} ${humanSize(copied)} / ${humanSize(total)}` : label;
	return bytesPerSecond === undefined ? amount : `${amount} (${formatTransferRate(bytesPerSecond)})`;
}

/** Move within a filesystem, or stream through a temporary destination file across filesystems. */
export async function moveFileWithProgress(source: string, destination: string, signal?: AbortSignal, onProgress?: ByteProgress): Promise<void> {
	if (signal?.aborted) throw new CancelledError();
	if (resolve(source) === resolve(destination)) {
		onProgress?.(1, 1, true);
		return;
	}
	try {
		renameSync(source, destination);
		onProgress?.(1, 1, true);
		return;
	} catch (error: any) {
		if (error?.code !== "EXDEV") throw error;
	}
	await copyFileWithProgress(source, destination, signal, onProgress);
}

/** Stream a move through a hidden destination file and publish it after the copy succeeds. */
export async function copyFileWithProgress(source: string, destination: string, signal?: AbortSignal, onProgress?: ByteProgress): Promise<void> {
	await transferFileWithProgress(source, destination, true, signal, onProgress);
}

/** Copy a source into the working directory while keeping the original. */
export async function stageFileWithProgress(source: string, destination: string, signal?: AbortSignal, onProgress?: ByteProgress): Promise<void> {
	await transferFileWithProgress(source, destination, false, signal, onProgress);
}

async function transferFileWithProgress(
	source: string,
	destination: string,
	removeSource: boolean,
	signal?: AbortSignal,
	onProgress?: ByteProgress,
): Promise<void> {
	if (signal?.aborted) throw new CancelledError();
	const sourceStat = statSync(source);
	const total = sourceStat.size;
	const partial = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.part`);
	let copied = 0;
	let lastReported = performance.now();
	const samples = [{ at: lastReported, copied: 0 }];
	const report = (finished: boolean) => {
		const now = performance.now();
		samples.push({ at: now, copied });
		while (samples.length > 2 && now - samples[1]!.at > 3_000) samples.shift();
		const elapsed = now - samples[0]!.at;
		const bytesPerSecond = elapsed >= 500 ? Math.max(0, ((copied - samples[0]!.copied) * 1_000) / elapsed) : undefined;
		onProgress?.(copied, total, finished, bytesPerSecond);
	};
	const counter = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			copied += chunk.length;
			const now = performance.now();
			if (now - lastReported >= 250 || copied === total) {
				report(false);
				lastReported = now;
			}
			callback(null, chunk);
		},
	});
	const timer = onProgress ? setInterval(() => report(false), 1_000) : undefined;
	try {
		report(false);
		await pipeline(createReadStream(source), counter, createWriteStream(partial, { flags: "wx" }), { signal });
		if (signal?.aborted) throw new CancelledError();
		try {
			chmodSync(partial, sourceStat.mode & 0o777);
			utimesSync(partial, sourceStat.atime, sourceStat.mtime);
		} catch (error: any) {
			Logger.warn(`[output] Could not preserve file permissions or timestamps: ${error?.message || error}`);
		}
		renameSync(partial, destination);
		if (removeSource) unlinkSync(source);
		report(true);
	} catch (error) {
		try {
			unlinkSync(partial);
		} catch {}
		if (signal?.aborted) throw new CancelledError();
		throw error;
	} finally {
		if (timer) clearInterval(timer);
	}
}

function reportTransfer(onProgress: OutputProgress | undefined, start: number, end: number, label: string): ByteProgress {
	return (copied, total, finished, bytesPerSecond) => {
		const fraction = finished ? 1 : total > 0 ? Math.min(0.99, copied / total) : 0;
		const detail = formatTransferDetail(label, copied, total, bytesPerSecond);
		onProgress?.(start + (end - start) * fraction, detail);
	};
}

export async function recycleSource(sourcePath: string, recycleBinDir: string, signal?: AbortSignal, onProgress?: ByteProgress): Promise<string> {
	const source = resolve(sourcePath);
	const binDir = join(recycleBinDir, dirname(source));
	mkdirSync(binDir, { recursive: true });
	const binPath = resolveUniqueOutputPath(binDir, basename(source));

	await moveFileWithProgress(source, binPath, signal, onProgress);

	Logger.info(`[library] Moved source to recycle bin: ${binPath}`);
	return binPath;
}

/**
 * Move a finished temp file to its final destination and return that path.
 *
 * Library jobs (`job.replaceSource`): the result lands next to the source; if
 * it does not overwrite the source directly, associated Jellyfin/Sonarr
 * metadata is cleaned up and the source removed. With `config.recycleBinDir`
 * set, the source is moved to the recycle bin instead of being overwritten or
 * removed. Watched-input jobs: the result lands in `config.outputDir`
 * (respecting `job.relativePath`).
 *
 * Note: deleting the *input* file for non-replaceSource jobs stays the
 * caller's responsibility (matching encodeJob's existing behavior), because
 * some flows finalize by moving the input file itself.
 */
export async function finalizeOutput(
	job: Job,
	config: AppConfig,
	finishedFile: string,
	outputFilename: string,
	signal?: AbortSignal,
	onProgress?: OutputProgress,
): Promise<string> {
	let outputPath: string;

	if (job.replaceSource) {
		const sourceDir = dirname(job.inputPath);
		outputPath = resolveUniqueOutputPath(sourceDir, outputFilename, job.inputPath);
		const overwritesSource = resolve(outputPath) === resolve(job.inputPath);

		// Overwriting in place: the source has to be out of the way first.
		if (overwritesSource && config.recycleBinDir) {
			await recycleSource(job.inputPath, config.recycleBinDir, signal, reportTransfer(onProgress, 0, 20, "Recycling source"));
		}

		const outputStart = overwritesSource && config.recycleBinDir ? 20 : 0;
		const outputEnd = !overwritesSource && config.recycleBinDir ? 80 : 100;
		await moveFileWithProgress(finishedFile, outputPath, signal, reportTransfer(onProgress, outputStart, outputEnd, "Writing output"));

		if (!overwritesSource) {
			cleanupAssociatedFiles(job.inputPath);
			try {
				if (config.recycleBinDir) {
					await recycleSource(job.inputPath, config.recycleBinDir, signal, reportTransfer(onProgress, 80, 100, "Recycling source"));
				} else {
					unlinkSync(job.inputPath);
					Logger.info(`[library] Removed source: ${job.filename}`);
				}
			} catch (err: any) {
				if (err instanceof CancelledError) throw err;
				Logger.warn(`[library] Failed to ${config.recycleBinDir ? "recycle" : "remove"} source ${job.filename}:`, { "error.message": err?.message });
			}
		}

		Logger.info(`[library] Replaced with: ${basename(outputPath)}`);
	} else {
		const outputSubDir = job.relativePath ? join(config.outputDir, job.relativePath) : config.outputDir;
		mkdirSync(outputSubDir, { recursive: true });
		outputPath = resolveUniqueOutputPath(outputSubDir, outputFilename);

		await moveFileWithProgress(finishedFile, outputPath, signal, reportTransfer(onProgress, 0, 100, "Writing output"));
	}

	return outputPath;
}
