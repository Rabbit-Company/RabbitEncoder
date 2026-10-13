import { readFileSync } from "fs";
import { join } from "path";
import { CancelledError, run } from "../core/process";

export interface FilmGrainCrop {
	w: number;
	h: number;
	x: number;
	y: number;
}

export interface GrayFrame {
	data: Uint8Array;
	width: number;
	height: number;
}

/** Positions across the video where the two files are compared. */
const SAMPLE_POSITIONS = [0.2, 0.35, 0.5, 0.65, 0.8];
const SAMPLE_COLUMNS = 64;
const SAMPLE_ROWS = 48;
/** Samples stay this far from the denoised edges, where a denoiser or a smeared border changes the picture. */
const SAMPLE_INSET = 0.08;
/** Below this luma variance the sampled frames are too flat to tell one offset from another. */
const MIN_SAMPLE_VARIANCE = 4;

export function filmGrainCropFilter(crop: FilmGrainCrop): string {
	return `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`;
}

/**
 * Find where the denoised frames sit inside the original frames.
 *
 * The denoising server picks its own crop, so the offset is measured from the
 * pictures instead of repeating a detection that may use other settings.
 * Returns null when the frames are too flat to place.
 */
export function locateFilmGrainCrop(originals: GrayFrame[], denoised: GrayFrame[]): FilmGrainCrop | null {
	const first = originals[0];
	const target = denoised[0];
	if (!first || !target || originals.length !== denoised.length) throw new Error("Invalid film grain crop frames");
	const { width, height } = first;
	const { width: w, height: h } = target;
	if (w > width || h > height) throw new Error("Denoised frame is larger than the original");

	const columns = Math.min(SAMPLE_COLUMNS, w);
	const rows = Math.min(SAMPLE_ROWS, h);
	const insetX = Math.floor(w * SAMPLE_INSET);
	const insetY = Math.floor(h * SAMPLE_INSET);
	const points: number[] = [];
	for (let row = 0; row < rows; row++) {
		const py = insetY + Math.floor(((row + 0.5) * (h - insetY * 2)) / rows);
		for (let column = 0; column < columns; column++) {
			points.push(insetX + Math.floor(((column + 0.5) * (w - insetX * 2)) / columns), py);
		}
	}
	const count = points.length / 2;
	// A stride that shares no factor with the count visits every point once and
	// spreads early samples over the frame, so bad offsets are dropped quickly.
	let stride = Math.max(1, Math.floor(count * 0.618));
	const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
	while (gcd(stride, count) !== 1) stride++;

	let sum = 0;
	let squares = 0;
	for (const frame of denoised) {
		for (let i = 0; i < count; i++) {
			const value = frame.data[points[i * 2 + 1]! * w + points[i * 2]!]!;
			sum += value;
			squares += value * value;
		}
	}
	const total = count * denoised.length;
	if (squares / total - (sum / total) ** 2 < MIN_SAMPLE_VARIANCE) return null;

	let best = Infinity;
	let bestX = 0;
	let bestY = 0;
	for (let y = 0; y <= height - h; y++) {
		for (let x = 0; x <= width - w; x++) {
			let score = 0;
			search: for (let f = 0; f < denoised.length; f++) {
				const a = originals[f]!.data;
				const b = denoised[f]!.data;
				for (let i = 0, p = 0; i < count; i++, p = (p + stride) % count) {
					const px = points[p * 2]!;
					const py = points[p * 2 + 1]!;
					const delta = a[(y + py) * width + x + px]! - b[py * w + px]!;
					score += delta * delta;
					if (score >= best) break search;
				}
			}
			if (score < best) {
				best = score;
				bestX = x;
				bestY = y;
			}
		}
	}
	return { w, h, x: bestX, y: bestY };
}

async function grayFrame(inputPath: string, outputPath: string, seconds: number, width: number, height: number, signal?: AbortSignal): Promise<GrayFrame> {
	const result = await run(
		[
			"ffmpeg",
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-ss",
			seconds.toFixed(6),
			"-i",
			inputPath,
			"-map",
			"0:V:0",
			"-frames:v",
			"1",
			"-vf",
			"format=gray",
			"-f",
			"rawvideo",
			"-an",
			"-sn",
			"-dn",
			outputPath,
		],
		{ signal },
	);
	if (result.code !== 0) throw new Error(`Could not read a frame to locate the crop: ${result.stderr.slice(-600)}`);
	const data = readFileSync(outputPath);
	if (data.length !== width * height) throw new Error("Could not read a frame to locate the crop: unexpected frame size");
	return { data, width, height };
}

/** Measure the crop that turns the original into the frame size of the denoised video. */
export async function detectFilmGrainCrop(
	originalPath: string,
	denoisedPath: string,
	original: { width: number; height: number },
	denoised: { width: number; height: number },
	duration: number,
	workDir: string,
	signal?: AbortSignal,
): Promise<FilmGrainCrop> {
	const originals: GrayFrame[] = [];
	const crops: GrayFrame[] = [];
	for (const [index, position] of SAMPLE_POSITIONS.entries()) {
		if (signal?.aborted) throw new CancelledError();
		const seconds = duration * position;
		const [a, b] = await Promise.all([
			grayFrame(originalPath, join(workDir, `crop-original-${index}.raw`), seconds, original.width, original.height, signal),
			grayFrame(denoisedPath, join(workDir, `crop-denoised-${index}.raw`), seconds, denoised.width, denoised.height, signal),
		]);
		originals.push(a);
		crops.push(b);
	}
	const crop = locateFilmGrainCrop(originals, crops);
	if (!crop) throw new Error("Could not locate the denoised frame inside the original because the sampled frames are too flat");
	return crop;
}
