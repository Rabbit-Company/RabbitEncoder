import { Logger } from "../core/logger";
import { CancelledError, computeFps, run } from "../core/process";
import {
	FFV1_ENCODE_ARGS,
	buildSegmentList,
	probeStreamFormat,
	runSegmentedPass,
	segmentCutArgs,
	type DenoisePlan,
	type DenoiseRange,
	type StreamFormat,
} from "./auto-denoise";
import type { AvdEngine, AvdLevelStrengths, AvdParams, AvdPreset, AvdSelfTuningEngine } from "../core/types";

const AVD_BIN = "av-denoise";
/** Backends tried in order. The device ordinal is counted per backend. */
const AVD_ACCELERATORS = "vulkan,cuda";

export const AVD_ENGINES: readonly AvdEngine[] = ["avd-nlmeans", "avd-nlmeans-hq", "avd-nl4d"];
export const AVD_PRESETS: readonly AvdPreset[] = ["veryfast", "fast", "base", "slow", "veryslow"];
export const DEFAULT_AVD_DEVICE = "default";

/**
 * Plain NLMeans takes an absolute strength per level. NLMeans-HQ and NL4D model the
 * source's noise themselves, so they get a single scale that applies at every level:
 * the level only decides whether a scene is denoised, not how hard. 1.0 trusts the
 * engine's own measurement.
 */
export const DEFAULT_AVD_PARAMS: AvdParams = {
	preset: "base",
	nlmeansStrength: { light: 1.0, medium: 1.5, heavy: 2.0 },
	scales: { "avd-nlmeans-hq": 1.0, "avd-nl4d": 1.0 },
};

export function isAvdSelfTuningEngine(engine: string | undefined | null): engine is AvdSelfTuningEngine {
	return engine === "avd-nlmeans-hq" || engine === "avd-nl4d";
}

/** The value passed to the engine's main dial for a scene at `level`. */
export function avdStrengthFor(engine: AvdEngine, level: DenoiseRange["level"], params: AvdParams): number {
	return isAvdSelfTuningEngine(engine) ? params.scales[engine] : params.nlmeansStrength[level];
}

/** NL4D always runs at its default preset, since the ladder changes little for it. */
export function avdEngineUsesPreset(engine: AvdEngine): boolean {
	return engine !== "avd-nl4d";
}

const AVD_ENGINE_LABELS: Record<AvdEngine, string> = {
	"avd-nlmeans": "AVD NLMeans",
	"avd-nlmeans-hq": "AVD NLMeans-HQ",
	"avd-nl4d": "AVD NL4D",
};

export function isAvdEngine(engine: string | undefined | null): engine is AvdEngine {
	return !!engine && (AVD_ENGINES as readonly string[]).includes(engine);
}

export function avdEngineLabel(engine: AvdEngine): string {
	return AVD_ENGINE_LABELS[engine];
}

export function isValidAvdDeviceSpec(spec: string): boolean {
	return /^(default|cpu|(discrete|integrated|virtual)(:\d+)?)$/.test(spec);
}

function clampStrength(v: unknown, fallback: number): number {
	const n = typeof v === "number" ? v : parseFloat(String(v));
	if (!Number.isFinite(n)) return fallback;
	return Math.round(Math.max(0.1, Math.min(10, n)) * 1000) / 1000;
}

function normalizeStrengths(p: Partial<AvdLevelStrengths> | undefined, fallback: AvdLevelStrengths): AvdLevelStrengths {
	return {
		light: clampStrength(p?.light, fallback.light),
		medium: clampStrength(p?.medium, fallback.medium),
		heavy: clampStrength(p?.heavy, fallback.heavy),
	};
}

