import { existsSync, readFileSync, rmSync } from "fs";
import { run } from "../core/process";
import { createSemaphore } from "../core/concurrency";

export type MetricName = "ssimulacra2" | "xpsnr" | "vmaf";
export const METRIC_NAMES: readonly MetricName[] = ["ssimulacra2", "xpsnr", "vmaf"];

export type FrameScores = Partial<Record<MetricName, number>>;

export interface MetricSummary {
	mean: number;
	/** 5th percentile, the score the worst 5% of frames fall below. */
	p5: number;
	min: number;
	/** Reference frame of the worst score. */
	minFrame: number;
	count: number;
}

/** XPSNR of identical pictures is infinite, so it is shown as this. */
export const XPSNR_CAP = 100;

/** VapourSynth matrix codes for the overrides and for untagged video. */
export type VsMatrix = 1 | 5 | 6 | 9;

export interface MetricVideo {
	path: string;
	/** First frame of the measured stretch. */
	start: number;
	matrix?: VsMatrix;
	range?: "limited" | "full";
	/** ffms2 index file, kept with the comparison so measuring again is quicker. */
	index: string;
}

/**
 * SSIMULACRA2 and XPSNR with vszip. In "video" mode it reads both videos with
 * ffms2 from their start frames and scores every step-th frame pair, the
 * distorted one scaled to the reference first. In "images" mode it scores
 * pairs of PNGs. One JSON line is printed per pair, and "total" first.
 */
const METRICS_PY = String.raw`
import json, math, sys
import vapoursynth as vs
core = vs.core
a = json.loads(sys.argv[1])
want = set(a["metrics"])

if hasattr(vs, "Range"):
    RANGE_KEY, RANGES = "_Range", {"full": int(vs.Range.RANGE_FULL), "limited": int(vs.Range.RANGE_LIMITED)}
else:
    RANGE_KEY, RANGES = "_ColorRange", {"full": 0, "limited": 1}

def tagged(clip, s):
    props = {}
    if s.get("matrix"):
        props["_Matrix"] = s["matrix"]
    elif clip.format.color_family == vs.YUV and clip.get_frame(0).props.get("_Matrix", 2) == 2:
        props["_Matrix"] = 1 if clip.height >= 720 else 6
    if s.get("range"):
        props[RANGE_KEY] = RANGES[s["range"]]
    return core.std.SetFrameProps(clip, **props) if props else clip

def xpsnr(props):
    y, u, v = (props.get(k, float("inf")) for k in ("XPSNR_Y", "XPSNR_U", "XPSNR_V"))
    mse = (4 * 10 ** (-y / 10) + 10 ** (-u / 10) + 10 ** (-v / 10)) / 6
    return a["cap"] if mse <= 0 else min(a["cap"], -10 * math.log10(mse))

def same_format(r, d):
    fmt = core.query_video_format(vs.YUV, vs.INTEGER, 10, r.format.subsampling_w, r.format.subsampling_h)
    r = core.resize.Spline36(r, format=fmt.id)
    d = core.resize.Spline36(d, width=r.width, height=r.height, format=fmt.id)
    return r, d

if a["mode"] == "video":
    ref = tagged(core.ffms2.Source(a["ref"]["path"], cachefile=a["ref"]["index"]), a["ref"])
    dis = tagged(core.ffms2.Source(a["dist"]["path"], cachefile=a["dist"]["index"]), a["dist"])
    rs, ds, step = a["ref"]["start"], a["dist"]["start"], a["step"]
    count = max(0, min(ref.num_frames - rs, dis.num_frames - ds) + step - 1) // step
    if a.get("count") is not None:
        count = min(count, a["count"])
    print(json.dumps({"total": count}), flush=True)
    if count == 0:
        sys.exit(0)
    r = ref[rs : rs + (count - 1) * step + 1 : step]
    d = dis[ds : ds + (count - 1) * step + 1 : step]
    r, d = same_format(r, d)
else:
    pairs = a["pairs"]
    print(json.dumps({"total": len(pairs)}), flush=True)
    if not pairs:
        sys.exit(0)
    read = lambda paths: core.std.Splice([core.vszip.ImageRead([p]) for p in paths])
    r = core.resize.Spline36(read([p[0] for p in pairs]), format=vs.YUV444P10, matrix_s="709")
    d = core.resize.Spline36(read([p[1] for p in pairs]), width=r.width, height=r.height, format=vs.YUV444P10, matrix_s="709")
    r, d = core.std.SetFrameProps(r, _Matrix=1), core.std.SetFrameProps(d, _Matrix=1)

clips = []
if "ssimulacra2" in want:
    clips.append(("ssimulacra2", core.vszip.SSIMULACRA2(r, d)))
if "xpsnr" in want:
    clips.append(("xpsnr", core.vszip.XPSNR(r, d, temporal=1 if a["mode"] == "video" and a["step"] == 1 else 0, verbose=0)))
for n, frames in enumerate(zip(*[c.frames() for _, c in clips])):
    out = {"n": n}
    for (name, _), f in zip(clips, frames):
        out[name] = round(f.props["SSIMULACRA2"], 3) if name == "ssimulacra2" else round(xpsnr(f.props), 3)
    print(json.dumps(out), flush=True)
`;

