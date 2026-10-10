import { Logger } from "../core/logger";
import { isOpenClAvailable, isVulkanAvailable, DEFAULT_NLMEANS_PARAMS, formatNlmeansParams, defaultDeviceFor } from "./filters";
import { getAllJobs } from "../queue/store";
import { getCpuName } from "../core/system";
import { listOpenClDevices, type OpenClDevice } from "./opencl";
import { listVulkanDevices, type VulkanDevice } from "./vulkan";
import { AVD_ENGINES, avdEngineLabel, benchmarkAvd, isAvdDeviceAvailable, isAvdEngine } from "./avd";
import type { AvdEngine, DenoiseBackend } from "../core/types";

const DURATION = 10;
const SIZE = "1920x1080";
const RATE = 24;
const TOTAL_FRAMES = DURATION * RATE;
const VULKAN_T = "8";

export type BenchmarkLevel = "light" | "medium" | "heavy";
export type BenchmarkMode = "cpu" | "opencl" | "vulkan" | AvdEngine;
export const BENCHMARK_MODES: readonly BenchmarkMode[] = ["cpu", "opencl", "vulkan", ...AVD_ENGINES];
export type BenchmarkStatus = "idle" | "running" | "completed" | "failed" | "cancelled";

export interface StartBenchmarkOptions {
	gpuDevice: string;
	denoiseBackend: DenoiseBackend;
	avdDevice: string;
	/** Which engines to benchmark. Omitted or empty means every engine available on this machine. */
	modes?: BenchmarkMode[];
}

export interface BenchmarkResult {
	mode: BenchmarkMode;
	level: BenchmarkLevel;
	fps: number | null;
	ffmpegFps: number | null;
	speed: string | null;
	rtime: number | null;
	utime: number | null;
	stime: number | null;
	error: string | null;
}

export interface BenchmarkState {
	status: BenchmarkStatus;
	startedAt: number | null;
	completedAt: number | null;
	duration: number;
	size: string;
	rate: number;
	totalFrames: number;
	totalSteps: number;
	currentStep: number;
	currentLabel: string | null;
	results: BenchmarkResult[];
	openclAvailable: boolean | null;
	vulkanAvailable: boolean | null;
	/** Whether av-denoise can see the configured device. */
	avdAvailable: boolean | null;
	avdDevice: string | null;
	/** Engines included in the current / last run. */
	modes: BenchmarkMode[];
	error: string | null;
	cpuName: string | null;
	gpuName: string | null;
	openclName: string | null;
	vulkanName: string | null;
	gpuDevice: string | null;
	denoiseBackend: DenoiseBackend | null;
	gpuAvailable: boolean | null;
}

let state: BenchmarkState = newIdleState();
let abortController: AbortController | null = null;

function newIdleState(): BenchmarkState {
	return {
		status: "idle",
		startedAt: null,
		completedAt: null,
		duration: DURATION,
		size: SIZE,
		rate: RATE,
		totalFrames: TOTAL_FRAMES,
		totalSteps: 9,
		currentStep: 0,
		currentLabel: null,
		results: [],
		openclAvailable: null,
		vulkanAvailable: null,
		avdAvailable: null,
		avdDevice: null,
		modes: [],
		error: null,
		cpuName: getCpuName(),
		gpuName: null,
		openclName: null,
		vulkanName: null,
		gpuDevice: null,
		denoiseBackend: null,
		gpuAvailable: null,
	};
}

/**
 * Bench picks a GPU label given the user's chosen backend; for `cpu` we just
 * surface the available device names so the user knows what's there.
 */
