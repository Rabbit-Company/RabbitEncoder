import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { run } from "../../src/core/process";
import { captureFrame } from "../../src/pipeline/preview-encoder";
import { STILL_STYLES } from "../../src/core/still-style";
import { viewablePng, intoBitDepthFolders } from "../../src/video/screenshot";

const COLOR = { range: "tv" as const, space: "bt709", transfer: null, primaries: null, chromaLocation: null };

const hasFfmpeg = !!Bun.which("ffmpeg");

async function meanRgb(png: string): Promise<[number, number, number]> {
	const proc = Bun.spawn(["ffmpeg", "-v", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { stdout: "pipe" });
	const data = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
	const sums = [0, 0, 0];
	for (let i = 0; i < data.length; i++) sums[i % 3]! += data[i]!;
	const n = data.length / 3;
	return [sums[0]! / n, sums[1]! / n, sums[2]! / n];
}

/** Mean per channel on the 0 to 255 scale, read at 16 bits so a 16-bit PNG is not rounded first. */
async function meanRgb16(png: string): Promise<[number, number, number]> {
	const proc = Bun.spawn(["ffmpeg", "-v", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "rgb48le", "-"], { stdout: "pipe" });
	const data = new Uint16Array(await new Response(proc.stdout).arrayBuffer());
	const sums = [0, 0, 0];
	for (let i = 0; i < data.length; i++) sums[i % 3]! += data[i]!;
	const n = (data.length / 3) * 257;
	return [sums[0]! / n, sums[1]! / n, sums[2]! / n];
}

(hasFfmpeg ? describe : describe.skip)("captureFrame", () => {
	const root = mkdtempSync(join(tmpdir(), "rabbit-capture-"));
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it("gives the same colours for the same picture in 8 and 10 bits", async () => {
		const eight = join(root, "eight.mkv");
		const ten = join(root, "ten.mkv");
		// A dark coloured gradient, where the rounding of the conversion showed most.
		const made = await run([
			"ffmpeg",
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"gradients=size=640x360:rate=24:duration=1:c0=0x101830:c1=0x403060,format=yuv420p",
			"-c:v",
			"ffv1",
			eight,
		]);
		if (made.code !== 0) throw new Error(made.stderr);
		const converted = await run(["ffmpeg", "-v", "error", "-i", eight, "-pix_fmt", "yuv420p10le", "-c:v", "ffv1", ten]);
		if (converted.code !== 0) throw new Error(converted.stderr);

		const signal = new AbortController().signal;
		for (const style of STILL_STYLES) {
			expect(await captureFrame(eight, join(root, `eight_${style}.png`), 5, "none", COLOR, 360, style, signal)).toBe(true);
			expect(await captureFrame(ten, join(root, `ten_${style}.png`), 5, "none", COLOR, 360, style, signal)).toBe(true);
			const [a, b] = await Promise.all([meanRgb(join(root, `eight_${style}.png`)), meanRgb(join(root, `ten_${style}.png`))]);
			for (let c = 0; c < 3; c++) expect(Math.abs(a[c]! - b[c]!)).toBeLessThan(0.1);
		}
	}, 60_000);

	it("saves 16-bit PNGs, with mpv's darker shadows only in the mpv style", async () => {
		const dark = join(root, "dark.mkv");
		const made = await run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=0x141414:s=320x180:r=24:d=1,format=yuv420p", "-c:v", "ffv1", dark]);
		if (made.code !== 0) throw new Error(made.stderr);
		const signal = new AbortController().signal;
		const levels: Record<string, number> = {};
		for (const style of STILL_STYLES) {
			const png = join(root, `dark_${style}.png`);
			expect(await captureFrame(dark, png, 0, "none", COLOR, 180, style, signal)).toBe(true);
			const probe = await run(["ffprobe", "-v", "error", "-show_entries", "stream=pix_fmt", "-of", "csv=p=0", png]);
			expect(probe.stdout.trim()).toBe("rgb48be");
			levels[style] = (await meanRgb(png))[1];
		}
		// The standard style keeps the video's own values, like a plain matrix conversion.
		expect(Math.abs(levels.standard! - 20)).toBeLessThan(1);
		// mpv shows BT.1886 as sRGB, which puts level 20 near 18.7.
		expect(levels.standard! - levels.mpv!).toBeGreaterThan(0.8);
		expect(levels.standard! - levels.mpv!).toBeLessThan(2.5);
	}, 60_000);

	it("shows 16-bit stills through a dithered 8-bit copy of the same brightness", async () => {
		const gradient = join(root, "gradient.mkv");
		const made = await run([
			"ffmpeg",
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"gradients=size=640x360:rate=24:duration=1:c0=0x0c1018:c1=0x203040,format=yuv420p10le",
			"-c:v",
			"ffv1",
			gradient,
		]);
		if (made.code !== 0) throw new Error(made.stderr);
		const still = join(root, "gradient.png");
		expect(await captureFrame(gradient, still, 0, "none", COLOR, 360, "standard", new AbortController().signal)).toBe(true);
		const view = await viewablePng(still);
		expect(view).not.toBe(still);
		const probe = await run(["ffprobe", "-v", "error", "-show_entries", "stream=pix_fmt", "-of", "csv=p=0", view]);
		expect(probe.stdout.trim()).toBe("rgb24");
		const [a, b] = await Promise.all([meanRgb16(still), meanRgb(view)]);
		for (let c = 0; c < 3; c++) expect(Math.abs(a[c]! - b[c]!)).toBeLessThan(0.05);
		expect(await viewablePng(view)).toBe(view);

		const entries = await intoBitDepthFolders([
			{ name: "01_1_Source.png", data: readFileSync(still), path: still },
			{ name: "01_2_Encode.png", data: readFileSync(view), path: view },
			{ name: "preview.txt", data: new Uint8Array() },
		]);
		expect(entries.map((e) => e.name)).toEqual(["16bit/01_1_Source.png", "8bit/01_1_Source.png", "8bit/01_2_Encode.png", "preview.txt"]);
		expect(entries[0]!.data).toEqual(new Uint8Array(readFileSync(still)));
		expect(entries[1]!.data).toEqual(new Uint8Array(readFileSync(view)));
		expect(entries.every((e) => !("path" in e))).toBe(true);
	}, 60_000);
});
