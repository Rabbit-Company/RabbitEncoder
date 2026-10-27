import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { Logger } from "../core/logger";
import { CancelledError, run } from "../core/process";
import type { ProbeResult, SubtitleStreamInfo } from "../core/types";
import { isTextSubtitleCodec } from "../tracks/tracks";
import { dialogueCues, type Interval, type TextCue } from "./cues";
import type { ReferenceKind } from "./score";

export interface ReferenceTimeline {
	kind: ReferenceKind;
	/** What the timeline came from, such as "subtitle track 3 (eng)". */
	label: string;
	intervals: Interval[];
	/** Text of a subtitle reference, for side by side samples. */
	cues?: TextCue[];
}

/** A text track with fewer dialogue cues is too sparse to sync against. */
const MIN_REFERENCE_CUES = 80;
const BITMAP_CODECS = new Set(["hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle"]);
const NOT_DIALOGUE_TITLE = /sign|song|forced|commentary|karaoke|storyboard|\bs&s\b/i;

function dialogueTrack(s: SubtitleStreamInfo): boolean {
	return !s.isForced && !NOT_DIALOGUE_TITLE.test(s.title ?? "");
}

/** Every text dialogue track extracted in one pass, and the one with the most cues kept. */
async function textReference(inputPath: string, streams: SubtitleStreamInfo[], workDir: string, signal?: AbortSignal): Promise<ReferenceTimeline | null> {
	const tracks = streams.filter((s) => isTextSubtitleCodec(s.codec) && dialogueTrack(s));
	if (!tracks.length) return null;
	const args = ["ffmpeg", "-v", "error", "-y", "-i", inputPath];
	const outputs = tracks.map((s) => {
		const ass = ["ass", "ssa"].includes(s.codec.toLowerCase());
		const path = join(workDir, `reference_${s.index}.${ass ? "ass" : "srt"}`);
		args.push("-map", `0:${s.index}`, "-c:s", ass ? "copy" : "srt", path);
		return { stream: s, path, format: (ass ? "ass" : "srt") as "ass" | "srt" };
	});
	const res = await run(args, { signal });
	if (signal?.aborted) throw new CancelledError();
	if (res.code !== 0) Logger.warn(`[subsearch] Extracting reference subtitles failed: ${res.stderr.slice(-300)}`);
	let best: ReferenceTimeline | null = null;
	for (const o of outputs) {
		if (!existsSync(o.path)) continue;
		const cues = dialogueCues({ format: o.format, content: readFileSync(o.path, "utf-8") });
		if (cues.length < MIN_REFERENCE_CUES || (best && cues.length <= best.cues!.length)) continue;
		best = { kind: "subtitle", label: `subtitle track ${o.stream.index} (${o.stream.language || "und"})`, intervals: cues, cues };
	}
	return best;
}

/** PGS, VobSub and DVB show and clear pictures, so their packet times mark the dialogue without reading the pictures. */
async function bitmapReference(inputPath: string, streams: SubtitleStreamInfo[], signal?: AbortSignal): Promise<ReferenceTimeline | null> {
	let best: ReferenceTimeline | null = null;
	for (const s of streams.filter((x) => BITMAP_CODECS.has(x.codec.toLowerCase()) && dialogueTrack(x))) {
		const res = await run(
			["ffprobe", "-v", "error", "-select_streams", String(s.index), "-show_entries", "packet=pts_time,duration_time,size", "-of", "csv=p=0", inputPath],
			{ signal },
		);
		if (signal?.aborted) throw new CancelledError();
		if (res.code !== 0) continue;
		const packets: Array<{ pts: number; duration: number; size: number }> = [];
		const parsed = res.stdout
			.split("\n")
			.map((line) => line.split(","))
			.map(([pts, duration, size]) => ({ pts: parseFloat(pts ?? ""), duration: parseFloat(duration ?? ""), size: parseInt(size ?? "", 10) || 0 }))
			.filter((p) => Number.isFinite(p.pts))
			.sort((a, b) => a.pts - b.pts);
		// Some containers carry every segment of a display set as its own packet, so packets at one time are one display set.
		for (const p of parsed) {
			const last = packets[packets.length - 1];
			if (last && p.pts - last.pts < 0.001) {
				last.size += p.size;
				if (p.duration > last.duration) last.duration = p.duration;
			} else packets.push({ ...p });
		}
		const intervals: Interval[] = [];
		for (let i = 0; i < packets.length; i++) {
			const p = packets[i]!;
			// A PGS display set that only clears the screen is a few dozen bytes.
			if (!(p.size > 100)) continue;
			const next = packets[i + 1]?.pts;
			const end = p.duration > 0 ? p.pts + p.duration : next !== undefined ? next : p.pts + 3;
			intervals.push({ startMs: Math.round(p.pts * 1000), endMs: Math.round(Math.min(end, p.pts + 10) * 1000) });
		}
		if (intervals.length < MIN_REFERENCE_CUES || (best && intervals.length <= best.intervals.length)) continue;
		best = { kind: "bitmap", label: `picture subtitle track ${s.index} (${s.language || "und"})`, intervals };
	}
	return best;
}

const FRAME_MS = 20;
const SAMPLE_RATE = 8000;
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000;
const BLOCK_FRAMES = 1500;