interface ScriptLine extends FrameScores {
	n?: number;
	total?: number;
}

async function runMetricsScript(args: object, signal: AbortSignal, onLine: (line: ScriptLine) => void): Promise<void> {
	const res = await run(["python3", "-c", METRICS_PY, JSON.stringify(args)], {
		signal,
		onStdoutLine: (raw) => {
			if (!raw.startsWith("{")) return;
			try {
				onLine(JSON.parse(raw) as ScriptLine);
			} catch {}
		},
	});
	if (signal.aborted) throw new Error("Measuring cancelled");
	if (res.code !== 0) throw new Error(`Metrics failed: ${res.stderr.trim().split("\n").slice(-3).join(" ").slice(-400)}`);
}

export interface VideoPairOptions {
	ref: MetricVideo;
	dist: MetricVideo;
	step: number;
	/** Most samples, when the stretch is known to be shorter than the files. */
	count?: number;
	width: number;
	height: number;
	metrics: MetricName[];
	/** Scratch file for the VMAF log. */
	vmafLog: string;
	signal: AbortSignal;
	onProgress: (done: number, total: number) => void;
}

/** Scores of every step-th frame pair, by sample number. The VapourSynth metrics run first, then VMAF. */
export async function measureVideoPair(o: VideoPairOptions): Promise<FrameScores[]> {
	const vsMetrics = o.metrics.filter((m) => m !== "vmaf");
	const withVmaf = o.metrics.includes("vmaf");
	const passes = vsMetrics.length && withVmaf ? 2 : 1;
	const scores: FrameScores[] = [];
	let total = o.count ?? 0;
	if (vsMetrics.length) {
		await runMetricsScript(
			{ mode: "video", ref: o.ref, dist: o.dist, step: o.step, count: o.count ?? null, metrics: vsMetrics, cap: XPSNR_CAP },
			o.signal,
			(line) => {
				if (line.total !== undefined) total = line.total;
				if (line.n === undefined) return;
				const { n, ...values } = line;
				scores[n] = { ...scores[n], ...values };
				o.onProgress(n + 1, total * passes);
			},
		);
	}
	if (withVmaf && (total > 0 || !vsMetrics.length)) {
		const vmaf = await vmafVideo(o, total, (done) => o.onProgress((passes - 1) * total + done, total * passes));
		vmaf.forEach((value, n) => {
			if (vsMetrics.length && n >= total) return;
			scores[n] = { ...scores[n], vmaf: value };
		});
		total ||= vmaf.length;
		o.onProgress(total * passes, total * passes);
	}
	return Array.from({ length: Math.max(scores.length, total) }, (_, n) => scores[n] ?? {});
}

const ZSCALE_RANGE = { limited: "tv", full: "pc" } as const;

function vmafInput(index: number, v: MetricVideo, step: number, count: number | undefined, size?: { width: number; height: number }): string {
	const end = count ? `:end_frame=${v.start + (count - 1) * step + 1}` : "";
	const range = v.range ? `:in_range=${ZSCALE_RANGE[v.range]}` : "";
	const scale = size ? `scale=${size.width}:${size.height}:flags=spline${range}:out_range=tv,` : `scale=flags=spline${range}:out_range=tv,`;
	return `[${index}:v:0]trim=start_frame=${v.start}${end},setpts=PTS-STARTPTS,${scale}format=yuv420p10le`;
}

/**
 * VMAF of every step-th frame pair. libvmaf scores the subsampled frames
 * itself, so its motion feature still sees neighbouring frames.
 */