/** Validate & clamp an AvdParams object, filling anything missing from `fallback`. */
export function normalizeAvdParams(p: Partial<AvdParams> | undefined | null, fallback: AvdParams): AvdParams {
	const preset = p?.preset && AVD_PRESETS.includes(p.preset) ? p.preset : fallback.preset;
	return {
		preset,
		nlmeansStrength: normalizeStrengths(p?.nlmeansStrength, fallback.nlmeansStrength),
		scales: {
			"avd-nlmeans-hq": clampStrength(p?.scales?.["avd-nlmeans-hq"], fallback.scales["avd-nlmeans-hq"]),
			"avd-nl4d": clampStrength(p?.scales?.["avd-nl4d"], fallback.scales["avd-nl4d"]),
		},
	};
}

export function cloneAvdParams(p: AvdParams): AvdParams {
	return normalizeAvdParams(p, p);
}

export interface AvdDevice {
	/** Spec consumed by av-denoise --device, e.g. "default", "discrete:0", "integrated:0". */
	id: string;
	/** Backends offering this device, e.g. ["vulkan"]. */
	backends: string[];
}

/**
 * Enumerate devices via `av-denoise list-devices`.
 *
 * Expected output:
 *   DEVICE        BACKENDS
 *   default       vulkan
 *   discrete:0    cuda, vulkan
 *   integrated:0  vulkan
 *   cpu           vulkan
 *
 * The software "cpu" device is dropped, it is only meant for testing.
 * Returns an empty array on any failure, which callers treat as "av-denoise unusable".
 */
export async function listAvdDevices(): Promise<AvdDevice[]> {
	try {
		const res = await run([AVD_BIN, "--accelerators", AVD_ACCELERATORS, "list-devices"]);
		if (res.code !== 0) {
			Logger.warn(`[avd] list-devices exited with code ${res.code}: ${res.stderr.slice(-300)}`);
			return [];
		}

		const devices: AvdDevice[] = [];
		let inTable = false;
		for (const rawLine of res.stdout.split("\n")) {
			const line = rawLine.trim();
			if (/^DEVICE\s+BACKENDS$/.test(line)) {
				inTable = true;
				continue;
			}
			if (!inTable) continue;
			const m = line.match(/^(\S+)\s+(.+)$/);
			if (!m || !isValidAvdDeviceSpec(m[1]!)) {
				if (devices.length > 0) break;
				continue;
			}
			if (m[1] === "cpu") continue;
			devices.push({ id: m[1]!, backends: m[2]!.split(",").map((b) => b.trim()) });
		}
		return devices;
	} catch (err) {
		Logger.warn(`[avd] Failed to enumerate devices: ${err instanceof Error ? err.message : String(err)}`);
		return [];
	}
}

/** True when av-denoise can see the requested device. */
export async function isAvdDeviceAvailable(device: string): Promise<boolean> {
	const devices = await listAvdDevices();
	return devices.some((d) => d.id === device);
}

/**
 * Build the av-denoise argv (without the binary name) for one engine at one level.
 * `input` is a file path, or "-" for y4m on stdin.
 */
export function buildAvdArgs(engine: AvdEngine, level: DenoiseRange["level"], params: AvdParams, device: string, input: string): string[] {
	const strength = String(avdStrengthFor(engine, level, params));
	const common = ["--accelerators", AVD_ACCELERATORS, "--device", isValidAvdDeviceSpec(device) ? device : DEFAULT_AVD_DEVICE];
	if (avdEngineUsesPreset(engine)) common.push("--preset", params.preset);

	if (engine === "avd-nl4d") {
		return [...common, "nl4d", "--lambda-ht-scale", strength, "--input", input];
	}
	if (engine === "avd-nlmeans-hq") {
		return [...common, "nlmeans", "--variant", "hq", "--hq-sigma-scale", strength, "--input", input];
	}
	return [...common, "nlmeans", "--variant", "fast", "--strength", strength, "--input", input];
}

/**
 * Join touching plan ranges that resolve to the same strength. NLMeans-HQ and NL4D use
 * one scale for every level, so a run of light / medium / heavy scenes becomes a single
 * segment: fewer cuts, and a longer stretch for av-denoise to measure noise over.
 */