function percentile(values: Float32Array | number[], p: number): number {
	const sorted = Float32Array.from(values).sort();
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

/**
 * Speech intervals from frame loudness. A frame is speech when it is well
 * above the file's quiet level and above the quiet level of its own 30
 * seconds, so steady music and noise count less than speech with its pauses.
 */
export function speechFromLoudness(db: Float32Array): Interval[] {
	if (!db.length) return [];
	const floor = percentile(db, 0.1);
	const loud = percentile(db, 0.97);
	const threshold = floor + 0.4 * (loud - floor);
	const active = new Uint8Array(db.length);
	for (let start = 0; start < db.length; start += BLOCK_FRAMES) {
		const block = db.subarray(start, Math.min(db.length, start + BLOCK_FRAMES));
		const local = percentile(block, 0.2) + 6;
		for (let k = 0; k < block.length; k++) if (block[k]! > threshold && block[k]! > local) active[start + k] = 1;
	}
	const intervals: Interval[] = [];
	let runStart = -1;
	let gap = 0;
	for (let k = 0; k <= active.length; k++) {
		if (k < active.length && active[k]) {
			if (runStart < 0) runStart = k;
			gap = 0;
		} else if (runStart >= 0) {
			// Pauses inside a sentence are short, so a run ends after 300 ms of quiet.
			if (++gap < 15 && k < active.length) continue;
			const end = k - gap + 1;
			if ((end - runStart) * FRAME_MS >= 200) intervals.push({ startMs: runStart * FRAME_MS, endMs: end * FRAME_MS });
			runStart = -1;
			gap = 0;
		}
	}
	return intervals;
}

/** Decodes one audio track at 8 kHz and measures every 20 ms of it. Surround tracks use the centre channel, where dialogue sits. */
async function audioReference(inputPath: string, probe: ProbeResult, signal?: AbortSignal): Promise<ReferenceTimeline | null> {
	const audio = probe.audioStreams.find((a) => a.isOriginal) ?? probe.audioStreams[0];
	if (!audio) return null;
	const centre = audio.channels >= 3 && /\bFC\b|5\.1|7\.1|3\.0|3\.1|4\.1|6\.1/i.test(audio.channelLayout || `${audio.channels}`) ? "pan=mono|c0=FC," : "";
	const filter = `${centre}highpass=f=200,lowpass=f=3500`;
	const proc = Bun.spawn(
		[
			"ffmpeg",
			"-v",
			"error",
			"-i",
			inputPath,
			"-map",
			`0:${audio.index}`,
			"-vn",
			"-sn",
			"-dn",
			"-af",
			filter,
			"-ac",
			"1",
			"-ar",
			String(SAMPLE_RATE),
			"-f",
			"s16le",
			"-",
		],
		{ stdout: "pipe", stderr: "ignore" },
	);
	const abort = () => proc.kill("SIGKILL");
	signal?.addEventListener("abort", abort, { once: true });
	const frames: number[] = [];
	let sum = 0;
	let count = 0;
	// A chunk can end in the middle of a sample.
	let leftover = -1;
	const addSample = (value: number) => {
		const v = value / 32768;
		sum += v * v;
		if (++count === FRAME_SAMPLES) {
			frames.push(10 * Math.log10(sum / FRAME_SAMPLES + 1e-10));
			sum = 0;
			count = 0;
		}
	};
	try {
		for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
			let i = 0;
			if (leftover >= 0 && chunk.length) {
				addSample((((chunk[0]! << 8) | leftover) << 16) >> 16);
				leftover = -1;
				i = 1;
			}
			const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
			for (; i + 1 < chunk.length; i += 2) addSample(view.getInt16(i, true));
			if (i < chunk.length) leftover = chunk[i]!;
		}
		await proc.exited;
	} finally {
		signal?.removeEventListener("abort", abort);
	}
	if (signal?.aborted) throw new CancelledError();
	if (frames.length < 1000) return null;
	const delay = audio.delayMs || 0;
	const intervals = speechFromLoudness(Float32Array.from(frames)).map((i) => ({ startMs: i.startMs + delay, endMs: i.endMs + delay }));
	return { kind: "audio", label: `speech in audio track ${audio.index} (${audio.language || "und"})`, intervals };
}

const cache = new Map<string, ReferenceTimeline>();
const CACHE_SIZE = 4;

/**
 * Timing to sync downloaded subtitles to: the file's own dialogue subtitles
 * if it has any, else the display times of its picture subtitles, else speech
 * detected in its audio. Kept for a few files, as each needs a full read.
 */
export async function buildReference(inputPath: string, probe: ProbeResult, workDir: string, signal?: AbortSignal): Promise<ReferenceTimeline | null> {
	const st = statSync(inputPath);
	const key = `${inputPath}\n${st.size}\n${st.mtimeMs}`;
	const cached = cache.get(key);
	if (cached) return cached;
	const streams = probe.subtitleStreams ?? [];
	const reference =
		(await textReference(inputPath, streams, workDir, signal)) ??
		(await bitmapReference(inputPath, streams, signal)) ??
		(await audioReference(inputPath, probe, signal));
	if (!reference) return null;
	Logger.info(`[subsearch] Syncing to ${reference.label}, ${reference.intervals.length} intervals`);
	cache.set(key, reference);
	if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
	return reference;
}
