import { existsSync, mkdirSync, rmSync, statSync } from "fs";
import { join } from "path";
import type {
	AppConfig,
	Job,
	JobSettings,
	PreviewFrameSink,
	SubtitleBurnMode,
	PreviewSample,
	PreviewSampleVsFrame,
	PreviewState,
	ProbeResult,
} from "../core/types";
import { probeFile } from "./probe";
import { CancelledError, humanSize, run } from "../core/process";
import { Logger } from "../core/logger";
import { encodeJob } from "./encoder";
import { analyzeSourceTracks } from "./source-analysis";
import { FFV1_ENCODE_ARGS } from "../video/auto-denoise";
import { vsRegistry } from "../video/vs-filters";

export interface PreviewEncodeOptions {
	sampleCount: number;
	windowSeconds: number;
}

export const DEFAULT_PREVIEW_OPTIONS: PreviewEncodeOptions = { sampleCount: 6, windowSeconds: 5 };

export function previewDirFor(config: AppConfig, jobId: string): string {
	return join(config.tempDir, `${jobId}_preview`);
}

export function previewSettingsFingerprint(s: JobSettings): string {
	return JSON.stringify({
		quality: s.quality,
		finalSpeed: s.finalSpeed,
		denoise: s.denoise,
		denoiseBackend: s.denoiseBackend,
		gpuDevice: s.gpuDevice,
		deband: s.deband,
		downscale: s.downscale,
		skipBoosting: s.skipBoosting,
		nlmeansParams: s.nlmeansParams,
		gradfunParams: s.gradfunParams,
		autoDenoiseMetric: s.autoDenoiseMetric,
		autoDenoiseThresholds: s.autoDenoiseThresholds,
		autoDenoiseBitrateThresholds: s.autoDenoiseBitrateThresholds,
		vsFilters: s.vsFilters ?? [],
		subtitleProcessing: s.subtitleProcessing,
		audioEncode: s.audioEncode,
		convertSrtToAss: s.convertSrtToAss,
		restyleAssFont: s.restyleAssFont,
		removeUnusedFonts: s.removeUnusedFonts,
	});
}

interface PreviewColorInfo {
	range: "tv" | "pc" | null;
	space: string | null;
}

function previewMatrixFromColorSpace(space: string | null, height: number): string {
	if (space === "bt2020nc" || space === "bt2020c") return "bt2020";
	if (space === "smpte170m" || space === "bt470bg") return "bt601";
	if (space === "bt709") return "bt709";
	return height >= 720 ? "bt709" : "bt601";
}

async function probeColorInfo(inputPath: string): Promise<PreviewColorInfo> {
	const proc = Bun.spawn(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=color_range,color_space", "-of", "json", inputPath], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = await new Response(proc.stdout).text();
	await proc.exited;
	let s: any = {};
	try {
		s = JSON.parse(out)?.streams?.[0] ?? {};
	} catch {}
	const clean = (v: unknown): string | undefined => {
		if (typeof v !== "string") return undefined;
		const t = v.trim();
		return !t || t === "unknown" || t === "N/A" ? undefined : t;
	};
	const range = clean(s.color_range);
	const space = clean(s.color_space);
	return { range: range === "pc" ? "pc" : range === "tv" ? "tv" : null, space: space || null };
}

function escapeSubtitlesFilterPath(p: string): string {
	return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

/**
 * Sum of attachment sizes (fonts etc.) inside an MKV. These are per-file
 * constants, so they must be excluded from linear duration scaling.
 */
async function probeAttachmentBytes(path: string, signal: AbortSignal): Promise<number> {
	try {
		const res = await run(["mkvmerge", "-J", path], { signal });
		if (res.code !== 0 && res.code !== 1) return 0;
		const attachments: Array<{ size?: number }> = JSON.parse(res.stdout)?.attachments ?? [];
		return attachments.reduce((sum, a) => sum + (Number.isFinite(a.size) ? a.size! : 0), 0);
	} catch {
		return 0;
	}
}

/** Actual container duration of the encoded clip (audio packet cuts can drift from the requested window). */
async function probeClipDurationSec(path: string, signal: AbortSignal): Promise<number | null> {
	try {
		const res = await run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path], { signal });
		if (res.code !== 0) return null;
		const d = parseFloat(res.stdout.trim());
		return Number.isFinite(d) && d > 0 ? d : null;
	} catch {
		return null;
	}
}

