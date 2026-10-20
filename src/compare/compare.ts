import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { randomUUID } from "crypto";
import { Logger } from "../core/logger";
import { run } from "../core/process";
import { createSemaphore } from "../core/concurrency";

/** Envelope rate for the fine alignment pass: one value per 10 ms. */
const FINE_RATE = 100;
/** Coarse pass rate: one value per 100 ms, so a wide lag search stays fast. */
const COARSE_RATE = 10;
/** Audio decoded from the start of each file for alignment. */
const ALIGN_WINDOW_SEC = 600;
/** Largest start difference searched between two releases. */
const MAX_LAG_SEC = 180;
/** Below this correlation peak the offset is a guess, so it is not applied. */
const MIN_ALIGN_CONFIDENCE = 0.35;
/** Sessions kept on disk, the oldest go first. */
const MAX_SESSIONS = 10;
/** Frames captured at the same time. */
const CAPTURE_CONCURRENCY = 3;
/** Picture check: frames compared per point, and how far either way a shift is searched. */
const CHECK_FRAMES = 48;
const CHECK_RADIUS = 4;
/** A picture shift is applied only when it fits clearly better than the audio offset alone. */
const CHECK_MIN_GAIN = 0.85;
const THUMB_W = 64;
const THUMB_H = 36;
const SAMPLE_RATE = 8000;

export interface CompareSourceInput {
	path: string;
	label: string;
	/** Manual offset against the first source in ms. Skips automatic alignment for this source. */
	offsetMs?: number;
	/** Overrides a missing or wrong range tag. */
	range?: "limited" | "full";
	/** Overrides a missing or wrong matrix tag. */
	matrix?: "709" | "601" | "2020";
}

export type CompareFrameMode = "even" | "random" | "manual";

export interface CompareRequest {
	sources: CompareSourceInput[];
	mode: CompareFrameMode;
	count: number;
	/** Seconds in the first source, for manual mode. */
	timestamps?: number[];
	align: boolean;
}

export interface CompareSourceState {
	path: string;
	label: string;
	/** How much later the same moment appears in this source than in the first one. */
	offsetMs: number;
	/** "first" for the first source, "auto" when audio alignment found the offset, "manual", or "none". */
	offsetFrom: "first" | "auto" | "manual" | "none";
	/** Correlation peak of the audio alignment, 0 to 1. */
	confidence?: number;
	width?: number;
	height?: number;
	fps?: number;
	hdr?: boolean;
	/** Size the images are saved at, when it differs from the video's own. */
	outputWidth?: number;
	outputHeight?: number;
	/** Frames the picture check moved this source after the audio offset. */
	pictureShiftFrames?: number;
	/** Colour tags set by hand, such as "full range, BT.601". */
	colourOverride?: string;
	warning?: string;
}

export interface CompareFrameState {
	/** Seconds in the first source. */
	timeSec: number;
	/** Per source: whether the PNG exists. A source that ends earlier has no image. */
	images: boolean[];
}

export interface CompareSession {
	id: string;
	createdAt: number;
	status: "aligning" | "capturing" | "done" | "error" | "cancelled";
	progress: number;
	detail?: string;
	error?: string;
	sources: CompareSourceState[];
	frames: CompareFrameState[];
}

interface VideoInfo {
	formatStart: number;
	/** -ss position of the first video frame. */
	videoStart: number;
	duration: number;
	width: number;
	height: number;
	/** Sample aspect ratio, width over height of one pixel. */
	sar: number;
	fps: number;
	range: "tv" | "pc" | null;
	space: string | null;
	transfer: string | null;
	/** Where 4:2:0 chroma samples sit, as ffprobe names it. */
	chromaLocation: string | null;
	audio: Array<{ index: number; start: number; language?: string }>;
}

export function compareRoot(config: { tempDir: string }): string {
	return join(config.tempDir, "compare");
}

function sessionDir(root: string, id: string): string {
	return join(root, id);
}

export function imagePath(root: string, id: string, frame: number, source: number): string {
	return join(sessionDir(root, id), `f${frame}_s${source}.png`);
}

