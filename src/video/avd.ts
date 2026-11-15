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
import type { AvdEngine, AvdLevelStrengths, AvdParams, AvdPreset, AvdSelfTuningEngine, RabbitDenoiseParams, RabbitDevice } from "../core/types";

const AVD_BIN = "av-denoise";
const RABBIT_DENOISE_BIN = "rabbit-denoise";
/** Backends tried in order. The device ordinal is counted per backend. */
const AVD_ACCELERATORS = "vulkan,cuda";

/**
 * Every denoiser that runs as a program of its own: the av-denoise engines and
 * rabbit-denoise. They share the piped FFV1 pass below and differ in their arguments.
 */
export const AVD_ENGINES: readonly AvdEngine[] = ["rabbit-denoise", "avd-nlmeans", "avd-nlmeans-hq", "avd-nl4d"];

/** rabbit-denoise refuses a --sigma-scale outside this range. */
const RABBIT_SCALE_MIN = 0.25;
const RABBIT_SCALE_MAX = 4;

/** rabbit-denoise's own defaults. Values equal to these are not passed, so newer defaults apply. */
export const DEFAULT_RABBIT_PARAMS: RabbitDenoiseParams = {
	device: "auto",
	chromaScale: 1.0,
	lambda: 2.7,
	basic: false,
	step: 3,
	temporalRadius: 3,
	searchRadius: 5,
	matchesPerFrame: 2,
	minShift: 4,
	groupSize: 16,
	matchLimit: 2.0,
	wienerMatchLimit: 0.5,
	followRadius: null,
	wienerFollowRadius: null,
	motionRange: 16,
	motion: true,
	singleFrameCap: true,
	lumaGuidedChroma: true,
};

export const RABBIT_DEVICES: readonly RabbitDevice[] = ["auto", "gpu", "cpu"];

type RabbitNumberKey = {
	[K in keyof RabbitDenoiseParams]: RabbitDenoiseParams[K] extends number | null ? K : never;
}[keyof RabbitDenoiseParams];
type RabbitSwitchKey = "basic" | "motion" | "singleFrameCap" | "lumaGuidedChroma";

/**
 * rabbit-denoise's numeric options: its flag, the settings code key and the range it accepts.
 * Whole numbers are rounded. A null value, where allowed, lets rabbit-denoise choose.
 */
export const RABBIT_NUMBER_OPTIONS: readonly { key: RabbitNumberKey; flag: string; code: string; min: number; max: number; whole: boolean }[] = [
	{ key: "chromaScale", flag: "--chroma-scale", code: "qc", min: 0.25, max: 4, whole: false },
	{ key: "lambda", flag: "--lambda", code: "ql", min: 1, max: 6, whole: false },
	{ key: "step", flag: "--step", code: "qs", min: 1, max: 6, whole: true },
	{ key: "temporalRadius", flag: "--temporal-radius", code: "qt", min: 0, max: 16, whole: true },
	{ key: "searchRadius", flag: "--search-radius", code: "qr", min: 0, max: 7, whole: true },
	{ key: "matchesPerFrame", flag: "--matches-per-frame", code: "qm", min: 1, max: 8, whole: true },
	{ key: "minShift", flag: "--min-shift", code: "qn", min: 1, max: 8, whole: true },
	{ key: "groupSize", flag: "--group-size", code: "qg", min: 2, max: 16, whole: true },
	{ key: "matchLimit", flag: "--match-limit", code: "qk", min: 0.5, max: 8, whole: false },
	{ key: "wienerMatchLimit", flag: "--wiener-match-limit", code: "qw", min: 0.1, max: 4, whole: false },
	{ key: "followRadius", flag: "--follow-radius", code: "qf", min: 0, max: 7, whole: true },
	{ key: "wienerFollowRadius", flag: "--wiener-follow-radius", code: "qfw", min: 0, max: 7, whole: true },
	{ key: "motionRange", flag: "--motion-range", code: "qo", min: 0, max: 32, whole: true },
];