function pickGpuName(
	backend: DenoiseBackend,
	gpuDevice: string,
	oclDevices: OpenClDevice[],
	vkDevices: VulkanDevice[],
): { gpuName: string | null; openclName: string | null; vulkanName: string | null } {
	const oclMatch = oclDevices.find((d) => d.id === gpuDevice) ?? oclDevices[0] ?? null;
	const vkMatch = vkDevices.find((d) => d.id === gpuDevice) ?? vkDevices[0] ?? null;

	const openclName = oclMatch?.deviceName ?? null;
	const vulkanName = vkMatch?.deviceName ?? null;

	let gpuName: string | null;
	if (backend === "vulkan") {
		gpuName = vulkanName ?? openclName;
	} else if (backend === "opencl") {
		gpuName = openclName ?? vulkanName;
	} else {
		// auto / cpu — show whatever we have
		gpuName = vulkanName ?? openclName;
	}

	return { gpuName, openclName, vulkanName };
}

export async function getBenchmarkState(currentGpuDevice: string, currentBackend: DenoiseBackend, currentAvdDevice: string): Promise<BenchmarkState> {
	if (state.status !== "running") {
		state.cpuName = getCpuName();
		state.gpuDevice = currentGpuDevice;
		state.denoiseBackend = currentBackend;
		state.avdDevice = currentAvdDevice;
		state.avdAvailable = await isAvdDeviceAvailable(currentAvdDevice);

		const [oclDevices, vkDevices] = await Promise.all([listOpenClDevices(), listVulkanDevices()]);
		const names = pickGpuName(currentBackend, currentGpuDevice, oclDevices, vkDevices);
		state.gpuName = names.gpuName;
		state.openclName = names.openclName;
		state.vulkanName = names.vulkanName;
	}
	return state;
}

export function isBenchmarkRunning(): boolean {
	return state.status === "running";
}

function isAnythingEncoding(): boolean {
	return getAllJobs().some((j) => j.status !== "queued" && j.status !== "done" && j.status !== "error" && j.status !== "cancelled");
}

function findLastNumber(text: string, regex: RegExp): number | null {
	let last: number | null = null;
	for (const m of text.matchAll(regex)) {
		const v = parseFloat(m[1]!);
		if (!isNaN(v)) last = v;
	}
	return last;
}

function findLastString(text: string, regex: RegExp): string | null {
	let last: string | null = null;
	for (const m of text.matchAll(regex)) {
		last = m[1]!;
	}
	return last;
}

async function runFfmpeg(args: string[], signal: AbortSignal): Promise<{ code: number; stderr: string }> {
	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
	} catch (err: any) {
		return { code: -1, stderr: `Failed to spawn ffmpeg: ${err?.message || err}` };
	}

	const onAbort = () => {
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

	const [, stderr] = await Promise.all([
		new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
		new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
	]);
	const code = await proc.exited;

	signal.removeEventListener("abort", onAbort);

	return { code, stderr };
}

function buildArgs(mode: Exclude<BenchmarkMode, AvdEngine>, level: BenchmarkLevel, gpuDevice: string): string[] {
	// Use the defaults so benchmark numbers are comparable across installations regardless of user-supplied param overrides.
	const params = formatNlmeansParams(DEFAULT_NLMEANS_PARAMS[level]);
	const common = ["ffmpeg", "-hide_banner", "-benchmark", "-v", "info"];
	const inputAndOutput = ["-f", "lavfi", "-i", `testsrc2=size=${SIZE}:rate=${RATE}:duration=${DURATION}`];

	if (mode === "cpu") {
		return [...common, ...inputAndOutput, "-vf", `format=yuv420p,nlmeans=${params}`, "-f", "null", "-"];
	}

	if (mode === "opencl") {
		return [
			...common,
			"-init_hw_device",
			`opencl=gpu:${gpuDevice}`,
			"-filter_hw_device",
			"gpu",
			...inputAndOutput,
			"-vf",
			`format=yuv420p,hwupload,nlmeans_opencl=${params},hwdownload,format=yuv420p`,
			"-f",
			"null",
			"-",
		];
	}

	// vulkan
	return [
		...common,
		"-init_hw_device",
		`vulkan=gpu:${gpuDevice}`,
		"-filter_hw_device",
		"gpu",
		...inputAndOutput,
		"-vf",
		`format=yuv420p,hwupload,nlmeans_vulkan=${params}:t=${VULKAN_T},hwdownload,format=yuv420p`,
		"-f",
		"null",
		"-",
	];
}