export function mergeEqualStrengthRanges(plan: DenoisePlan, engine: AvdEngine, params: AvdParams): DenoisePlan {
	const out: DenoisePlan = [];
	for (const r of [...plan].sort((a, b) => a.start - b.start)) {
		const prev = out[out.length - 1];
		if (prev && Math.abs(prev.end - r.start) < 1e-3 && avdStrengthFor(engine, prev.level, params) === avdStrengthFor(engine, r.level, params)) {
			prev.end = r.end;
		} else {
			out.push({ ...r });
		}
	}
	return out;
}

/** av-denoise only accepts 8/10/12-bit integer YUV at 4:2:0, 4:2:2 or 4:4:4. */
function isAvdPixFmt(pixFmt: string): boolean {
	return /^yuv4(20|22|44)p(10le|12le)?$/.test(pixFmt);
}

/** Closest pixel format av-denoise accepts, keeping chroma subsampling where possible. */
function toAvdPixFmt(pixFmt: string): string {
	if (isAvdPixFmt(pixFmt)) return pixFmt;
	const sub = pixFmt.match(/^yuvj?4(20|22|44)p/)?.[1] ?? "20";
	const bits = pixFmt.match(/p(\d\d)(le|be)?$/)?.[1];
	if (!bits) return `yuv4${sub}p`;
	return `yuv4${sub}p${bits === "10" ? "10le" : "12le"}`;
}

/**
 * Re-tag y4m output with the source's color metadata. Must be setparams and
 * not -colorspace: y4m is untagged, so FFmpeg would convert instead of relabel.
 */
function buildRetagArgs(fmt: StreamFormat): string[] {
	const params: string[] = [];
	if (fmt.colorRange) params.push(`range=${fmt.colorRange}`);
	if (fmt.colorPrimaries) params.push(`color_primaries=${fmt.colorPrimaries}`);
	if (fmt.colorTrc) params.push(`color_trc=${fmt.colorTrc}`);
	if (fmt.colorSpace) params.push(`colorspace=${fmt.colorSpace}`);
	return params.length ? ["-vf", `setparams=${params.join(":")}`] : [];
}