/** rabbit-denoise's switches: the flag passed when the value differs from the default, and the settings code key. */
export const RABBIT_SWITCH_OPTIONS: readonly { key: RabbitSwitchKey; flag: string; code: string }[] = [
	{ key: "basic", flag: "--basic", code: "qb" },
	{ key: "motion", flag: "--no-motion", code: "qmo" },
	{ key: "singleFrameCap", flag: "--no-single-frame-cap", code: "qsc" },
	{ key: "lumaGuidedChroma", flag: "--no-luma-guided-chroma", code: "qlg" },
];

/** A rabbit-denoise number within its range, or the fallback. */
function rabbitNumber(v: unknown, fallback: number | null, option: (typeof RABBIT_NUMBER_OPTIONS)[number]): number | null {
	if (v === null && (option.key === "followRadius" || option.key === "wienerFollowRadius")) return null;
	const n = typeof v === "number" ? v : parseFloat(String(v));
	if (!Number.isFinite(n)) return fallback;
	const clamped = Math.max(option.min, Math.min(option.max, n));
	return option.whole ? Math.round(clamped) : Math.round(clamped * 1000) / 1000;
}

/** Validate & clamp rabbit-denoise's options, filling anything missing from `fallback`. */
export function normalizeRabbitParams(p: Partial<RabbitDenoiseParams> | undefined | null, fallback: RabbitDenoiseParams): RabbitDenoiseParams {
	const out: RabbitDenoiseParams = { ...DEFAULT_RABBIT_PARAMS, ...fallback };
	out.device = p?.device && RABBIT_DEVICES.includes(p.device) ? p.device : out.device;
	for (const option of RABBIT_NUMBER_OPTIONS) {
		const value = p && option.key in p ? rabbitNumber(p[option.key], out[option.key], option) : out[option.key];
		(out as any)[option.key] = value;
	}
	for (const option of RABBIT_SWITCH_OPTIONS) {
		if (typeof p?.[option.key] === "boolean") out[option.key] = p[option.key]!;
	}
	return out;
}

/** rabbit-denoise's arguments for the options that differ from its defaults. */
export function rabbitOptionArgs(r: RabbitDenoiseParams): string[] {
	const args: string[] = [];
	for (const option of RABBIT_NUMBER_OPTIONS) {
		const value = r[option.key];
		if (value !== null && value !== DEFAULT_RABBIT_PARAMS[option.key]) args.push(option.flag, String(value));
	}
	for (const option of RABBIT_SWITCH_OPTIONS) {
		if (r[option.key] !== DEFAULT_RABBIT_PARAMS[option.key]) args.push(option.flag);
	}
	return args;
}

/** The program that runs an engine. */
function engineBinary(engine: AvdEngine): string {
	return engine === "rabbit-denoise" ? RABBIT_DENOISE_BIN : AVD_BIN;
}
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
	scales: { "avd-nlmeans-hq": 1.0, "avd-nl4d": 1.0, "rabbit-denoise": 1.0 },
	rabbit: DEFAULT_RABBIT_PARAMS,
};

export function isAvdSelfTuningEngine(engine: string | undefined | null): engine is AvdSelfTuningEngine {
	return engine === "avd-nlmeans-hq" || engine === "avd-nl4d" || engine === "rabbit-denoise";
}

/** The value passed to the engine's main dial for a scene at `level`. */
export function avdStrengthFor(engine: AvdEngine, level: DenoiseRange["level"], params: AvdParams): number {
	return isAvdSelfTuningEngine(engine) ? params.scales[engine] : params.nlmeansStrength[level];
}

/** NL4D always runs at its default preset, since the ladder changes little for it. rabbit-denoise has none. */
export function avdEngineUsesPreset(engine: AvdEngine): boolean {
	return engine !== "avd-nl4d" && engine !== "rabbit-denoise";
}