async function runSingleAvd(mode: AvdEngine, level: BenchmarkLevel, avdDevice: string, signal: AbortSignal): Promise<BenchmarkResult> {
	const { seconds, error } = await benchmarkAvd(mode, level, avdDevice, { size: SIZE, rate: RATE, duration: DURATION }, signal);
	const fps = seconds && seconds > 0 ? Math.round((TOTAL_FRAMES / seconds) * 100) / 100 : null;
	return {
		mode,
		level,
		fps,
		ffmpegFps: null,
		speed: fps !== null ? `${(fps / RATE).toFixed(2)}x` : null,
		rtime: seconds,
		utime: null,
		stime: null,
		error,
	};
}

function modeLabel(mode: BenchmarkMode): string {
	if (isAvdEngine(mode)) return `GPU ${avdEngineLabel(mode)}`;
	return mode === "vulkan" ? "GPU nlmeans_vulkan" : mode === "opencl" ? "GPU nlmeans_opencl" : "CPU nlmeans";
}

async function runSingle(mode: Exclude<BenchmarkMode, AvdEngine>, level: BenchmarkLevel, gpuDevice: string, signal: AbortSignal): Promise<BenchmarkResult> {
	const args = buildArgs(mode, level, gpuDevice);
	const { code, stderr } = await runFfmpeg(args, signal);

	if (code !== 0) {
		const tail = stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 500);
		return {
			mode,
			level,
			fps: null,
			ffmpegFps: null,
			speed: null,
			rtime: null,
			utime: null,
			stime: null,
			error: tail || `ffmpeg exited with code ${code}`,
		};
	}

	const rtime = findLastNumber(stderr, /rtime=\s*([\d.]+)/g);
	const utime = findLastNumber(stderr, /utime=\s*([\d.]+)/g);
	const stime = findLastNumber(stderr, /stime=\s*([\d.]+)/g);
	const ffmpegFps = findLastNumber(stderr, /\bfps=\s*([\d.]+)/g);
	const speed = findLastString(stderr, /\bspeed=\s*([\d.]+x)/g);
	const fps = rtime && rtime > 0 ? Math.round((TOTAL_FRAMES / rtime) * 100) / 100 : null;

	if (rtime === null) {
		const tail = stderr.trim().split("\n").slice(-6).join(" | ").slice(0, 800);
		Logger.warn(
			`[benchmark] Could not parse rtime from ffmpeg stderr ` +
				`(stderr length=${stderr.length}, mode=${mode}, level=${level}). ` +
				`Last lines: ${tail || "<empty>"}`,
		);
	}

	return { mode, level, fps, ffmpegFps, speed, rtime, utime, stime, error: null };
}

export interface StartResult {
	ok: boolean;
	error?: string;
}

export async function startBenchmark(options: StartBenchmarkOptions): Promise<StartResult> {
	if (state.status === "running") return { ok: false, error: "Benchmark already running" };
	if (isAnythingEncoding()) return { ok: false, error: "Cannot run benchmark while encoding is in progress" };

	abortController = new AbortController();
	state = { ...newIdleState(), status: "running", startedAt: Date.now() };

	runBenchmarkAsync(abortController.signal, options).catch((err) => {
		Logger.error(`[benchmark] Unhandled error: ${err?.message || err}`);
		state.status = "failed";
		state.error = err?.message || String(err);
		state.completedAt = Date.now();
	});

	return { ok: true };
}

export function cancelBenchmark(): boolean {
	if (state.status !== "running") return false;
	abortController?.abort();
	state.status = "cancelled";
	state.completedAt = Date.now();
	return true;
}