function saveSession(root: string, session: CompareSession): void {
	writeFileSync(join(sessionDir(root, session.id), "session.json"), JSON.stringify(session));
}

export function loadSession(root: string, id: string): CompareSession | null {
	if (!/^[0-9a-f-]{36}$/.test(id)) return null;
	const file = join(sessionDir(root, id), "session.json");
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(readFileSync(file, "utf-8")) as CompareSession;
	} catch {
		return null;
	}
}

export function listSessions(root: string): CompareSession[] {
	if (!existsSync(root)) return [];
	return readdirSync(root)
		.map((id) => loadSession(root, id))
		.filter((s): s is CompareSession => s !== null)
		.sort((a, b) => b.createdAt - a.createdAt);
}

export function deleteSession(root: string, id: string): boolean {
	if (!loadSession(root, id)) return false;
	rmSync(sessionDir(root, id), { recursive: true, force: true });
	return true;
}

/** Delete every saved comparison that is not running. Returns how many went. */
export function clearSessions(root: string): number {
	let removed = 0;
	for (const s of listSessions(root)) {
		if (running.has(s.id)) continue;
		rmSync(sessionDir(root, s.id), { recursive: true, force: true });
		removed++;
	}
	return removed;
}

function pruneSessions(root: string): void {
	for (const old of listSessions(root).slice(MAX_SESSIONS)) rmSync(sessionDir(root, old.id), { recursive: true, force: true });
}

function parseRate(rate: unknown): number {
	if (typeof rate !== "string") return 0;
	const [n, d] = rate.split("/").map(Number);
	return n && d ? n / d : Number(rate) || 0;
}

/** "4:3" gives 1.333. Missing or "0:1" means square pixels. */
function parseRatio(v: unknown): number {
	if (typeof v !== "string") return 1;
	const [n, d] = v.split(":").map(Number);
	return n && d ? n / d : 1;
}

function cleanTag(v: unknown): string | null {
	if (typeof v !== "string") return null;
	const t = v.trim();
	return !t || t === "unknown" || t === "N/A" ? null : t;
}

async function probeVideo(path: string, signal: AbortSignal): Promise<VideoInfo> {
	const res = await run(
		[
			"ffprobe",
			"-v",
			"error",
			"-show_entries",
			"format=start_time,duration:stream=index,codec_type,start_time,width,height,sample_aspect_ratio,avg_frame_rate,r_frame_rate,color_range,color_space,color_transfer,chroma_location:stream_disposition=attached_pic:stream_tags=language",
			"-of",
			"json",
			path,
		],
		{ signal },
	);
	if (res.code !== 0) throw new Error(`Could not read ${basename(path)}: ${res.stderr.slice(-300)}`);
	const data = JSON.parse(res.stdout) as { format?: Record<string, string>; streams?: Array<Record<string, any>> };
	const streams = data.streams ?? [];
	const video = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
	if (!video) throw new Error(`${basename(path)} has no video stream`);
	return {
		formatStart: Number(data.format?.start_time) || 0,
		videoStart: (Number(video.start_time) || 0) - (Number(data.format?.start_time) || 0),
		duration: Number(data.format?.duration) || 0,
		width: Number(video.width) || 0,
		height: Number(video.height) || 0,
		sar: parseRatio(video.sample_aspect_ratio),
		fps: parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate),
		range: video.color_range === "pc" ? "pc" : video.color_range === "tv" ? "tv" : null,
		space: cleanTag(video.color_space),
		transfer: cleanTag(video.color_transfer),
		chromaLocation: cleanTag(video.chroma_location),
		audio: streams
			.filter((s) => s.codec_type === "audio")
			.map((s) => ({ index: Number(s.index), start: Number(s.start_time) || 0, language: cleanTag(s.tags?.language) ?? undefined })),
	};
}

function isHdr(info: VideoInfo): boolean {
	return info.transfer === "smpte2084" || info.transfer === "arib-std-b67";
}