async function captureFrame(
	inputPath: string,
	outPath: string,
	frameIndex: number,
	burnSubs: SubtitleBurnMode,
	color: PreviewColorInfo,
	probe: ProbeResult,
	signal: AbortSignal,
): Promise<void> {
	const inRange = color.range === "pc" ? "pc" : "tv";
	const matrix = previewMatrixFromColorSpace(color.space, probe.height);
	const targetFrame = Math.max(0, Math.round(frameIndex));

	const select = `select=eq(n\\,${targetFrame})`;
	const resetVideoPts = "setpts=PTS-STARTPTS";
	const colorChain = `scale=in_range=${inRange}:out_range=pc:in_color_matrix=${matrix}:out_color_matrix=bt709,format=rgb24,setparams=range=pc:colorspace=gbr:color_primaries=bt709:color_trc=iec61966-2-1`;

	let args: string[];
	if (burnSubs === "text") {
		const sub = `subtitles=filename='${escapeSubtitlesFilterPath(inputPath)}':si=0`;
		args = [
			"ffmpeg",
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-i",
			inputPath,
			"-map",
			"0:v:0",
			"-vf",
			`${resetVideoPts},${sub},${select},${colorChain}`,
			"-frames:v",
			"1",
			"-an",
			"-sn",
			"-map_metadata",
			"-1",
			"-update",
			"1",
			outPath,
		];
	} else if (burnSubs === "bitmap") {
		args = [
			"ffmpeg",
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-i",
			inputPath,
			"-filter_complex",
			`[0:v:0]${resetVideoPts}[base];[base][0:s:0]overlay,${select},${colorChain}[v]`,
			"-map",
			"[v]",
			"-frames:v",
			"1",
			"-an",
			"-sn",
			"-map_metadata",
			"-1",
			"-update",
			"1",
			outPath,
		];
	} else {
		args = [
			"ffmpeg",
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-i",
			inputPath,
			"-map",
			"0:v:0",
			"-vf",
			`${resetVideoPts},${select},${colorChain}`,
			"-frames:v",
			"1",
			"-an",
			"-sn",
			"-map_metadata",
			"-1",
			"-update",
			"1",
			outPath,
		];
	}

	const res = await run(args, { signal });
	if (res.code !== 0) Logger.warn(`[preview] Frame capture failed (${outPath}): ${res.stderr.slice(-300)}`);
}

/**
 * Build the preview input window. The primary video is decoded and written as
 * lossless FFV1 while audio, subtitles, and attachments are copied.
 */
async function cutSourceClip(inputPath: string, startSec: number, windowSec: number, outPath: string, signal: AbortSignal): Promise<void> {
	const res = await run(
		[
			"ffmpeg",
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-ss",
			startSec.toFixed(3),
			"-i",
			inputPath,
			"-t",
			windowSec.toFixed(3),
			"-map",
			"0:V:0", // primary real video
			"-map",
			"0:a?", // audio
			"-map",
			"0:s?", // subtitles
			"-map",
			"0:t?", // font attachments
			"-map_chapters",
			"-1",
			"-c",
			"copy",
			...FFV1_ENCODE_ARGS,
			"-fps_mode:v:0",
			"passthrough",
			"-avoid_negative_ts",
			"make_zero",
			outPath,
		],
		{ signal },
	);
	if (res.code !== 0) throw new Error(`Frame-accurate clip cut at ${startSec.toFixed(1)}s failed: ${res.stderr.slice(-500)}`);
}

function pickSampleTimestamps(duration: number, count: number, windowSeconds: number): number[] {
	if (count <= 0 || duration <= 0) return [];
	const headMargin = duration * 0.05;
	const tailMargin = duration * 0.05 + windowSeconds;
	const usable = duration - headMargin - tailMargin;
	if (usable <= 0) {
		const stamps: number[] = [];
		for (let i = 0; i < count; i++) stamps.push(Math.min(i * windowSeconds, Math.max(0, duration - windowSeconds)));
		return stamps;
	}
	const stamps: number[] = [];
	for (let i = 0; i < count; i++) {
		const frac = count === 1 ? 0.5 : i / (count - 1);
		stamps.push(headMargin + frac * usable);
	}
	return stamps;
}

function buildVsFrames(settings: JobSettings): PreviewSampleVsFrame[] {
	const active = (settings.vsFilters ?? []).filter((e) => e.level !== "off");
	const out: PreviewSampleVsFrame[] = [];
	active.forEach((entry, index) => {
		const manifest = vsRegistry.get(entry.presetId);
		if (!manifest) return;
		out.push({ index, presetId: entry.presetId, bareId: manifest.bareId, label: `${manifest.name} (${entry.level})` });
	});
	return out;
}

export interface RunPreviewArgs {
	job: Job;
	config: AppConfig;
	options?: Partial<PreviewEncodeOptions>;
	signal: AbortSignal;
	onUpdate: (partial: Partial<PreviewState>) => void;
}

