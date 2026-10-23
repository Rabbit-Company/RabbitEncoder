import { rmSync } from "node:fs";
import { CancelledError } from "../core/process";
import { Logger } from "../core/logger";
import { parseRegrainEvent, progressFromEvent, type FilmGrainProgress } from "./film-grain-progress";

/** One event from `retone --progress json`. retone writes the same start, progress and error events as regrain. */
export interface RetoneSummary {
	event: "summary";
	frames?: number;
	scenes?: number;
	scene_source?: string;
	max_cll?: number;
	max_fall?: number;
}

export interface RetoneRun {
	code: number;
	summary?: RetoneSummary;
	error?: { code: string; message: string };
	stderr: string;
}

export async function runRetone(cmd: string[], signal?: AbortSignal, onProgress?: (progress: FilmGrainProgress) => void): Promise<RetoneRun> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	// retone stops its ffmpeg processes and removes partial output on SIGTERM.
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
	let summary: RetoneSummary | undefined;
	let error: RetoneRun["error"];
	const stderrText = new Response(proc.stderr).text();
	try {
		const decoder = new TextDecoder();
		let buffered = "";
		for await (const chunk of proc.stdout) {
			buffered += decoder.decode(chunk, { stream: true });
			let newline: number;
			while ((newline = buffered.indexOf("\n")) >= 0) {
				const line = buffered.slice(0, newline);
				buffered = buffered.slice(newline + 1);
				const event = parseRegrainEvent(line);
				if (event?.event === "progress" && event.frames !== undefined) onProgress?.(progressFromEvent(event));
				else if (event?.event === "error") error = { code: event.code, message: event.message };
				else if (event?.event === "summary") summary = JSON.parse(line) as RetoneSummary;
			}
		}
		const code = await proc.exited;
		return { code, summary, error, stderr: (await stderrText).trim().slice(-2000) };
	} finally {
		if (killTimer) clearTimeout(killTimer);
		signal?.removeEventListener("abort", onAbort);
	}
}

export function retoneErrorText(run: RetoneRun): string {
	if (run.error) return run.error.message.charAt(0).toUpperCase() + run.error.message.slice(1);
	const lines = run.stderr.split(/\r?\n/).filter((line) => line.trim());
	return lines.slice(-5).join("\n") || `retone exited with code ${run.code}`;
}

/** Dolby Vision metadata that does not fit the prepared video, so its scenes cannot be used. */
const DOLBY_VISION_FALLBACK_CODES = new Set([
	"frame_count_mismatch",
	"no_dolby_vision",
	"missing_dolby_vision",
	"invalid_dolby_vision",
	"unsupported_input",
	"not_hdr",
]);

export interface MeasureHdr10PlusOptions {
	/** The video as it will be encoded: cropped, scaled and denoised. */
	videoPath: string;
	/** The Dolby Vision source, whose shots become the HDR10+ scenes. Its frames must be the video's frames. */
	dolbyVisionPath?: string;
	metadataPath: string;
	signal?: AbortSignal;
	onProgress?: (progress: FilmGrainProgress) => void;
}

export interface Hdr10PlusMeasurement {
	frames: number;
	scenes: number;
	/** Where the scenes come from: "dolby_vision_shots", "dolby_vision_level1" or "measured". */
	sceneSource: string;
	maxCll?: number;
	maxFall?: number;
}

export function measureArgs(opts: MeasureHdr10PlusOptions, dolbyVision: boolean): string[] {
	// The prepared video is PQ whatever its tags say, since only PQ sources get here.
	const common = ["-o", opts.metadataPath, "-y", "--transfer", "pq", "--progress", "json"];
	return dolbyVision && opts.dolbyVisionPath
		? ["retone", "convert", opts.dolbyVisionPath, "--video", opts.videoPath, ...common]
		: ["retone", "measure", opts.videoPath, ...common];
}

/**
 * Measures HDR10+ metadata for the video. A Dolby Vision source gives the scenes its shots. When its
 * metadata does not fit the video, as after filling dropped frames, the scenes are measured instead.
 */
export async function measureHdr10Plus(opts: MeasureHdr10PlusOptions): Promise<Hdr10PlusMeasurement> {
	const attempt = async (dolbyVision: boolean) => {
		rmSync(opts.metadataPath, { force: true });
		const result = await runRetone(measureArgs(opts, dolbyVision), opts.signal, opts.onProgress);
		if (opts.signal?.aborted || result.error?.code === "cancelled") throw new CancelledError();
		return result;
	};
	let result = await attempt(!!opts.dolbyVisionPath);
	if (opts.dolbyVisionPath && result.code !== 0 && result.error && DOLBY_VISION_FALLBACK_CODES.has(result.error.code)) {
		Logger.warn(`[hdr10+] Dolby Vision scenes cannot be used (${result.error.message}), measuring scenes instead`);
		result = await attempt(false);
	}
	if (result.code !== 0 || !result.summary) throw new Error(retoneErrorText(result));
	return {
		frames: result.summary.frames ?? 0,
		scenes: result.summary.scenes ?? 0,
		sceneSource: result.summary.scene_source ?? "measured",
		maxCll: result.summary.max_cll,
		maxFall: result.summary.max_fall,
	};
}

export function applyArgs(ivfPath: string, metadataPath: string, outputPath: string, verify: boolean): string[] {
	// The encode comes from a PQ source, so missing colour tags are the encoder's and can be set.
	const args = ["retone", "apply", ivfPath, "-m", metadataPath, "-o", outputPath, "-y", "--fix-color", "--progress", "json"];
	if (verify) args.push("--verify");
	return args;
}

/** One line for the step detail, such as "2 scenes from Dolby Vision shots". */
export function describeMeasurement(measurement: Hdr10PlusMeasurement): string {
	const scenes = `${measurement.scenes} ${measurement.scenes === 1 ? "scene" : "scenes"}`;
	if (measurement.sceneSource === "dolby_vision_shots") return `${scenes} from Dolby Vision shots`;
	if (measurement.sceneSource === "dolby_vision_level1") return `${scenes} from Dolby Vision metadata`;
	return scenes;
}
