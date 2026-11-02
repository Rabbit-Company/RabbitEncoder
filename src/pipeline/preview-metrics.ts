import { existsSync, rmSync } from "fs";
import { join } from "path";
import type { PreviewCrop, PreviewMetricName, PreviewMetricSummary } from "../core/types";
import { run } from "../core/process";
import { FFV1_ENCODE_ARGS } from "../video/auto-denoise";
import { METRIC_NAMES, measureVideoPair, NO_GRAIN_DECODE, summarize, type MetricName, type VsMatrix } from "../compare/metrics";

export interface PreviewMeasureOptions {
	metrics: PreviewMetricName[];
	/** Decode the encode with its film grain, as a player shows it. */
	withGrain: boolean;
}

export interface PreviewSampleScores {
	scores: Partial<Record<PreviewMetricName, PreviewMetricSummary>>;
	scoreValues: Partial<Record<PreviewMetricName, Array<number | null>>>;
}

export interface PreviewColor {
	range: "tv" | "pc" | null;
	space: string | null;
}

export function isPreviewMetric(value: unknown): value is PreviewMetricName {
	return (METRIC_NAMES as readonly unknown[]).includes(value);
}

const VS_MATRIX: Record<string, VsMatrix> = { bt709: 1, bt470bg: 5, smpte170m: 6, bt2020nc: 9 };

function vsColour(color: PreviewColor): { matrix?: VsMatrix; range?: "limited" | "full" } {
	const matrix = color.space ? VS_MATRIX[color.space] : undefined;
	return { ...(matrix ? { matrix } : {}), ...(color.range ? { range: color.range === "pc" ? "full" : "limited" } : {}) };
}

async function probeVideo(path: string, signal: AbortSignal): Promise<{ codec: string; width: number; height: number }> {
	const res = await run(["ffprobe", "-v", "error", "-select_streams", "V:0", "-show_entries", "stream=codec_name,width,height", "-of", "json", path], {
		signal,
	});
	const s = res.code === 0 ? (JSON.parse(res.stdout)?.streams?.[0] ?? {}) : {};
	return { codec: String(s.codec_name ?? ""), width: Number(s.width) || 0, height: Number(s.height) || 0 };
}

/**
 * Every frame is kept and given a timestamp from its place in the clip, so
 * both videos are paired by frame number. ffms2 and VMAF otherwise follow
 * timestamps, and frames that share one get dropped or paired wrongly. The
 * rate is fixed because a clip with broken timestamps reports a wrong one.
 */
async function writeFfv1(input: string[], filter: string | null, outPath: string, signal: AbortSignal): Promise<void> {
	const vf = [filter, "settb=1/24,setpts=N"].filter(Boolean).join(",");
	const res = await run(
		[
			"ffmpeg",
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			...input,
			"-map",
			"0:V:0",
			"-vf",
			vf,
			"-fps_mode",
			"passthrough",
			...FFV1_ENCODE_ARGS,
			"-an",
			"-sn",
			"-dn",
			outPath,
		],
		{ signal },
	);
	if (signal.aborted) throw new Error("Measuring cancelled");
	if (res.code !== 0) throw new Error(`Decoding for metrics failed: ${res.stderr.trim().slice(-400)}`);
}

/**
 * Scores a preview sample's encode against its source clip over every frame.
 * The source gets the crop the encode got. An AV1 encode is decoded with dav1d
 * with or without its film grain, since the metrics count grain as error.
 */
export async function measurePreviewSample(
	dir: string,
	crop: PreviewCrop | undefined,
	color: PreviewColor,
	opts: PreviewMeasureOptions,
	signal: AbortSignal,
	onProgress: (fraction: number) => void,
): Promise<PreviewSampleScores> {
	const source = join(dir, "source_clip.mkv");
	const encoded = join(dir, "encoded.mkv");
	if (!existsSync(source) || !existsSync(encoded)) throw new Error("The sample's clips are missing");

	const refPath = join(dir, "metric_ref.mkv");
	const distPath = join(dir, "metric_dist.mkv");
	const scratch = [refPath, distPath, `${refPath}.ffindex`, `${distPath}.ffindex`, join(dir, "metric_vmaf.json")];
	try {
		await writeFfv1(["-i", source], crop ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}` : null, refPath, signal);
		const encodedInfo = await probeVideo(encoded, signal);
		const decoder = encodedInfo.codec === "av1" ? (opts.withGrain ? ["-c:v", "libdav1d"] : NO_GRAIN_DECODE) : [];
		await writeFfv1([...decoder, "-i", encoded], null, distPath, signal);
		onProgress(0.1);

		const refInfo = await probeVideo(refPath, signal);
		const scores = await measureVideoPair({
			ref: { path: refPath, start: 0, index: `${refPath}.ffindex`, ...vsColour(color) },
			dist: { path: distPath, start: 0, index: `${distPath}.ffindex`, ...vsColour(color) },
			step: 1,
			width: refInfo.width,
			height: refInfo.height,
			metrics: opts.metrics as MetricName[],
			vmafLog: join(dir, "metric_vmaf.json"),
			signal,
			onProgress: (done, total) => onProgress(0.1 + 0.9 * (total ? done / total : 0)),
		});

		const out: PreviewSampleScores = { scores: {}, scoreValues: {} };
		for (const metric of opts.metrics) {
			const values = scores.map((s) => s[metric] ?? null);
			const summary = summarize(values, 0, 1);
			if (!summary) continue;
			out.scores[metric] = summary;
			out.scoreValues[metric] = values;
		}
		return out;
	} finally {
		for (const path of scratch) rmSync(path, { force: true });
	}
}
