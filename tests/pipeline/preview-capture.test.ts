import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { run } from "../../src/core/process";
import { captureFrame } from "../../src/pipeline/preview-encoder";

const hasFfmpeg = !!Bun.which("ffmpeg");

async function meanRgb(png: string): Promise<[number, number, number]> {
	const proc = Bun.spawn(["ffmpeg", "-v", "error", "-i", png, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { stdout: "pipe" });
	const data = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
	const sums = [0, 0, 0];
	for (let i = 0; i < data.length; i++) sums[i % 3]! += data[i]!;
	const n = data.length / 3;
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

		const color = { range: "tv" as const, space: "bt709" };
		const signal = new AbortController().signal;
		expect(await captureFrame(eight, join(root, "eight.png"), 5, "none", color, 360, signal)).toBe(true);
		expect(await captureFrame(ten, join(root, "ten.png"), 5, "none", color, 360, signal)).toBe(true);
		const [a, b] = await Promise.all([meanRgb(join(root, "eight.png")), meanRgb(join(root, "ten.png"))]);
		for (let c = 0; c < 3; c++) expect(Math.abs(a[c]! - b[c]!)).toBeLessThan(0.1);
	}, 30_000);
});