const AVD_ENGINE_LABELS: Record<AvdEngine, string> = {
	"avd-nlmeans": "AVD NLMeans",
	"avd-nlmeans-hq": "AVD NLMeans-HQ",
	"avd-nl4d": "AVD NL4D",
	"rabbit-denoise": "Rabbit Denoise",
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

function clampStrength(v: unknown, fallback: number, min = 0.1, max = 10): number {
	const n = typeof v === "number" ? v : parseFloat(String(v));
	if (!Number.isFinite(n)) return fallback;
	return Math.round(Math.max(min, Math.min(max, n)) * 1000) / 1000;
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
			"rabbit-denoise": clampStrength(p?.scales?.["rabbit-denoise"], fallback.scales["rabbit-denoise"] ?? 1, RABBIT_SCALE_MIN, RABBIT_SCALE_MAX),
		},
		rabbit: normalizeRabbitParams(p?.rabbit, fallback.rabbit ?? DEFAULT_RABBIT_PARAMS),
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
		// Without a real GPU, "default" resolves to the software device (lavapipe), which would run
		// for hours. Only offer "default" when there is an actual GPU behind it.
		if (!devices.some((d) => d.id !== "default")) return [];
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
 * Whether rabbit-denoise runs on a GPU here: it denoises one small frame with --device gpu.
 * rabbit-denoise picks the GPU itself, so there is no device to choose. Returns the reason when not.
 */
export async function probeRabbitDenoise(): Promise<string | null> {
	const script =
		"set -o pipefail; ffmpeg -v error -nostats -f lavfi -i testsrc2=size=64x64:rate=1:duration=1 -pix_fmt yuv420p -f yuv4mpegpipe - " +
		`| ${RABBIT_DENOISE_BIN} denoise --device gpu --progress json -o /dev/null`;
	try {
		const res = await run(["bash", "-c", script]);
		if (res.code === 0) return null;
		// The last JSON line is the error event with its message.
		for (const line of res.stdout.trim().split("\n").reverse()) {
			try {
				const event = JSON.parse(line);
				if (event?.event === "error" && typeof event.message === "string") return event.message;
			} catch {}
		}
		return res.stderr.trim().split("\n").slice(-3).join(" ") || `exit code ${res.code}`;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

/**
 * Fail with a clear message before any work starts when the engine cannot run. rabbit-denoise
 * set to auto falls back to the CPU instead, and the returned note says so.
 */
export async function assertAvdDeviceUsable(engine: AvdEngine, device: string, params?: AvdParams): Promise<string | null> {
	if (engine === "rabbit-denoise") {
		const rabbitDevice = params?.rabbit?.device ?? DEFAULT_RABBIT_PARAMS.device;
		if (rabbitDevice === "cpu") return "Rabbit Denoise runs on the CPU, as set, about 20 times slower than on a GPU.";
		const problem = await probeRabbitDenoise();
		if (!problem) return null;
		if (rabbitDevice === "gpu") {
			throw new Error(`Rabbit Denoise cannot run on a GPU: ${problem}. Pass a GPU through to the container, or set its device to auto to use the CPU.`);
		}
		return `Rabbit Denoise found no usable GPU (${problem}) and runs on the CPU, about 20 times slower.`;
	}
	const devices = await listAvdDevices();
	if (devices.some((d) => d.id === device)) return null;
	const found =
		devices.length > 0 ? `Available devices: ${devices.map((d) => d.id).join(", ")}.` : "av-denoise found no GPU (only a software device, or none at all).";
	throw new Error(
		`${avdEngineLabel(engine)} cannot run on device "${device}". ${found} av-denoise has no CPU fallback: pass a GPU through to the container or switch the denoiser to nlmeans.`,
	);
}

/**
 * Build the av-denoise argv (without the binary name) for one engine at one level.
 * `input` is a file path, or "-" for y4m on stdin.
 */
export function buildAvdArgs(engine: AvdEngine, level: DenoiseRange["level"], params: AvdParams, device: string, input: string): string[] {
	const strength = String(avdStrengthFor(engine, level, params));
	if (engine === "rabbit-denoise") {
		// y4m in and out. It picks the GPU itself. Only options that differ from its defaults are passed.
		const rabbit = params.rabbit ?? DEFAULT_RABBIT_PARAMS;
		return ["denoise", "-q", "--device", rabbit.device, "--sigma-scale", strength, ...rabbitOptionArgs(rabbit), input];
	}
	const common = ["--accelerators", AVD_ACCELERATORS, "--device", isValidAvdDeviceSpec(device) ? device : DEFAULT_AVD_DEVICE];
	if (avdEngineUsesPreset(engine)) common.push("--preset", params.preset);

	// The inputs are temp files that later passes rename over, so a BestSource index beside them would go stale.
	const io = ["--no-index-cache", "--input", input];

	if (engine === "avd-nl4d") {
		return [...common, "nl4d", "--lambda-ht-scale", strength, ...io];
	}
	if (engine === "avd-nlmeans-hq") {
		return [...common, "nlmeans", "--variant", "hq", "--hq-sigma-scale", strength, ...io];
	}
	return [...common, "nlmeans", "--variant", "fast", "--strength", strength, ...io];
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
	/** `outSeconds` is how much video has been written so far, when FFmpeg reports it. */
	onProgress?: (currentFrames: number, fpsStr: string | null, outSeconds: number | null) => void;
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
	// rabbit-denoise always reads the y4m FFmpeg decodes, which keeps the stream as this pass sees it.
	const piped = !!range || pixFmt !== fmt.pixFmt || engine === "rabbit-denoise";

	const avdArgs = [engineBinary(engine), ...buildAvdArgs(engine, level, params, device, piped ? "-" : inputPath)];
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
			const t = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
			const outSeconds = t ? parseInt(t[1]!, 10) * 3600 + parseInt(t[2]!, 10) * 60 + parseFloat(t[3]!) : null;
			onProgress?.(current, computeFps(current, startedAt), outSeconds);
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
	// rabbit-denoise is timed on the GPU only: on the CPU this would take many minutes.
	const params = engine === "rabbit-denoise" ? { ...DEFAULT_AVD_PARAMS, rabbit: { ...DEFAULT_RABBIT_PARAMS, device: "gpu" as const } } : DEFAULT_AVD_PARAMS;
	const avdArgs = [engineBinary(engine), ...buildAvdArgs(engine, level, params, device, "-")];
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
	if (warmUp.code !== 0) return { seconds: null, error: errorTail(warmUp.errLines).slice(-500) || `${engineBinary(engine)} exited with code ${warmUp.code}` };

	const startedAt = performance.now();
	const res = await runPipeline(stagesFor(source.duration), signal);
	const seconds = (performance.now() - startedAt) / 1000;
	if (signal?.aborted) return { seconds: null, error: "cancelled" };
	if (res.code !== 0) return { seconds: null, error: errorTail(res.errLines).slice(-500) || `${engineBinary(engine)} exited with code ${res.code}` };

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

	const segments = buildSegmentList(mergeEqualStrengthRanges(plan, engine, params), totalDuration);
	const segmentCount = segments.length;

	await runSegmentedPass(
		inputPath,
		outputPath,
		segments,
		tempDir,
		async (seg, segFile, index) => {
			if (seg.level !== null) {
				const label = `${seg.level} ${seg.start.toFixed(1)} to ${seg.end.toFixed(1)}s`;
				const length = Math.max(0.001, seg.end - seg.start);
				await runAvdPass({
					inputPath,
					outputPath: segFile,
					engine,
					level: seg.level,
					params,
					device,
					range: seg,
					format,
					signal,
					// Report progress inside the segment: a long NL4D range can run for minutes.
					onProgress: (frames, fps, outSeconds) => {
						const frac = outSeconds === null ? 0 : Math.min(0.999, outSeconds / length);
						onProgress(index + frac, segmentCount, `${label}, ${frames} frames${fps ? ` @ ${fps} fps` : ""}`);
					},
				});
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