/** Log RMS per 10 ms of the first minutes of one audio stream, mono at 8 kHz. */
async function audioEnvelope(path: string, streamIndex: number, signal: AbortSignal): Promise<Float32Array> {
	const proc = Bun.spawn(
		[
			"ffmpeg",
			"-hide_banner",
			"-loglevel",
			"error",
			"-i",
			path,
			"-map",
			`0:${streamIndex}`,
			"-t",
			String(ALIGN_WINDOW_SEC),
			"-ac",
			"1",
			"-ar",
			String(SAMPLE_RATE),
			"-f",
			"s16le",
			"-",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const onAbort = () => proc.kill();
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		const buf = await new Response(proc.stdout).arrayBuffer();
		await proc.exited;
		if (signal.aborted) throw new Error("Comparison cancelled");
		const pcm = new Int16Array(buf, 0, Math.floor(buf.byteLength / 2));
		const per = SAMPLE_RATE / FINE_RATE;
		const env = new Float32Array(Math.floor(pcm.length / per));
		for (let i = 0; i < env.length; i++) {
			let sum = 0;
			for (let k = i * per; k < (i + 1) * per; k++) sum += pcm[k]! * pcm[k]!;
			env[i] = Math.log10(1e-3 + Math.sqrt(sum / per) / 32768);
		}
		return env;
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

function downsample(env: Float32Array, factor: number): Float32Array {
	const out = new Float32Array(Math.floor(env.length / factor));
	for (let i = 0; i < out.length; i++) {
		let sum = 0;
		for (let k = 0; k < factor; k++) sum += env[i * factor + k]!;
		out[i] = sum / factor;
	}
	return out;
}

/** Pearson correlation of a[i] with b[i + lag] over their overlap. */
function correlationAt(a: Float32Array, b: Float32Array, lag: number): number {
	const start = Math.max(0, -lag);
	const end = Math.min(a.length, b.length - lag);
	const n = end - start;
	if (n < 100) return -1;
	let sa = 0,
		sb = 0,
		saa = 0,
		sbb = 0,
		sab = 0;
	for (let i = start; i < end; i++) {
		const x = a[i]!;
		const y = b[i + lag]!;
		sa += x;
		sb += y;
		saa += x * x;
		sbb += y * y;
		sab += x * y;
	}
	const cov = sab - (sa * sb) / n;
	const va = saa - (sa * sa) / n;
	const vb = sbb - (sb * sb) / n;
	return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : -1;
}

/**
 * Lag in fine steps (10 ms) where b best matches a, with the correlation at
 * that lag. A coarse search over the whole range finds the area, a fine one
 * around it sets the exact value.
 */
export function bestLag(a: Float32Array, b: Float32Array, maxLagSec = MAX_LAG_SEC): { lag: number; score: number } {
	const factor = FINE_RATE / COARSE_RATE;
	const ca = downsample(a, factor);
	const cb = downsample(b, factor);
	const maxCoarse = Math.round(maxLagSec * COARSE_RATE);
	let coarse = 0;
	let coarseScore = -Infinity;
	for (let lag = -maxCoarse; lag <= maxCoarse; lag++) {
		const score = correlationAt(ca, cb, lag);
		if (score > coarseScore) {
			coarseScore = score;
			coarse = lag;
		}
	}
	let lag = coarse * factor;
	let score = -Infinity;
	for (let l = (coarse - 1) * factor; l <= (coarse + 1) * factor; l++) {
		const s = correlationAt(a, b, l);
		if (s > score) {
			score = s;
			lag = l;
		}
	}
	return { lag, score };
}

/** Same language as the first source's audio when the file has it, else its first audio stream. */
function pickAudio(info: VideoInfo, language?: string): VideoInfo["audio"][number] | undefined {
	return (language && info.audio.find((a) => a.language === language)) || info.audio[0];
}

/**
 * Moments in the first source: spread evenly over the stretch every source
 * covers (leaving out the first and last 5%), at random in it, or as typed.
 */
export function planFrameTimes(mode: CompareFrameMode, count: number, startSec: number, endSec: number, timestamps: number[] = []): number[] {
	if (mode === "manual") return [...new Set(timestamps.filter((t) => Number.isFinite(t) && t >= 0))].sort((a, b) => a - b);
	const span = endSec - startSec;
	if (span <= 0 || count <= 0) return [];
	const lo = startSec + span * 0.05;
	const hi = startSec + span * 0.95;
	if (mode === "random") {
		return Array.from({ length: count }, () => lo + Math.random() * (hi - lo))
			.map((t) => Math.round(t * 1000) / 1000)
			.sort((a, b) => a - b);
	}
	if (count === 1) return [Math.round(((lo + hi) / 2) * 1000) / 1000];
	return Array.from({ length: count }, (_, i) => Math.round((lo + ((hi - lo) * i) / (count - 1)) * 1000) / 1000);
}

/** Index of the frame nearest to -ss position `pos`, and the time it is shown. */
export function nearestFrame(pos: number, videoStart: number, fps: number): { index: number; time: number } {
	if (fps <= 0) return { index: 0, time: pos };
	const index = Math.max(0, Math.round((pos - videoStart) * fps));
	return { index, time: videoStart + index / fps };
}

/**
 * -ss position that makes ffmpeg return exactly frame `index`: half a frame
 * before it, since an input seek returns the first frame at or after it.
 */
export function seekForFrame(index: number, videoStart: number, fps: number): number {
	return fps > 0 ? Math.max(0, videoStart + (index - 0.5) / fps) : videoStart;
}

export interface OutputSize {
	width: number;
	height: number;
}

/**
 * Size every source is saved at: the largest shown size among them. A source
 * of the same shape is scaled to it. One of another shape keeps its own size,
 * since stretching it would distort the picture.
 */
export function planOutputSizes(sources: Array<{ width: number; height: number; sar: number }>): { sizes: OutputSize[]; mismatched: boolean[] } {
	const shown = sources.map((s) => ({ width: Math.round(s.width * (s.sar || 1)), height: s.height }));
	const target = shown.reduce((best, s) => (s.width * s.height > best.width * best.height ? s : best), shown[0]!);
	const targetAspect = target.width / target.height;
	const mismatched = shown.map((s) => Math.abs(s.width / s.height - targetAspect) / targetAspect > 0.01);
	const sizes = shown.map((s, i) => (mismatched[i] ? s : { width: target.width, height: target.height }));
	return { sizes, mismatched };
}

/** Mean absolute difference of two equally sized greyscale frames, ignoring a brightness offset between them. */
function frameDistance(a: Uint8Array, b: Uint8Array): number {
	let ma = 0,
		mb = 0;
	for (let i = 0; i < a.length; i++) {
		ma += a[i]!;
		mb += b[i]!;
	}
	const shift = (ma - mb) / a.length;
	let sum = 0;
	for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]! - shift);
	return sum / a.length;
}

/**
 * Error for each shift in [-radius, radius]: reference frame i against
 * candidate frame i + radius + shift. The candidate run starts `radius`
 * frames before the matching reference frame and is 2 * radius frames longer.
 */
export function shiftErrors(ref: Uint8Array[], cand: Uint8Array[], radius: number): number[] {
	const errors: number[] = [];
	for (let shift = -radius; shift <= radius; shift++) {
		let sum = 0;
		let n = 0;
		for (let i = 0; i < ref.length; i++) {
			const c = cand[i + radius + shift];
			if (!c) continue;
			sum += frameDistance(ref[i]!, c);
			n++;
		}
		errors.push(n ? sum / n : Infinity);
	}
	return errors;
}

/** Shift with the lowest summed error, or 0 when it is not clearly better than no shift. */
export function pickShift(errors: number[], radius: number, minGain = CHECK_MIN_GAIN): number {
	let best = 0;
	for (let k = 0; k < errors.length; k++) if (errors[k]! < errors[best]!) best = k;
	const zero = errors[radius]!;
	return errors[best]! < zero * minGain ? best - radius : 0;
}

/** Small greyscale frames from frame `start` on, for the picture check. */
async function thumbFrames(path: string, info: VideoInfo, start: number, count: number, signal: AbortSignal): Promise<Uint8Array[]> {
	const proc = Bun.spawn(
		[
			"ffmpeg",
			"-hide_banner",
			"-loglevel",
			"error",
			"-ss",
			seekForFrame(start, info.videoStart, info.fps).toFixed(3),
			"-i",
			path,
			"-map",
			"0:V:0",
			"-frames:v",
			String(count),
			"-vf",
			`scale=${THUMB_W}:${THUMB_H}:flags=area,format=gray`,
			"-f",
			"rawvideo",
			"-",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const onAbort = () => proc.kill();
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		const buf = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
		await proc.exited;
		if (signal.aborted) throw new Error("Comparison cancelled");
		const size = THUMB_W * THUMB_H;
		const frames: Uint8Array[] = [];
		for (let at = 0; at + size <= buf.length; at += size) frames.push(buf.subarray(at, at + size));
		return frames;
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

/**
 * Frames to move a source after its audio offset, found by matching the
 * picture at a few points. Releases sometimes carry audio a little shifted
 * against their video, which the audio offset cannot see.
 */
async function pictureShift(
	ref: { path: string; info: VideoInfo },
	cand: { path: string; info: VideoInfo; offsetSec: number },
	points: number[],
	signal: AbortSignal,
): Promise<number> {
	const total = new Array<number>(2 * CHECK_RADIUS + 1).fill(0);
	let used = 0;
	for (const t of points) {
		const r = nearestFrame(t, ref.info.videoStart, ref.info.fps);
		const c = nearestFrame(r.time + cand.offsetSec, cand.info.videoStart, cand.info.fps);
		if (c.index < CHECK_RADIUS) continue;
		const refFrames = await thumbFrames(ref.path, ref.info, r.index, CHECK_FRAMES, signal);
		const candFrames = await thumbFrames(cand.path, cand.info, c.index - CHECK_RADIUS, CHECK_FRAMES + 2 * CHECK_RADIUS, signal);
		if (refFrames.length < CHECK_FRAMES / 2 || candFrames.length < refFrames.length + 2 * CHECK_RADIUS) continue;
		shiftErrors(refFrames, candFrames, CHECK_RADIUS).forEach((e, k) => (total[k]! += e));
		used++;
	}
	return used ? pickShift(total, CHECK_RADIUS) : 0;
}

const ZIMG_MATRIX: Record<string, string> = {
	bt709: "709",
	smpte170m: "170m",
	bt470bg: "470bg",
	bt2020nc: "2020_ncl",
	bt2020c: "2020_cl",
};

const ZIMG_CHROMA: Record<string, string> = { left: "left", center: "center", topleft: "topleft", top: "top", bottomleft: "bottomleft", bottom: "bottom" };

/**
 * zimg conversion to 8-bit full range RGB, matching an mpv screenshot to
 * within dithering. ffmpeg's default scaler takes rounding shortcuts here and
 * comes out 1 to 3 levels dark with soft chroma. Lanczos chroma is what mpv
 * uses. Untagged chroma sits on the left, the 4:2:0 default for these codecs.
 */
export function sdrToRgbFilter(info: Pick<VideoInfo, "range" | "space" | "height" | "chromaLocation">, size?: OutputSize): string {
	const matrix = (info.space && ZIMG_MATRIX[info.space]) || (info.height >= 720 ? "709" : "170m");
	const range = info.range === "pc" ? "full" : "limited";
	const chroma = (info.chromaLocation && ZIMG_CHROMA[info.chromaLocation]) || "left";
	// Spline36 when upscaling: sharp with little ringing on line art. zimg has no EWA kernels.
	const resize = size ? `:w=${size.width}:h=${size.height}:filter=spline36` : ":filter=lanczos";
	return `zscale=matrixin=${matrix}:rangein=${range}:chromalin=${chroma}:matrix=${matrix}:range=full${resize}:dither=error_diffusion,format=gbrp,format=rgb24`;
}

const MATRIX_OVERRIDE: Record<NonNullable<CompareSourceInput["matrix"]>, string> = { "709": "bt709", "601": "smpte170m", "2020": "bt2020nc" };

/** The video's colour tags with any hand-set range and matrix applied. */
function withOverrides(info: VideoInfo, src: CompareSourceInput): VideoInfo {
	return {
		...info,
		range: src.range ? (src.range === "full" ? "pc" : "tv") : info.range,
		space: src.matrix ? MATRIX_OVERRIDE[src.matrix] : info.space,
	};
}

/** sRGB PNG of the first frame at or after `seekSec`, scaled to `size` when given, tone mapped when the source is HDR. */
async function captureAt(path: string, info: VideoInfo, seekSec: number, outPath: string, signal: AbortSignal, size?: OutputSize): Promise<boolean> {
	const toRgb = isHdr(info)
		? `${size ? `zscale=w=${size.width}:h=${size.height}:filter=spline36,` : ""}zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=pc:dither=error_diffusion,format=rgb24`
		: sdrToRgbFilter(info, size);
	const res = await run(
		[
			"ffmpeg",
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-ss",
			Math.max(0, seekSec).toFixed(3),
			"-i",
			path,
			"-map",
			"0:V:0",
			"-vf",
			`${toRgb},setparams=range=pc:colorspace=gbr:color_primaries=bt709:color_trc=iec61966-2-1`,
			"-frames:v",
			"1",
			"-an",
			"-sn",
			"-map_metadata",
			"-1",
			"-update",
			"1",
			outPath,
		],
		{ signal },
	);
	if (res.code !== 0) Logger.warn(`[compare] Frame capture failed for ${basename(path)} at ${seekSec.toFixed(3)}s: ${res.stderr.slice(-300)}`);
	return res.code === 0 && existsSync(outPath);
}

const running = new Map<string, AbortController>();

export function cancelSession(id: string): boolean {
	const ctrl = running.get(id);
	if (!ctrl) return false;
	ctrl.abort();
	return true;
}

/** Create a session and run it in the background. Returns its id right away. */
export function startCompare(root: string, req: CompareRequest): CompareSession {
	const session: CompareSession = {
		id: randomUUID(),
		createdAt: Date.now(),
		status: "aligning",
		progress: 0,
		sources: req.sources.map((s, i) => ({ path: s.path, label: s.label, offsetMs: i === 0 ? 0 : (s.offsetMs ?? 0), offsetFrom: i === 0 ? "first" : "none" })),
		frames: [],
	};
	mkdirSync(sessionDir(root, session.id), { recursive: true });
	saveSession(root, session);
	pruneSessions(root);

	const ctrl = new AbortController();
	running.set(session.id, ctrl);
	void runCompare(root, session, req, ctrl.signal).finally(() => running.delete(session.id));
	return session;
}

async function runCompare(root: string, session: CompareSession, req: CompareRequest, signal: AbortSignal): Promise<void> {
	const update = (patch: Partial<CompareSession>) => {
		Object.assign(session, patch);
		saveSession(root, session);
	};
	try {
		const infos: VideoInfo[] = [];
		for (const [i, src] of req.sources.entries()) {
			update({ detail: `Reading ${src.label}`, progress: Math.round((i / req.sources.length) * 10) });
			const info = withOverrides(await probeVideo(src.path, signal), src);
			infos.push(info);
			const overrides = [src.range && `${src.range} range`, src.matrix && `BT.${src.matrix}`].filter(Boolean);
			if (overrides.length) session.sources[i]!.colourOverride = overrides.join(", ");
			Object.assign(session.sources[i]!, { width: info.width, height: info.height, fps: Math.round(info.fps * 1000) / 1000, hdr: isHdr(info) });
		}

		// Offsets in -ss positions: the moment at position p in the first source is at p + offset in source i.
		const first = infos[0]!;
		const firstAudio = pickAudio(first);
		let firstEnv: Float32Array | null = null;
		for (let i = 1; i < req.sources.length; i++) {
			const src = req.sources[i]!;
			const state = session.sources[i]!;
			if (src.offsetMs !== undefined) {
				Object.assign(state, { offsetMs: Math.round(src.offsetMs), offsetFrom: "manual" });
				continue;
			}
			if (!req.align) continue;
			const audio = pickAudio(infos[i]!, firstAudio?.language);
			if (!firstAudio || !audio) {
				state.warning = "No audio to align with, so no offset is applied";
				continue;
			}
			update({ detail: `Aligning ${src.label}`, progress: 10 + Math.round((i / req.sources.length) * 30) });
			firstEnv ??= await audioEnvelope(req.sources[0]!.path, firstAudio.index, signal);
			const env = await audioEnvelope(src.path, audio.index, signal);
			const { lag, score } = bestLag(firstEnv, env);
			state.confidence = Math.round(score * 100) / 100;
			if (score < MIN_ALIGN_CONFIDENCE) {
				state.warning = `Audio did not match well enough (${Math.round(score * 100)}%), so no offset is applied. Set one by hand if the frames differ.`;
				continue;
			}
			// First source sample k lines up with this source's sample k + lag.
			const offsetSec = audio.start - infos[i]!.formatStart - (firstAudio.start - first.formatStart) + lag / FINE_RATE;
			Object.assign(state, { offsetMs: Math.round(offsetSec * 1000), offsetFrom: "auto" });
		}

		const addWarning = (state: CompareSourceState, text: string) => (state.warning = [state.warning, text].filter(Boolean).join(". "));
		for (const [i, state] of session.sources.entries()) {
			const fpsDiff = Math.abs((infos[i]!.fps || 0) - (first.fps || 0));
			if (i > 0 && fpsDiff > 0.01) addWarning(state, `Frame rate differs (${infos[i]!.fps.toFixed(3)} fps), so frames can be a little apart`);
		}

		// Picture check: audio can sit a little off against the video in some releases.
		{
			const offsets = session.sources.map((s) => s.offsetMs / 1000);
			const start = Math.max(0, ...offsets.map((o) => -o));
			const end = Math.min(...infos.map((info, i) => info.duration - offsets[i]!));
			const points = [0.3, 0.5, 0.7].map((f) => start + (end - start) * f);
			for (let i = 1; i < req.sources.length; i++) {
				const state = session.sources[i]!;
				if (state.offsetFrom !== "auto" || Math.abs(infos[i]!.fps - first.fps) > 0.01 || !(first.fps > 0) || end <= start) continue;
				update({ detail: `Checking the picture of ${state.label}`, progress: 40 });
				const shift = await pictureShift(
					{ path: req.sources[0]!.path, info: first },
					{ path: req.sources[i]!.path, info: infos[i]!, offsetSec: state.offsetMs / 1000 },
					points,
					signal,
				);
				state.pictureShiftFrames = shift;
				if (shift !== 0) {
					state.offsetMs = Math.round(state.offsetMs + (shift / infos[i]!.fps) * 1000);
					Logger.info(`[compare] Picture check moved ${state.label} by ${shift > 0 ? "+" : ""}${shift} frame(s)`);
				}
			}
		}

		const { sizes, mismatched } = planOutputSizes(infos);
		for (const [i, state] of session.sources.entries()) {
			const size = sizes[i]!;
			if (mismatched[i])
				addWarning(state, `Its shape differs from the largest video, so it is kept at ${size.width}×${size.height} instead of being stretched`);
			else if (size.width !== infos[i]!.width || size.height !== infos[i]!.height) Object.assign(state, { outputWidth: size.width, outputHeight: size.height });
		}

		// The stretch of the first source that every source covers.
		const offsets = session.sources.map((s) => s.offsetMs / 1000);
		const startSec = Math.max(0, ...offsets.map((o) => -o));
		const endSec = Math.min(...infos.map((info, i) => info.duration - offsets[i]!));
		// Each moment moves to the middle of a reference frame, so every other source
		// has half a frame of slack either way when its nearest frame is picked.
		const times = [
			...new Set(planFrameTimes(req.mode, req.count, startSec, endSec, req.timestamps).map((t) => nearestFrame(t, first.videoStart, first.fps).time)),
		].map((t) => Math.round(t * 1000000) / 1000000);
		if (times.length === 0) throw new Error("No frames to capture");
		update({ status: "capturing", frames: times.map((timeSec) => ({ timeSec, images: req.sources.map(() => false) })) });

		const total = times.length * req.sources.length;
		let done = 0;
		const sem = createSemaphore(CAPTURE_CONCURRENCY);
		await Promise.all(
			times.flatMap((timeSec, f) =>
				req.sources.map((src, s) =>
					sem.run(async () => {
						const info = infos[s]!;
						const state = session.sources[s]!;
						const pos = timeSec + state.offsetMs / 1000;
						if (pos >= 0 && pos < info.duration) {
							const { index } = nearestFrame(pos, info.videoStart, info.fps);
							const at = seekForFrame(index, info.videoStart, info.fps);
							const size = state.outputWidth ? sizes[s] : undefined;
							session.frames[f]!.images[s] = await captureAt(src.path, info, at, imagePath(root, session.id, f, s), signal, size);
						}
						done++;
						update({ progress: 45 + Math.round((done / total) * 55), detail: `Captured ${done} of ${total} images` });
					}),
				),
			),
		);
		update({ status: "done", progress: 100, detail: undefined });
	} catch (err) {
		if (signal.aborted) update({ status: "cancelled", detail: undefined });
		else {
			Logger.error(`[compare] ${(err as Error).message}`);
			update({ status: "error", error: (err as Error).message, detail: undefined });
		}
	}
}

function safeName(label: string): string {
	return label.replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^_+|_+$/g, "") || "source";
}

function formatTimestamp(sec: number): string {
	const h = Math.floor(sec / 3600);
	const m = Math.floor(sec / 60) % 60;
	const s = (sec % 60).toFixed(3).padStart(6, "0");
	return `${h}:${String(m).padStart(2, "0")}:${s}`;
}

/**
 * "01_1_Demihuman.png": frame, then source, so sorting by name keeps every
 * frame's sources together in the order they were added.
 */
export function comparisonFileName(frame: number, frameCount: number, source: number, label: string): string {
	const digits = Math.max(2, String(frameCount).length);
	return `${String(frame + 1).padStart(digits, "0")}_${source + 1}_${safeName(label)}.png`;
}

/** Every captured image with its download name, plus a text file listing the timestamps and offsets. */
export function comparisonArchiveEntries(root: string, session: CompareSession): Array<{ name: string; data: Uint8Array }> {
	const entries: Array<{ name: string; data: Uint8Array }> = [];
	session.frames.forEach((frame, f) =>
		frame.images.forEach((has, s) => {
			const file = imagePath(root, session.id, f, s);
			if (has && existsSync(file)) entries.push({ name: comparisonFileName(f, session.frames.length, s, session.sources[s]!.label), data: readFileSync(file) });
		}),
	);
	const lines = [
		"Sources:",
		...session.sources.map(
			(src, i) =>
				`${i + 1}. ${src.label}: ${basename(src.path)} (offset ${src.offsetFrom === "first" ? "reference" : `${src.offsetMs} ms, ${src.offsetFrom}`})`,
		),
		"",
		"Frames (time in the first source):",
		...session.frames.map((frame, f) => `${String(f + 1).padStart(Math.max(2, String(session.frames.length).length), "0")}. ${formatTimestamp(frame.timeSec)}`),
		"",
	];
	entries.push({ name: "comparison.txt", data: new TextEncoder().encode(lines.join("\n")) });
	return entries;
}

/** Bytes of one captured image, or null. */
export function readImage(root: string, id: string, frame: number, source: number): Buffer | null {
	if (!loadSession(root, id)) return null;
	const file = imagePath(root, id, frame, source);
	return existsSync(file) && statSync(file).isFile() ? readFileSync(file) : null;
}