async function runBenchmarkAsync(signal: AbortSignal, options: StartBenchmarkOptions): Promise<void> {
	Logger.info(`[benchmark] Starting denoise benchmark (backend=${options.denoiseBackend}, device=${options.gpuDevice})`);

	state.cpuName = getCpuName();
	state.gpuDevice = options.gpuDevice;
	state.denoiseBackend = options.denoiseBackend;

	const [oclDevices, vkDevices] = await Promise.all([listOpenClDevices(), listVulkanDevices()]);
	const names = pickGpuName(options.denoiseBackend, options.gpuDevice, oclDevices, vkDevices);
	state.gpuName = names.gpuName;
	state.openclName = names.openclName;
	state.vulkanName = names.vulkanName;

	const requested = options.modes && options.modes.length > 0 ? BENCHMARK_MODES.filter((m) => options.modes!.includes(m)) : [...BENCHMARK_MODES];
	const wantsAvd = requested.some(isAvdEngine);

	state.currentLabel = "Probing GPU backends";
	const oclDevice = oclDevices.find((d) => d.id === options.gpuDevice)?.id ?? oclDevices[0]?.id ?? defaultDeviceFor("opencl");
	const vkDevice = vkDevices.find((d) => d.id === options.gpuDevice)?.id ?? vkDevices[0]?.id ?? defaultDeviceFor("vulkan");

	const [oclOk, vkOk, avdOk] = await Promise.all([
		requested.includes("opencl") ? isOpenClAvailable(oclDevice) : Promise.resolve(null),
		requested.includes("vulkan") ? isVulkanAvailable(vkDevice) : Promise.resolve(null),
		wantsAvd ? isAvdDeviceAvailable(options.avdDevice) : Promise.resolve(null),
	]);
	state.openclAvailable = oclOk;
	state.vulkanAvailable = vkOk;
	state.avdAvailable = avdOk;
	state.avdDevice = options.avdDevice;
	state.gpuAvailable = !!oclOk || !!vkOk || !!avdOk;
	if (oclOk === false) Logger.warn(`[benchmark] OpenCL not available on device ${oclDevice}`);
	if (vkOk === false) Logger.warn(`[benchmark] Vulkan not available on device ${vkDevice}`);
	if (avdOk === false) Logger.warn(`[benchmark] av-denoise cannot see device ${options.avdDevice}`);

	if (signal.aborted) {
		state.status = "cancelled";
		state.completedAt = Date.now();
		return;
	}

	const levels: BenchmarkLevel[] = ["light", "medium", "heavy"];
	const modes = requested.filter((m) => (m === "cpu" ? true : m === "opencl" ? !!oclOk : m === "vulkan" ? !!vkOk : !!avdOk));

	state.modes = modes;
	state.totalSteps = levels.length * modes.length;

	for (const mode of modes) {
		for (const level of levels) {
			if (signal.aborted) {
				state.status = "cancelled";
				state.completedAt = Date.now();
				return;
			}

			state.currentStep++;
			state.currentLabel = `${modeLabel(mode)} - ${level}`;
			Logger.info(`[benchmark] ${state.currentLabel}`);

			const result = isAvdEngine(mode)
				? await runSingleAvd(mode, level, options.avdDevice, signal)
				: await runSingle(mode, level, mode === "vulkan" ? vkDevice : oclDevice, signal);
			if (signal.aborted) {
				state.status = "cancelled";
				state.completedAt = Date.now();
				return;
			}
			state.results.push(result);

			if (result.error) {
				Logger.warn(`[benchmark] ${state.currentLabel} failed: ${result.error}`);
			} else {
				const fpsStr = result.fps !== null ? result.fps.toFixed(2) : "?";
				const rtimeStr = result.rtime !== null ? result.rtime.toFixed(2) : "?";
				const speedStr = result.speed ?? "?";
				Logger.info(`[benchmark] ${state.currentLabel} → ${fpsStr} fps (rtime=${rtimeStr}s, speed=${speedStr})`);
			}
		}
	}

	state.status = "completed";
	state.currentLabel = null;
	state.completedAt = Date.now();
	Logger.info("[benchmark] Completed");
}
