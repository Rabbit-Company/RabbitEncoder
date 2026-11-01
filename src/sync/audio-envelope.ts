import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { CancelledError } from "../core/process";

/** Envelope values per second: one per 10 ms. */
export const ENVELOPE_RATE = 100;
/** Coarse pass rate: one value per 100 ms, so a wide lag search stays fast. */
export const COARSE_RATE = 10;
/** Largest start difference searched between two releases. */
export const MAX_LAG_SEC = 180;
const SAMPLE_RATE = 8000;

export interface EnvelopeOptions {
	/** Seconds decoded from the start. The whole stream when absent. */
	windowSec?: number;
	signal?: AbortSignal;
}

/** Log RMS per 10 ms of one audio stream, mono at 8 kHz. */
export async function audioEnvelope(path: string, streamIndex: number, options: EnvelopeOptions = {}): Promise<Float32Array> {
	const { windowSec, signal } = options;
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
			...(windowSec ? ["-t", String(windowSec)] : []),
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
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const buf = await new Response(proc.stdout).arrayBuffer();
		await proc.exited;
		if (signal?.aborted) throw new CancelledError();
		const pcm = new Int16Array(buf, 0, Math.floor(buf.byteLength / 2));
		const per = SAMPLE_RATE / ENVELOPE_RATE;
		const env = new Float32Array(Math.floor(pcm.length / per));
		for (let i = 0; i < env.length; i++) {
			let sum = 0;
			for (let k = i * per; k < (i + 1) * per; k++) sum += pcm[k]! * pcm[k]!;
			env[i] = Math.log10(1e-3 + Math.sqrt(sum / per) / 32768);
		}
		return env;
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}

/**
 * The whole stream's envelope, kept in `cacheDir` under the file's path, size
 * and modification time, so a video aligned against several releases is
 * decoded once.
 */
export async function cachedAudioEnvelope(path: string, streamIndex: number, cacheDir: string, signal?: AbortSignal): Promise<Float32Array> {
	const { size, mtimeMs } = statSync(path);
	const key = createHash("sha1").update(`${path}\0${size}\0${mtimeMs}\0${streamIndex}\0${ENVELOPE_RATE}`).digest("hex");
	const dir = join(cacheDir, "envelopes");
	const file = join(dir, `${key}.f32`);
	if (existsSync(file)) {
		const bytes = readFileSync(file);
		return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
	}
	const env = await audioEnvelope(path, streamIndex, { signal });
	mkdirSync(dir, { recursive: true });
	writeFileSync(file, new Uint8Array(env.buffer, env.byteOffset, env.byteLength));
	return env;
}

export function downsample(env: Float32Array, factor: number): Float32Array {
	const out = new Float32Array(Math.floor(env.length / factor));
	for (let i = 0; i < out.length; i++) {
		let sum = 0;
		for (let k = 0; k < factor; k++) sum += env[i * factor + k]!;
		out[i] = sum / factor;
	}
	return out;
}

/** Pearson correlation of a[i] with b[i + lag] over their overlap, for i from `from` up to `to`. */
export function correlationAt(a: Float32Array, b: Float32Array, lag: number, from = 0, to = a.length): number {
	const start = Math.max(from, 0, -lag);
	const end = Math.min(to, a.length, b.length - lag);
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
 * Lag in envelope steps (10 ms) where b best matches a, with the correlation
 * at that lag. A coarse search over the whole range finds the area, a fine
 * one around it sets the exact value. `from` and `to` limit the part of `a`
 * that is matched, in envelope steps.
 */
export function bestLag(a: Float32Array, b: Float32Array, maxLagSec = MAX_LAG_SEC, from = 0, to = a.length): { lag: number; score: number } {
	const factor = ENVELOPE_RATE / COARSE_RATE;
	return bestLagOnCoarse(a, b, downsample(a, factor), downsample(b, factor), maxLagSec, from, to);
}

/** `bestLag` with the coarse envelopes made once by the caller, for many searches over the same pair. */
export function bestLagOnCoarse(
	a: Float32Array,
	b: Float32Array,
	ca: Float32Array,
	cb: Float32Array,
	maxLagSec = MAX_LAG_SEC,
	from = 0,
	to = a.length,
): { lag: number; score: number } {
	const factor = ENVELOPE_RATE / COARSE_RATE;
	const maxCoarse = Math.round(maxLagSec * COARSE_RATE);
	const cFrom = Math.floor(from / factor);
	const cTo = Math.ceil(to / factor);
	let coarse = 0;
	let coarseScore = -Infinity;
	for (let lag = -maxCoarse; lag <= maxCoarse; lag++) {
		const score = correlationAt(ca, cb, lag, cFrom, cTo);
		if (score > coarseScore) {
			coarseScore = score;
			coarse = lag;
		}
	}
	let lag = coarse * factor;
	let score = -Infinity;
	for (let l = (coarse - 1) * factor; l <= (coarse + 1) * factor; l++) {
		const s = correlationAt(a, b, l, from, to);
		if (s > score) {
			score = s;
			lag = l;
		}
	}
	return { lag, score };
}
