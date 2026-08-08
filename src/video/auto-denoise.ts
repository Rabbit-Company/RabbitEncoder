import { join } from "path";
import { readFileSync, existsSync, unlinkSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { Logger } from "../core/logger";
import { CancelledError, run } from "../core/process";
import { formatNlmeansParams, isOpenClAvailable, isVulkanAvailable, defaultDeviceFor } from "./filters";
import type { AutoDenoiseThresholds, DenoiseBackend, GpuBackend, NlmeansLevelParams } from "../core/types";

export const DEFAULT_AUTO_THRESHOLDS: AutoDenoiseThresholds = {
	light: 0.5,
	medium: 0.7,
	heavy: 0.9,
};

export interface DenoiseRange {
	/** Start time in seconds (inclusive). */
	start: number;
	/** End time in seconds (inclusive). */
	end: number;
	level: "light" | "medium" | "heavy";
}

export const FFV1_ENCODE_ARGS = ["-c:v", "ffv1", "-level", "3", "-coder", "1", "-context", "1", "-g", "1", "-slices", "24", "-slicecrc", "1", "-threads", "0"];

interface StreamFormat {
	pixFmt: string;
	colorRange?: string;
	colorPrimaries?: string;
	colorTrc?: string;
	colorSpace?: string;
}

async function probeStreamFormat(inputPath: string): Promise<StreamFormat> {
	const proc = Bun.spawn(
		[
			"ffprobe",
			"-v",
			"error",
			"-select_streams",
			"v:0",
			"-show_entries",
			"stream=pix_fmt,color_range,color_primaries,color_trc,color_space",
			"-of",
			"json",
			inputPath,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const out = await new Response(proc.stdout).text();
	await proc.exited;

	let s: any = {};
	try {
		s = JSON.parse(out)?.streams?.[0] ?? {};
	} catch {
		// fall through with defaults
	}

	const clean = (v: unknown): string | undefined => {
		if (typeof v !== "string") return undefined;
		const t = v.trim();
		if (!t || t === "unknown" || t === "N/A") return undefined;
		return t;
	};

	return {
		pixFmt: clean(s.pix_fmt) ?? "yuv420p",
		colorRange: clean(s.color_range),
		colorPrimaries: clean(s.color_primaries),
		colorTrc: clean(s.color_trc),
		colorSpace: clean(s.color_space),
	};
}

function isHighBitDepth(pixFmt: string): boolean {
	return /(?:p10|p12|p14|p16)(?:le|be)?$/.test(pixFmt);
}

function getEffectivePixFmt(sourcePixFmt: string): string {
	if (!isHighBitDepth(sourcePixFmt)) return sourcePixFmt;
	if (sourcePixFmt.startsWith("yuv444")) return "yuv444p";
	if (sourcePixFmt.startsWith("gbrp")) return "gbrp";
	return "yuv420p";
}

export type DenoisePlan = DenoiseRange[];

export interface AutoDenoiseConfig {
	/** The -vf filter string to inject into the prepare filter graph. Empty when work is deferred to segmented stage. */
	filter: string;
	/** Args to insert before -i (hw device init when GPU is used). */
	preInputArgs: string[];
	/** Whether the GPU path was selected. */
	isGpu: boolean;
	/** Which backend was selected, or null when running on CPU. */
	gpuBackend: GpuBackend | null;
	/** Human-readable label, e.g. "Auto denoise (12×light + 3×medium, GPU/Vulkan)". */
	label: string;
	/** Total seconds covered by the plan (for logging / progress reporting). */
	denoisedSeconds: number;
	/** When set, the prepare stage should defer denoising to runSegmentedAutoDenoiseGpu. */
	deferredPlan?: DenoisePlan;
	/** Backend to use for the deferred segmented pass. */
	deferredBackend?: GpuBackend;
	/** GPU device id resolved at probe time for the deferred segmented pass. */
	deferredGpuDevice?: string;
}

/**
 * Single span in a segmented denoise pass. `level === null` means the segment
 * is passthrough (stream-copied from the FFV1 intermediate); otherwise it's
 * re-encoded through the GPU nlmeans filter at the given level.
 */
export interface DenoiseSegment {
	start: number;
	end: number;
	level: DenoiseRange["level"] | null;
}

export interface NoiseSample {
	time: number;
	y: number;
}

/** Per-scene median noise value, as used by the classifier. */
export interface SceneNoise {
	start: number;
	end: number;
	median: number;
}

export interface RawNoiseAnalysis {
	samples: NoiseSample[];
	cuts: number[];
}

const SAMPLE_EVERY_N_FRAMES = 12;
const SCDET_THRESHOLD = 10;
const SCENE_DETECT_HEIGHT = 480;
const MIN_SCENE_DURATION = 1.0;

function buildDenoiseSegmentFilter(level: DenoiseRange["level"], backend: "opencl" | "vulkan", pixFmt: string, params: NlmeansLevelParams): string {
	const formatted = formatNlmeansParams(params[level]);
	if (backend === "vulkan") {
		return `format=${pixFmt},hwupload,nlmeans_vulkan=${formatted},hwdownload,format=${pixFmt}`;
	}
	return `format=${pixFmt},hwupload,nlmeans_opencl=${formatted},hwdownload,format=${pixFmt}`;
}

function buildColorArgs(fmt: StreamFormat): string[] {
	const args: string[] = [];
	if (fmt.colorRange) args.push("-color_range", fmt.colorRange);
	if (fmt.colorPrimaries) args.push("-color_primaries", fmt.colorPrimaries);
	if (fmt.colorTrc) args.push("-color_trc", fmt.colorTrc);
	if (fmt.colorSpace) args.push("-colorspace", fmt.colorSpace);
	return args;
}

/**
 * Parse three threshold env vars into an AutoDenoiseThresholds.
 * Falls back to defaults (with a warning) if values are missing, malformed,
 * or out of order.
 */
export function parseAutoThresholds(light: string | undefined, medium: string | undefined, heavy: string | undefined): AutoDenoiseThresholds {
	const fl = parseFloat(light || "");
	const fm = parseFloat(medium || "");
	const fh = parseFloat(heavy || "");

	const parsed: AutoDenoiseThresholds = {
		light: Number.isFinite(fl) ? fl : DEFAULT_AUTO_THRESHOLDS.light,
		medium: Number.isFinite(fm) ? fm : DEFAULT_AUTO_THRESHOLDS.medium,
		heavy: Number.isFinite(fh) ? fh : DEFAULT_AUTO_THRESHOLDS.heavy,
	};

	if (!(parsed.light <= parsed.medium && parsed.medium <= parsed.heavy)) {
		Logger.warn(
			`[auto-denoise] Thresholds out of order ` +
				`(light=${parsed.light}, medium=${parsed.medium}, heavy=${parsed.heavy}); ` +
				`require light ≤ medium ≤ heavy. Falling back to defaults.`,
		);
		return { ...DEFAULT_AUTO_THRESHOLDS };
	}

	return parsed;
}

/**
 * Run the scene-detection + noise-sampling ffmpeg pass and return the raw
 * samples/cuts, without classifying them into a denoise plan. Shared by
 * `runAnalysisPass` (auto-denoise) and the on-demand bitrate/noise chart.
 */
export async function runNoiseSceneAnalysis(inputPath: string, tempDir: string, totalDuration: number, signal?: AbortSignal): Promise<RawNoiseAnalysis | null> {
	const scenesLog = join(tempDir, "denoise_scenes.log");
	const noiseLog = join(tempDir, "denoise_noise.log");

	for (const p of [scenesLog, noiseLog]) {
		try {
			if (existsSync(p)) unlinkSync(p);
		} catch {}
	}

	Logger.info(`[auto-denoise] Running analysis pass on ${inputPath}`);

	// On short inputs (example: preview clips a few seconds long) the fused
	// dual-output filter graph occasionally hits a wrapped_avframe encoder race
	const SHORT_INPUT_THRESHOLD_SEC = 30;
	const useSplitPasses = totalDuration > 0 && totalDuration <= SHORT_INPUT_THRESHOLD_SEC;

	const stderrChunks: string[] = [];

	const spawnFfmpeg = async (args: string[], label: string): Promise<number> => {
		const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });

		let onAbort: (() => void) | undefined;
		if (signal) {
			onAbort = () => {
				try {
					proc.kill("SIGTERM");
				} catch {}
				setTimeout(() => {
					try {
						proc.kill("SIGKILL");
					} catch {}
				}, 3000);
			};
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}

		const stderrText = await new Response(proc.stderr).text().catch(() => "");
		const code = await proc.exited;

		if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		if (signal?.aborted) throw new CancelledError();

		if (code !== 0) stderrChunks.push(`[${label}] ${stderrText.trim()}`);
		return code;
	};

	let code = 0;

	if (useSplitPasses) {
		// Pass 1 - scene detection
		const sceneFilter = `scale=-2:${SCENE_DETECT_HEIGHT},scdet=s=1:t=${SCDET_THRESHOLD},` + `metadata=mode=print:file='${escapeFilterPath(scenesLog)}'`;

		code = await spawnFfmpeg(["ffmpeg", "-hide_banner", "-v", "error", "-i", inputPath, "-vf", sceneFilter, "-an", "-sn", "-f", "null", "-"], "scenes");

		// Pass 2 - noise sampling
		if (code === 0) {
			const noiseFilter =
				`select='not(mod(n\\,${SAMPLE_EVERY_N_FRAMES}))',` + `bitplanenoise=bitplane=4,` + `metadata=mode=print:file='${escapeFilterPath(noiseLog)}'`;

			code = await spawnFfmpeg(["ffmpeg", "-hide_banner", "-v", "error", "-i", inputPath, "-vf", noiseFilter, "-an", "-sn", "-f", "null", "-"], "noise");
		}
	} else {
		// Fused dual-output pass for long inputs.
		//   - split=2 fans the decoded stream into two parallel chains
		//   - chain A: downscale before scdet so cut detection is cheap; scdet
		//     must see consecutive frames, so no select before it
		//   - chain B: select samples first to drop ~91% of frames, then
		//     bitplanenoise measures noise on the survivors at full resolution
		//   - metadata=mode=print writes the lavfi.* k/v pairs to a file we
		//     parse later
		const filterComplex = [
			`[0:v]split=2[a][b];`,
			`[a]scale=-2:${SCENE_DETECT_HEIGHT},scdet=s=1:t=${SCDET_THRESHOLD},`,
			`metadata=mode=print:file='${escapeFilterPath(scenesLog)}'[s];`,
			`[b]select='not(mod(n\\,${SAMPLE_EVERY_N_FRAMES}))',`,
			`bitplanenoise=bitplane=4,`,
			`metadata=mode=print:file='${escapeFilterPath(noiseLog)}'[n]`,
		].join("");

		code = await spawnFfmpeg(
			[
				"ffmpeg",
				"-hide_banner",
				"-v",
				"error",
				"-i",
				inputPath,
				"-filter_complex",
				filterComplex,
				"-map",
				"[s]",
				"-an",
				"-sn",
				"-f",
				"null",
				"-",
				"-map",
				"[n]",
				"-an",
				"-sn",
				"-f",
				"null",
				"-",
			],
			"fused",
		);
	}

	if (code !== 0) {
		Logger.warn(`[auto-denoise] Analysis pass failed (exit ${code}): ${stderrChunks.join(" | ").slice(-500)}`);
		return null;
	}

	const cuts = parseSceneCuts(scenesLog);
	const samples = parseNoiseSamples(noiseLog);

	for (const p of [scenesLog, noiseLog]) {
		try {
			unlinkSync(p);
		} catch {}
	}

	if (samples.length === 0) {
		Logger.warn(`[auto-denoise] No noise samples parsed from ${noiseLog}, skipping auto denoise`);
		return null;
	}

	return { samples, cuts };
}

/**
 * Run the noise-scene analysis pass and classify the result into a denoise
 * plan using `thresholds`. Returns null if the analysis pass itself failed.
 */
export async function runAnalysisPass(
	inputPath: string,
	tempDir: string,
	totalDuration: number,
	thresholds: AutoDenoiseThresholds,
	signal?: AbortSignal,
): Promise<DenoisePlan | null> {
	const raw = await runNoiseSceneAnalysis(inputPath, tempDir, totalDuration, signal);
	if (!raw) return null;

	const plan = buildPlan(raw.samples, raw.cuts, totalDuration, thresholds);

	const totalDenoised = plan.reduce((s, r) => s + (r.end - r.start), 0);
	const pct = totalDuration > 0 ? (100 * totalDenoised) / totalDuration : 0;
	const counts = { light: 0, medium: 0, heavy: 0 };
	for (const r of plan) counts[r.level]++;
	Logger.info(
		`[auto-denoise] Plan: ${plan.length} ranges ` +
			`(${counts.light}×light + ${counts.medium}×medium + ${counts.heavy}×heavy), ` +
			`${totalDenoised.toFixed(1)}s denoised (${pct.toFixed(1)}% of ${totalDuration.toFixed(1)}s)`,
	);

	return plan;
}

/**
 * Build a DenoiseConfig-shaped object from a plan with user-supplied params.
 *
 * CPU path: chains one nlmeans per level, each gated by FFmpeg's `enable=`
 * timeline expression.
 *
 * GPU path: nlmeans_vulkan and nlmeans_opencl don't honor `enable=`, so
 * per-range gating doesn't work in a single filter graph. When `backend` is
 * a GPU backend that probes successfully, this returns a config with
 * `filter: ""` and `deferredPlan` set — the prepare stage detects this and
 * runs `runSegmentedAutoDenoiseGpu` after the scale/deband pass.
 *
 * If the GPU probe fails (or backend === "cpu"), falls back to CPU `enable=`
 * gating.
 *
 * Returns null if plan is empty (no scenes need denoising).
 */
export async function buildAutoDenoiseFilter(
	plan: DenoisePlan,
	backend: DenoiseBackend,
	gpuDevice: string | undefined,
	nlmeansParams: NlmeansLevelParams,
	totalDuration?: number,
): Promise<AutoDenoiseConfig | null> {
	if (plan.length === 0) return null;

	const byLevel = new Map<DenoiseRange["level"], DenoiseRange[]>();
	for (const r of plan) {
		const arr = byLevel.get(r.level);
		if (arr) arr.push(r);
		else byLevel.set(r.level, [r]);
	}

	const counts: Record<DenoiseRange["level"], number> = { light: 0, medium: 0, heavy: 0 };
	const seconds: Record<DenoiseRange["level"], number> = { light: 0, medium: 0, heavy: 0 };
	for (const r of plan) {
		counts[r.level]++;
		seconds[r.level] += r.end - r.start;
	}

	const showPct = totalDuration !== undefined && totalDuration > 0;
	const labelBits = (["light", "medium", "heavy"] as const)
		.filter((l) => counts[l] > 0)
		.map((l) => {
			if (showPct) {
				const pct = Math.round((100 * seconds[l]) / totalDuration!);
				return `${counts[l]}×${l} (${pct}%)`;
			}
			return `${counts[l]}×${l}`;
		});

	const denoisedSeconds = plan.reduce((s, r) => s + (r.end - r.start), 0);

	// GPU path: probe the requested backend(s); on success, defer to the
	// segmented stage. On failure, fall through to CPU.
	if (backend !== "cpu") {
		const probeResult = await probeGpuBackendForAutoDenoise(backend, gpuDevice);

		if (probeResult) {
			const tag = probeResult.backend === "vulkan" ? "GPU/Vulkan" : "GPU/OpenCL";
			Logger.info(`[auto-denoise] ${tag} verified on device ${probeResult.deviceId}; ` + `deferring ${plan.length} ranges to segmented pass`);

			return {
				filter: "",
				preInputArgs: [],
				isGpu: true,
				gpuBackend: probeResult.backend,
				label: `Auto denoise (${labelBits.join(" + ")}, ${tag})`,
				denoisedSeconds,
				deferredPlan: plan,
				deferredBackend: probeResult.backend,
				deferredGpuDevice: probeResult.deviceId,
			};
		}

		Logger.warn(
			`[auto-denoise] GPU backend (${backend}) requested but probe failed ` +
				`(gpuDevice=${gpuDevice ?? "default"}); falling back to CPU nlmeans with enable= gating`,
		);
	}

	// CPU path: single filter graph with per-level enable= timeline expressions.
	const filterParts: string[] = [];
	for (const level of ["light", "medium", "heavy"] as const) {
		const ranges = byLevel.get(level);
		if (!ranges || ranges.length === 0) continue;
		const formatted = formatNlmeansParams(nlmeansParams[level]);
		const enable = ranges.map((r) => `between(t,${r.start.toFixed(3)},${r.end.toFixed(3)})`).join("+");
		filterParts.push(`nlmeans=${formatted}:enable='${enable}'`);
	}

	return {
		filter: filterParts.join(","),
		preInputArgs: [],
		isGpu: false,
		gpuBackend: null,
		label: `Auto denoise (${labelBits.join(" + ")}, CPU)`,
		denoisedSeconds,
	};
}

/**
 * Probe the requested GPU backend(s) and return the first one that works.
 *   - backend = "opencl": probe OpenCL only.
 *   - backend = "vulkan": probe Vulkan only.
 *   - backend = "auto"  : probe Vulkan first, then OpenCL.
 *   - backend = "cpu"   : returns null (caller should already short-circuit).
 */
async function probeGpuBackendForAutoDenoise(backend: DenoiseBackend, gpuDevice?: string): Promise<{ backend: "opencl" | "vulkan"; deviceId: string } | null> {
	if (backend === "cpu") return null;

	const tryVulkan = async (): Promise<{ backend: "vulkan"; deviceId: string } | null> => {
		const deviceId = gpuDevice ?? defaultDeviceFor("vulkan");
		if (await isVulkanAvailable(deviceId)) return { backend: "vulkan", deviceId };
		return null;
	};

	const tryOpenCl = async (): Promise<{ backend: "opencl"; deviceId: string } | null> => {
		const deviceId = gpuDevice ?? defaultDeviceFor("opencl");
		if (await isOpenClAvailable(deviceId)) return { backend: "opencl", deviceId };
		return null;
	};

	if (backend === "vulkan") return tryVulkan();
	if (backend === "opencl") return tryOpenCl();
	return (await tryVulkan()) ?? (await tryOpenCl());
}

/**
 * Walk the sorted plan and fill gaps with passthrough segments so segments
 * fully cover [0, totalDuration]. Each plan range becomes one denoise segment;
 * gaps between/around them become passthrough segments.
 */
export function buildSegmentList(plan: DenoisePlan, totalDuration: number): DenoiseSegment[] {
	const sorted = [...plan].sort((a, b) => a.start - b.start);
	const out: DenoiseSegment[] = [];
	let cursor = 0;
	const EPS = 1e-3;

	for (const r of sorted) {
		if (r.start > cursor + EPS) {
			out.push({ start: cursor, end: r.start, level: null });
		}
		out.push({ start: r.start, end: r.end, level: r.level });
		cursor = r.end;
	}
	if (cursor < totalDuration - EPS) {
		out.push({ start: cursor, end: totalDuration, level: null });
	}

	return out;
}

async function encodeSegment(
	inputPath: string,
	outputPath: string,
	seg: DenoiseSegment,
	backend: "opencl" | "vulkan",
	gpuDevice: string,
	pixFmt: string,
	colorArgs: string[],
	nlmeansParams: NlmeansLevelParams,
	signal?: AbortSignal,
): Promise<void> {
	const ss = seg.start.toFixed(3);
	const to = seg.end.toFixed(3);

	if (seg.level === null) {
		const res = await run(
			["ffmpeg", "-y", "-ss", ss, "-to", to, "-i", inputPath, "-vf", `format=${pixFmt}`, ...FFV1_ENCODE_ARGS, ...colorArgs, "-an", "-sn", outputPath],
			{ signal },
		);
		if (res.code !== 0) {
			throw new Error(`Passthrough segment [${ss}–${to}] failed: ${res.stderr.slice(-500)}`);
		}
		return;
	}

	const deviceSpec = backend === "vulkan" ? `vulkan=gpu:${gpuDevice}` : `opencl=gpu:${gpuDevice}`;
	const filter = buildDenoiseSegmentFilter(seg.level, backend, pixFmt, nlmeansParams);

	const res = await run(
		[
			"ffmpeg",
			"-y",
			"-init_hw_device",
			deviceSpec,
			"-filter_hw_device",
			"gpu",
			"-ss",
			ss,
			"-to",
			to,
			"-i",
			inputPath,
			"-vf",
			filter,
			...FFV1_ENCODE_ARGS,
			...colorArgs,
			"-an",
			"-sn",
			outputPath,
		],
		{ signal },
	);

	if (res.code !== 0) {
		throw new Error(`Denoise segment [${seg.level} ${ss}–${to}] failed: ${res.stderr.slice(-500)}`);
	}
}

/**
 * GPU auto-denoise via segmentation.
 *
 * Splits the input into per-range segments (denoised) and gap segments
 * (passthrough), encodes each independently, and concats them back via the
 * concat demuxer. The input must be FFV1 (every frame is a keyframe) so that
 * fast keyframe seeks are frame-accurate and passthrough segments can
 * stream-copy without re-encoding.
 */
export async function runSegmentedAutoDenoiseGpu(
	inputPath: string,
	outputPath: string,
	plan: DenoisePlan,
	totalDuration: number,
	backend: GpuBackend,
	gpuDevice: string,
	tempDir: string,
	nlmeansParams: NlmeansLevelParams,
	onProgress: (i: number, n: number, label: string) => void,
	signal?: AbortSignal,
): Promise<void> {
	if (backend === "auto") {
		throw new Error(`runSegmentedAutoDenoiseGpu requires a resolved backend (opencl|vulkan), got "auto"`);
	}

	const segments = buildSegmentList(plan, totalDuration);
	if (segments.length === 0) {
		throw new Error("Segment list is empty; nothing to denoise");
	}

	const sourceFmt = await probeStreamFormat(inputPath);
	const effectivePixFmt = getEffectivePixFmt(sourceFmt.pixFmt);
	const colorArgs = buildColorArgs(sourceFmt);

	if (isHighBitDepth(sourceFmt.pixFmt)) {
		Logger.warn(`[auto-denoise] Source is ${sourceFmt.pixFmt}; converting to ${effectivePixFmt} for denoise. Output of the segmented stage will be 8-bit.`);
	}

	const segDir = join(tempDir, "denoise_segments");
	mkdirSync(segDir, { recursive: true });

	const segFiles: string[] = [];
	const listPath = join(segDir, "concat.txt");

	try {
		for (let i = 0; i < segments.length; i++) {
			if (signal?.aborted) throw new CancelledError();
			const seg = segments[i]!;
			const segFile = join(segDir, `seg_${String(i).padStart(5, "0")}.mkv`);
			const lvl = seg.level ?? "passthrough";
			const label = `${lvl} ${seg.start.toFixed(1)}–${seg.end.toFixed(1)}s`;

			onProgress(i, segments.length, label);
			Logger.debug(`[auto-denoise] Segment ${i + 1}/${segments.length}: ${label}`);

			await encodeSegment(inputPath, segFile, seg, backend, gpuDevice, effectivePixFmt, colorArgs, nlmeansParams, signal);
			segFiles.push(segFile);
		}

		const list = segFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n") + "\n";
		writeFileSync(listPath, list);

		if (signal?.aborted) throw new CancelledError();

		const res = await run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-an", "-sn", outputPath], { signal });
		if (res.code !== 0) {
			throw new Error(`Concat failed: ${res.stderr.slice(-500)}`);
		}

		onProgress(segments.length, segments.length, "Done");
	} finally {
		try {
			rmSync(segDir, { recursive: true, force: true });
		} catch {}
	}
}

/**
 * Walk scene-cut boundaries and compute the median noise value of the
 * samples falling in each scene. Shared by `buildPlan` (which classifies
 * each scene into a denoise level) and the on-demand bitrate/noise chart
 * (which just wants the median as a step-line series).
 */
export function groupSamplesByScene(samples: NoiseSample[], cuts: number[], totalDuration: number): SceneNoise[] {
	if (totalDuration <= 0) return [];

	const sortedCuts = cuts
		.slice()
		.sort((a, b) => a - b)
		.filter((c) => c > 0 && c < totalDuration);
	const boundaries = [0, ...sortedCuts, totalDuration];

	const scenes: SceneNoise[] = [];

	let sIdx = 0;
	for (let i = 0; i < boundaries.length - 1; i++) {
		const start = boundaries[i]!;
		const end = boundaries[i + 1]!;
		if (end <= start) continue;

		const ys: number[] = [];
		while (sIdx < samples.length && samples[sIdx]!.time < start) sIdx++;
		let probe = sIdx;
		while (probe < samples.length && samples[probe]!.time < end) {
			ys.push(samples[probe]!.y);
			probe++;
		}

		const sceneMedian = ys.length > 0 ? median(ys) : scenes.length > 0 ? scenes[scenes.length - 1]!.median : 0;
		scenes.push({ start, end, median: sceneMedian });
	}

	return scenes;
}

/**
 * Build the per-scene plan from raw samples and cut times.
 */
export function buildPlan(samples: NoiseSample[], cuts: number[], totalDuration: number, thresholds: AutoDenoiseThresholds): DenoisePlan {
	if (totalDuration <= 0) return [];

	type Scene = { start: number; end: number; level: "off" | "light" | "medium" | "heavy" };
	const scenes: Scene[] = groupSamplesByScene(samples, cuts, totalDuration).map((s) => ({
		start: s.start,
		end: s.end,
		level: classifyNoise(s.median, thresholds),
	}));

	for (let i = 0; i < scenes.length; i++) {
		const s = scenes[i]!;
		if (s.end - s.start >= MIN_SCENE_DURATION) continue;
		const prev = scenes[i - 1];
		const next = scenes[i + 1];
		if (prev && next) {
			const prevLen = prev.end - prev.start;
			const nextLen = next.end - next.start;
			s.level = prevLen >= nextLen ? prev.level : next.level;
		} else if (prev) {
			s.level = prev.level;
		} else if (next) {
			s.level = next.level;
		}
	}

	const plan: DenoisePlan = [];
	for (const s of scenes) {
		if (s.level === "off") continue;
		const last = plan[plan.length - 1];
		if (last && last.level === s.level && Math.abs(last.end - s.start) < 0.01) {
			last.end = s.end;
		} else {
			plan.push({ start: s.start, end: s.end, level: s.level });
		}
	}

	return plan;
}

function classifyNoise(value: number, t: AutoDenoiseThresholds): "off" | "light" | "medium" | "heavy" {
	if (value < t.light) return "off";
	if (value < t.medium) return "light";
	if (value < t.heavy) return "medium";
	return "heavy";
}

function median(values: number[]): number {
	const sorted = values.slice().sort((a, b) => a - b);
	const n = sorted.length;
	if (n === 0) return 0;
	if (n % 2 === 1) return sorted[(n - 1) / 2]!;
	return (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
}

function parseSceneCuts(path: string): number[] {
	if (!existsSync(path)) return [];
	const text = readFileSync(path, "utf8");
	const cuts: number[] = [];
	const re = /lavfi\.scd\.time=(\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const v = parseFloat(m[1]!);
		if (Number.isFinite(v)) cuts.push(v);
	}
	return cuts;
}

function parseNoiseSamples(path: string): NoiseSample[] {
	if (!existsSync(path)) return [];
	const text = readFileSync(path, "utf8");
	const samples: NoiseSample[] = [];
	const re = /pts_time:(\S+)[^]*?lavfi\.bitplanenoise\.0\.4=(\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const t = parseFloat(m[1]!);
		const y = parseFloat(m[2]!);
		if (Number.isFinite(t) && Number.isFinite(y)) samples.push({ time: t, y });
	}
	return samples;
}

function escapeFilterPath(p: string): string {
	return p.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:");
}
