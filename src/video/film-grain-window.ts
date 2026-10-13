import { readFileSync } from "fs";
import { join } from "path";
import { CancelledError, run } from "../core/process";

const WINDOW_SECONDS = 30;
const GRAY_WIDTH = 64;
const GRAY_HEIGHT = 36;
const GRAY_FRAME_BYTES = GRAY_WIDTH * GRAY_HEIGHT;

export interface FilmGrainWindow {
	startSeconds: number;
	frames: number;
}

/** A fixed window keeps preview options from changing the table used by the final encode. */
export function representativeFilmGrainWindow(duration: number, fps: number): FilmGrainWindow | null {
	if (!Number.isFinite(duration) || !Number.isFinite(fps) || fps <= 0 || duration < WINDOW_SECONDS * 2) return null;
	return { startSeconds: (duration - WINDOW_SECONDS) / 2, frames: Math.round(WINDOW_SECONDS * fps) };
}

/** Write a lossless copy for measuring. A null window keeps the whole video, and a filter crops it. */
export async function cutFilmGrainWindow(
	inputPath: string,
	outputPath: string,
	window: FilmGrainWindow | null,
	signal?: AbortSignal,
	videoFilter?: string,
): Promise<void> {
	const result = await run(
		[
			"ffmpeg",
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			...(window ? ["-ss", window.startSeconds.toFixed(6)] : []),
			"-i",
			inputPath,
			"-map",
			"0:V:0",
			...(window ? ["-frames:v", String(window.frames)] : []),
			...(videoFilter ? ["-vf", videoFilter] : []),
			"-c:v",
			"ffv1",
			"-level",
			"3",
			"-g",
			"1",
			"-fps_mode:v",
			"passthrough",
			"-an",
			"-sn",
			"-dn",
			"-map_metadata",
			"-1",
			"-map_chapters",
			"-1",
			outputPath,
		],
		{ signal },
	);
	if (result.code !== 0) throw new Error(`Could not cut film grain window: ${result.stderr.slice(-600)}`);
}

async function grayFrames(inputPath: string, outputPath: string, signal?: AbortSignal): Promise<Buffer> {
	const result = await run(
		[
			"ffmpeg",
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-i",
			inputPath,
			"-map",
			"0:V:0",
			"-vf",
			`scale=${GRAY_WIDTH}:${GRAY_HEIGHT},format=gray`,
			"-f",
			"rawvideo",
			"-an",
			"-sn",
			"-dn",
			outputPath,
		],
		{ signal },
	);
	if (result.code !== 0) throw new Error(`Could not validate film grain window: ${result.stderr.slice(-600)}`);
	return readFileSync(outputPath);
}

/** Compare the paired windows against one-frame offsets before measuring grain. */
export function filmGrainAlignmentScores(
	original: Uint8Array,
	denoised: Uint8Array,
	frameBytes = GRAY_FRAME_BYTES,
): { aligned: number; shiftedEarlier: number; shiftedLater: number; frames: number } {
	if (original.length % frameBytes !== 0 || denoised.length % frameBytes !== 0) throw new Error("Invalid film grain validation frames");
	const frames = original.length / frameBytes;
	if (frames !== denoised.length / frameBytes || frames < 4) throw new Error("Film grain windows have different frame counts");
	const stride = Math.max(1, Math.floor((frames - 2) / 32));
	const score = (lag: number): number => {
		let sum = 0;
		let count = 0;
		for (let frame = 1; frame < frames - 1; frame += stride) {
			const a = frame * frameBytes;
			const b = (frame + lag) * frameBytes;
			for (let pixel = 0; pixel < frameBytes; pixel++) {
				const delta = original[a + pixel]! - denoised[b + pixel]!;
				sum += delta * delta;
			}
			count += frameBytes;
		}
		return sum / count;
	};
	return { aligned: score(0), shiftedEarlier: score(-1), shiftedLater: score(1), frames };
}

export async function verifyFilmGrainWindows(
	originalPath: string,
	denoisedPath: string,
	workDir: string,
	expectedFrames: number,
	signal?: AbortSignal,
): Promise<void> {
	if (signal?.aborted) throw new CancelledError();
	const [original, denoised] = await Promise.all([
		grayFrames(originalPath, join(workDir, "original-gray.raw"), signal),
		grayFrames(denoisedPath, join(workDir, "denoised-gray.raw"), signal),
	]);
	const scores = filmGrainAlignmentScores(original, denoised);
	if (scores.frames !== expectedFrames) throw new Error(`Film grain windows contain ${scores.frames} frames instead of ${expectedFrames}`);
	const shifted = Math.min(scores.shiftedEarlier, scores.shiftedLater);
	if (scores.aligned > shifted * 1.05 && scores.aligned - shifted > 1)
		throw new Error("Original and denoised windows appear one frame out of alignment; choose Full video measurement or correct the source mapping");
}
