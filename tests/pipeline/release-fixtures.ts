import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { run } from "../../src/core/process";
import { identifyMatroska } from "../../src/pipeline/repair";

export const RATE = 8000;
export const hasReleaseTools = ["ffmpeg", "mkvmerge", "mkvextract"].every((tool) => Bun.which(tool));

/** Noise whose loudness changes every 100 ms, so its envelope is as distinct as speech. */
export function speechLike(seconds: number, seed: number): Int16Array {
	let x = seed >>> 0;
	const random = () => {
		x = (x + 0x6d2b79f5) >>> 0;
		let t = Math.imul(x ^ (x >>> 15), x | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const out = new Int16Array(seconds * RATE);
	let amplitude = 0;
	for (let i = 0; i < out.length; i++) {
		if (i % (RATE / 10) === 0) amplitude = random() ** 2;
		out[i] = Math.round(amplitude * (random() * 2 - 1) * 20000);
	}
	return out;
}

export function writeWav(path: string, ...parts: Int16Array[]): void {
	const samples = parts.reduce((n, p) => n + p.length, 0);
	const buf = Buffer.alloc(44 + samples * 2);
	buf.write("RIFF", 0);
	buf.writeUInt32LE(36 + samples * 2, 4);
	buf.write("WAVEfmt ", 8);
	buf.writeUInt32LE(16, 16);
	buf.writeUInt16LE(1, 20);
	buf.writeUInt16LE(1, 22);
	buf.writeUInt32LE(RATE, 24);
	buf.writeUInt32LE(RATE * 2, 28);
	buf.writeUInt16LE(2, 32);
	buf.writeUInt16LE(16, 34);
	buf.write("data", 36);
	buf.writeUInt32LE(samples * 2, 40);
	let at = 44;
	for (const part of parts) for (const v of part) at = buf.writeInt16LE(v, at);
	writeFileSync(path, buf);
}

export function srtTime(ms: number): string {
	const pad = (n: number, w = 2) => String(n).padStart(w, "0");
	return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

export function assTime(ms: number): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${Math.floor(ms / 3_600_000)}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(Math.floor((ms % 1000) / 10))}`;
}

/** An SRT of 1.5 s lines starting at the given times. */
export function srtOf(lines: Array<readonly [number, string]>): string {
	return [...lines]
		.sort((a, b) => a[0] - b[0])
		.map(([t, text], i) => `${i + 1}\n${srtTime(t)} --> ${srtTime(t + 1500)}\n${text}\n`)
		.join("\n");
}

export async function command(args: string[]): Promise<void> {
	const result = await run(args);
	if (result.code !== 0 && !(args[0] === "mkvmerge" && result.code === 1)) throw new Error(result.stderr || result.stdout);
}

/** A small black video with the audio of `wav`. */
export async function makeAvMkv(path: string, wav: string, seconds: number): Promise<void> {
	await command([
		"ffmpeg",
		"-v",
		"error",
		"-f",
		"lavfi",
		"-i",
		`color=black:s=64x64:r=10:d=${seconds}`,
		"-i",
		wav,
		"-map",
		"0:v",
		"-map",
		"1:a",
		"-c:v",
		"libx264",
		"-preset",
		"ultrafast",
		"-c:a",
		"flac",
		"-shortest",
		path,
	]);
}

/** The text of the n-th subtitle track of an MKV. */
export async function extractSubtitle(mkv: string, n: number, extension: string, outDir: string): Promise<string> {
	const info = await identifyMatroska(mkv);
	const id = (info.tracks ?? []).filter((t) => t.type === "subtitles")[n]!.id;
	const out = join(outDir, `${Math.random().toString(36).slice(2)}${extension}`);
	await command(["mkvextract", mkv, "tracks", `${id}:${out}`]);
	return readFileSync(out, "utf-8");
}