async function vmafVideo(o: VideoPairOptions, total: number, onProgress: (done: number) => void): Promise<number[]> {
	const count = total || undefined;
	const graph = [
		`${vmafInput(0, o.ref, o.step, count)}[ref]`,
		`${vmafInput(1, o.dist, o.step, count, { width: o.width, height: o.height })}[dis]`,
		`[dis][ref]libvmaf=log_fmt=json:log_path=${escapeFilterPath(o.vmafLog)}:n_subsample=${o.step}:n_threads=${vmafThreads()}:shortest=1`,
	].join(";");
	rmSync(o.vmafLog, { force: true });
	const res = await run(
		[
			"ffmpeg",
			"-hide_banner",
			"-nostats",
			"-loglevel",
			"error",
			"-i",
			o.ref.path,
			"-i",
			o.dist.path,
			"-filter_complex",
			graph,
			"-progress",
			"pipe:1",
			"-f",
			"null",
			"-",
		],
		{
			signal: o.signal,
			onStdoutLine: (line) => {
				const m = /^frame=(\d+)/.exec(line);
				if (m) onProgress(Math.floor(Number(m[1]) / o.step));
			},
		},
	);
	if (o.signal.aborted) throw new Error("Measuring cancelled");
	if (res.code !== 0 || !existsSync(o.vmafLog)) throw new Error(`VMAF failed: ${res.stderr.trim().slice(-400)}`);
	try {
		return parseVmafLog(readFileSync(o.vmafLog, "utf-8"), o.step);
	} finally {
		rmSync(o.vmafLog, { force: true });
	}
}

/**
 * Per sample VMAF from a libvmaf JSON log. With subsampling the log numbers
 * frames either by their place in the input or one after another, so both
 * are read.
 */
export function parseVmafLog(text: string, step: number): number[] {
	const frames = ((JSON.parse(text) as { frames?: Array<{ frameNum: number; metrics?: { vmaf?: number } }> }).frames ?? []).filter(
		(f) => typeof f.metrics?.vmaf === "number",
	);
	const byInput = step > 1 && frames.length > 1 && frames.every((f) => f.frameNum % step === 0) && frames[1]!.frameNum === step;
	const out: number[] = [];
	frames.forEach((f, i) => (out[byInput ? f.frameNum / step : i] = Math.round(f.metrics!.vmaf! * 1000) / 1000));
	return out;
}

function escapeFilterPath(path: string): string {
	return path.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function vmafThreads(): number {
	return Math.max(1, Math.min(16, navigator.hardwareConcurrency || 4));
}

/** Scores of image pairs of the same size, reference first. */
export async function measureImagePairs(
	pairs: Array<[string, string]>,
	metrics: MetricName[],
	signal: AbortSignal,
	onProgress?: (done: number) => void,
): Promise<FrameScores[]> {
	const scores: FrameScores[] = pairs.map(() => ({}));
	const vsMetrics = metrics.filter((m) => m !== "vmaf");
	if (vsMetrics.length && pairs.length)
		await runMetricsScript({ mode: "images", pairs, metrics: vsMetrics, cap: XPSNR_CAP }, signal, (line) => {
			if (line.n === undefined) return;
			const { n, ...values } = line;
			Object.assign(scores[n]!, values);
			onProgress?.(n + 1);
		});
	if (metrics.includes("vmaf")) {
		const sem = createSemaphore(3);
		await Promise.all(
			pairs.map(([ref, dist], i) =>
				sem.run(async () => {
					const value = await vmafImages(ref, dist, signal);
					if (value !== null) scores[i]!.vmaf = value;
				}),
			),
		);
	}
	return scores;
}

async function vmafImages(ref: string, dist: string, signal: AbortSignal): Promise<number | null> {
	const toYuv = "scale=out_color_matrix=bt709:out_range=tv,format=yuv444p10le";
	const log = `${dist}.vmaf.json`;
	try {
		const res = await run(
			[
				"ffmpeg",
				"-hide_banner",
				"-loglevel",
				"error",
				"-i",
				ref,
				"-i",
				dist,
				"-filter_complex",
				`[0:v]${toYuv}[ref];[1:v]${toYuv}[dis];[dis][ref]libvmaf=log_fmt=json:log_path=${escapeFilterPath(log)}`,
				"-f",
				"null",
				"-",
			],
			{ signal },
		);
		if (signal.aborted) throw new Error("Measuring cancelled");
		if (res.code !== 0 || !existsSync(log)) return null;
		return parseVmafLog(readFileSync(log, "utf-8"), 1)[0] ?? null;
	} catch (error) {
		if (signal.aborted) throw error;
		return null;
	} finally {
		rmSync(log, { force: true });
	}
}

/** Mean, 5th percentile and worst score of one metric over regularly spaced samples. */
export function summarize(values: Array<number | null | undefined>, firstFrame: number, step: number): MetricSummary | undefined {
	const scored = values.flatMap((value, n) => (typeof value === "number" ? [{ frame: firstFrame + n * step, value }] : []));
	if (!scored.length) return undefined;
	const sorted = scored.map((v) => v.value).sort((a, b) => a - b);
	const worst = scored.reduce((low, v) => (v.value < low.value ? v : low));
	const round = (x: number) => Math.round(x * 100) / 100;
	return {
		mean: round(sorted.reduce((sum, v) => sum + v, 0) / sorted.length),
		p5: round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.05))]!),
		min: round(worst.value),
		minFrame: worst.frame,
		count: sorted.length,
	};
}