function shQuote(s: string): string {
	return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export interface RunAvdPassOptions {
	inputPath: string;
	outputPath: string;
	engine: AvdEngine;
	level: DenoiseRange["level"];
	params: AvdParams;
	device: string;
	/** Denoise only this time range (seconds). The input must be intra-only (FFV1) for frame-accurate cuts. */
	range?: { start: number; end: number };
	/** Probed format of the input. Probed here when omitted. */
	format?: StreamFormat;
	onProgress?: (currentFrames: number, fpsStr: string | null) => void;
	signal?: AbortSignal;
}

/**
 * Run av-denoise on `inputPath` (or one time range of it), writing FFV1 to `outputPath`.
 *
 * Whole-file runs hand the file to av-denoise directly, which lets it split
 * the video by scene, measure noise per scene and work on scenes in parallel:
 *
 *   av-denoise ... --input in.mkv | ffmpeg -f yuv4mpegpipe -i - ... FFV1
 *
 * Ranges, and sources in a pixel format av-denoise does not accept, are
 * decoded by FFmpeg and piped in as y4m instead (no scene splitting):
 *
 *   ffmpeg -ss A -to B -i in.mkv -f yuv4mpegpipe - | av-denoise ... --input - | ffmpeg ... FFV1
 *
 * av-denoise has no CPU fallback: if no usable GPU is found this throws.
 */
export async function runAvdPass(opts: RunAvdPassOptions): Promise<void> {
	const { inputPath, outputPath, engine, level, params, device, range, onProgress, signal } = opts;

	if (signal?.aborted) throw new CancelledError();

	const fmt = opts.format ?? (await probeStreamFormat(inputPath));
	const pixFmt = toAvdPixFmt(fmt.pixFmt);
	const piped = !!range || pixFmt !== fmt.pixFmt;

	const avdArgs = [AVD_BIN, ...buildAvdArgs(engine, level, params, device, piped ? "-" : inputPath)];
	const encodeArgs = ["ffmpeg", "-y", "-f", "yuv4mpegpipe", "-i", "-", ...buildRetagArgs(fmt), ...FFV1_ENCODE_ARGS, "-an", "-sn", outputPath];

	const stages: string[][] = [];
	if (piped) {
		const seek = range ? segmentCutArgs(range) : [];
		// -strict -1 is required for FFmpeg to write 10/12-bit y4m. Without -fps_mode passthrough a cut that
		// lands between frames makes FFmpeg pad the constant-rate y4m stream with a duplicate frame.
		stages.push([
			"ffmpeg",
			"-v",
			"error",
			"-nostats",
			...seek,
			"-i",
			inputPath,
			"-map",
			"0:v:0",
			"-pix_fmt",
			pixFmt,
			"-fps_mode",
			"passthrough",
			"-strict",
			"-1",
			"-f",
			"yuv4mpegpipe",
			"-",
		]);
	}
	stages.push(avdArgs, encodeArgs);

	Logger.debug(`[avd] ${avdArgs.join(" ")}`);

	const startedAt = Date.now();
	let lastUpdate = 0;
	const { code, errLines } = await runPipeline(stages, signal, (line) => {
		const m = line.match(/frame=\s*(\d+)/);
		if (!m) return false;
		const now = Date.now();
		if (now - lastUpdate >= 1000) {
			lastUpdate = now;
			const current = parseInt(m[1]!, 10);
			onProgress?.(current, computeFps(current, startedAt));
		}
		return true;
	});

	if (signal?.aborted) throw new CancelledError();

	if (code !== 0) {
		throw new Error(`${avdEngineLabel(engine)} denoise failed (level=${level}, exit=${code}):\n${errorTail(errLines)}`);
	}
}

function errorTail(errLines: string[]): string {
	return errLines
		.filter((l) => !/\bWARN\b/.test(l))
		.slice(-12)
		.join("\n");
}

/**
 * Run `stages` as one shell pipeline and collect stderr.
 * `onLine` returns true for lines it consumed (progress), which are then kept out of the error tail.
 */
async function runPipeline(
	stages: string[][],
	signal: AbortSignal | undefined,
	onLine?: (line: string) => boolean,
): Promise<{ code: number; errLines: string[] }> {
	const script = `set -o pipefail; ${stages.map((s) => s.map(shQuote).join(" ")).join(" | ")}`;

	// setsid puts the whole pipeline in its own process group so one signal stops every stage.
	const proc = Bun.spawn(["setsid", "bash", "-c", script], {
		stdout: "ignore",
		stderr: "pipe",
		env: { ...process.env, NO_COLOR: "1" },
	});

	const killGroup = (sig: NodeJS.Signals) => {
		try {
			process.kill(-proc.pid, sig);
		} catch {
			try {
				proc.kill(sig);
			} catch {}
		}
	};
	const onAbort = () => {
		killGroup("SIGTERM");
		setTimeout(() => killGroup("SIGKILL"), 3000);
	};
	if (signal) {
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	}

	const errLines: string[] = [];
	const stderrTask = (async () => {
		const reader = proc.stderr.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		while (true) {
			const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const parts = buffer.split(/[\r\n]/);
			buffer = parts.pop() || "";
			for (const part of parts) {
				if (!part.trim() || onLine?.(part)) continue;
				errLines.push(part);
				if (errLines.length > 200) errLines.shift();
			}
		}
		if (buffer.trim()) errLines.push(buffer);
	})();

	const [code] = await Promise.all([proc.exited, stderrTask]);
	signal?.removeEventListener("abort", onAbort);

	return { code, errLines };
}

export interface AvdBenchmarkSource {
	size: string;
	rate: number;
	duration: number;
}

/**
 * Time one engine at one level on FFmpeg's synthetic testsrc2, using the default
 * parameters so numbers are comparable across installations.
 *
 * A one-second warm-up runs first: av-denoise compiles its GPU kernels on first
 * use and caches them, which would otherwise be billed to the measured run.
 * Returns wall-clock seconds for the measured run.
 */
export async function benchmarkAvd(
	engine: AvdEngine,
	level: DenoiseRange["level"],
	device: string,
	source: AvdBenchmarkSource,
	signal?: AbortSignal,
): Promise<{ seconds: number | null; error: string | null }> {
	const avdArgs = [AVD_BIN, ...buildAvdArgs(engine, level, DEFAULT_AVD_PARAMS, device, "-")];
	const stagesFor = (duration: number): string[][] => [
		[
			"ffmpeg",
			"-v",
			"error",
			"-nostats",
			"-f",
			"lavfi",
			"-i",
			`testsrc2=size=${source.size}:rate=${source.rate}:duration=${duration}`,
			"-pix_fmt",
			"yuv420p",
			"-f",
			"yuv4mpegpipe",
			"-",
		],
		avdArgs,
	];

	const warmUp = await runPipeline(stagesFor(1), signal);
	if (signal?.aborted) return { seconds: null, error: "cancelled" };
	if (warmUp.code !== 0) return { seconds: null, error: errorTail(warmUp.errLines).slice(-500) || `av-denoise exited with code ${warmUp.code}` };

	const startedAt = performance.now();
	const res = await runPipeline(stagesFor(source.duration), signal);
	const seconds = (performance.now() - startedAt) / 1000;
	if (signal?.aborted) return { seconds: null, error: "cancelled" };
	if (res.code !== 0) return { seconds: null, error: errorTail(res.errLines).slice(-500) || `av-denoise exited with code ${res.code}` };

	return { seconds, error: null };
}

/**
 * Auto-denoise with av-denoise via segmentation.
 *
 * Each plan range is denoised at its level, gaps are passed through, and the
 * segments are concatenated. The input must be FFV1 so cuts are frame-accurate.
 * Within a range av-denoise still measures the noise itself, and the level only
 * picks the strength from `params`.
 */
export async function runSegmentedAutoDenoiseAvd(
	inputPath: string,
	outputPath: string,
	plan: DenoisePlan,
	totalDuration: number,
	engine: AvdEngine,
	params: AvdParams,
	device: string,
	tempDir: string,
	onProgress: (i: number, n: number, label: string) => void,
	signal?: AbortSignal,
): Promise<void> {
	const format = await probeStreamFormat(inputPath);
	const pixFmt = toAvdPixFmt(format.pixFmt);
	if (pixFmt !== format.pixFmt) {
		Logger.warn(`[avd] Source is ${format.pixFmt}; converting to ${pixFmt} for av-denoise.`);
	}

	await runSegmentedPass(
		inputPath,
		outputPath,
		buildSegmentList(mergeEqualStrengthRanges(plan, engine, params), totalDuration),
		tempDir,
		async (seg, segFile) => {
			if (seg.level !== null) {
				await runAvdPass({ inputPath, outputPath: segFile, engine, level: seg.level, params, device, range: seg, format, signal });
				return;
			}

			const ss = seg.start.toFixed(3);
			const to = seg.end.toFixed(3);
			const res = await run(["ffmpeg", "-y", ...segmentCutArgs(seg), "-i", inputPath, "-pix_fmt", pixFmt, ...FFV1_ENCODE_ARGS, "-an", "-sn", segFile], {
				signal,
			});
			if (res.code !== 0) {
				throw new Error(`Passthrough segment [${ss} to ${to}] failed: ${res.stderr.slice(-500)}`);
			}
		},
		onProgress,
		signal,
	);
}