export async function runPreviewEncode(args: RunPreviewArgs): Promise<PreviewSample[]> {
	const { job, config, signal, onUpdate } = args;
	const opts: PreviewEncodeOptions = { ...DEFAULT_PREVIEW_OPTIONS, ...(args.options || {}) };

	if (!existsSync(job.inputPath)) throw new Error("Source file no longer accessible");

	const probe: ProbeResult = job.probe ?? (await probeFile(job.inputPath));
	if (probe.duration <= opts.windowSeconds) {
		throw new Error(`Source is shorter than one preview window (${probe.duration.toFixed(1)}s ≤ ${opts.windowSeconds}s)`);
	}

	const baseDir = previewDirFor(config, job.id);
	try {
		rmSync(baseDir, { recursive: true, force: true });
	} catch {}
	mkdirSync(baseDir, { recursive: true });

	// Whole-source detection + colour info, ONCE.
	onUpdate({ progress: 0, currentDetail: "Analyzing source tracks" });
	const plan = await analyzeSourceTracks(probe, job.settings, job.inputPath, baseDir, signal);
	const colorInfo = await probeColorInfo(job.inputPath);
	const vsFrames = buildVsFrames(job.settings);
	Logger.info(`[preview] Plan: ${plan.subtitleStreams.length} subtitle, ${plan.audioStreams.length} audio track(s)`);

	const stamps = pickSampleTimestamps(probe.duration, opts.sampleCount, opts.windowSeconds);
	const comparisonFrame = Math.max(0, Math.round((opts.windowSeconds / 2) * probe.videoStreamFps));
	const completed: PreviewSample[] = [];

	for (let i = 0; i < stamps.length; i++) {
		if (signal.aborted) throw new CancelledError();

		const sampleDir = join(baseDir, `sample_${String(i).padStart(2, "0")}`);
		mkdirSync(sampleDir, { recursive: true });
		const report = (d: string) => onUpdate({ progress: Math.round((i / stamps.length) * 1000) / 10, currentDetail: `Sample ${i + 1}/${stamps.length} — ${d}` });

		try {
			report("Cutting clip");
			const clipPath = join(sampleDir, "source_clip.mkv");
			await cutSourceClip(job.inputPath, stamps[i]!, opts.windowSeconds, clipPath, signal);

			const sink: PreviewFrameSink = {
				dir: sampleDir,
				frameOffsetSec: opts.windowSeconds / 2,
				capture: (input, name, burn) => captureFrame(input, join(sampleDir, name), comparisonFrame, burn, colorInfo, probe, signal),
			};

			const clipJob: Job = { ...job, id: `${job.id}__pv${i}`, inputPath: clipPath, probe: undefined, replaceSource: false };
			report("Encoding clip");
			await encodeJob(clipJob, config, () => {}, signal, { mode: "preview", precomputed: plan, preview: sink });

			const encodedClip = join(sampleDir, "encoded.mkv");
			const sizeBytes = existsSync(encodedClip) ? statSync(encodedClip).size : 0;

			const attachmentBytes = sizeBytes > 0 ? await probeAttachmentBytes(encodedClip, signal) : 0;
			const clipDurationSec = sizeBytes > 0 ? ((await probeClipDurationSec(encodedClip, signal)) ?? opts.windowSeconds) : opts.windowSeconds;
			const streamBytes = Math.max(0, sizeBytes - attachmentBytes);
			const projectedTotalBytes = Math.round(attachmentBytes + (streamBytes / clipDurationSec) * probe.duration);

			completed.push({
				index: i,
				timestampSec: stamps[i]!,
				windowSeconds: opts.windowSeconds,
				encodedSizeBytes: sizeBytes,
				encodedSizeHuman: humanSize(sizeBytes),
				projectedTotalBytes,
				projectedTotalHuman: humanSize(projectedTotalBytes),
				encodedBitrateKbps: Math.round((streamBytes * 8) / 1000 / clipDurationSec),
				vsFrames,
				prepareFrames: [],
			});
			onUpdate({ samples: [...completed] });
		} catch (err) {
			if (err instanceof CancelledError) throw err;
			throw new Error(`Sample ${i + 1}/${stamps.length} failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	return completed;
}

export function resolvePreviewArtifact(config: AppConfig, jobId: string, sampleIndex: number, kind: string): string | null {
	const dir = join(previewDirFor(config, jobId), `sample_${String(sampleIndex).padStart(2, "0")}`);
	let file: string;

	if (kind === "source") file = join(dir, "source.png");
	else if (kind === "encode") file = join(dir, "encode.png");
	else if (kind === "clip") file = join(dir, "encoded.mkv");
	else if (kind === "source-clip") file = join(dir, "source_clip.mkv");
	else if (kind === "prepare") file = join(dir, "prepare.png");
	else if (kind.startsWith("vs:")) {
		const m = kind.match(/^vs:(\d+)$/);
		if (!m) return null;
		file = join(dir, `vs_${parseInt(m[1]!, 10)}.png`);
	} else if (kind.startsWith("pf:")) {
		if (!/^pf:(downscale|deband|denoise|crop)$/.test(kind)) return null;
		file = join(dir, "prepare.png");
	} else return null;

	return existsSync(file) ? file : null;
}

export function deletePreviewDir(config: AppConfig, jobId: string): void {
	try {
		rmSync(previewDirFor(config, jobId), { recursive: true, force: true });
	} catch {}
}
