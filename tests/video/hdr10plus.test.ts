import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyArgs, describeMeasurement, measureArgs, measureHdr10Plus, runRetone } from "../../src/video/hdr10plus";

describe("retone commands", () => {
	test("measures the prepared video, with Dolby Vision scenes when there is a source", () => {
		const opts = { videoPath: "prepared.mkv", dolbyVisionPath: "source.mkv", metadataPath: "hdr10plus.json" };
		expect(measureArgs(opts, true)).toEqual([
			"retone",
			"convert",
			"source.mkv",
			"--video",
			"prepared.mkv",
			"-o",
			"hdr10plus.json",
			"-y",
			"--transfer",
			"pq",
			"--progress",
			"json",
		]);
		expect(measureArgs(opts, false).slice(0, 3)).toEqual(["retone", "measure", "prepared.mkv"]);
	});

	test("verifies only when asked, and fixes missing colour tags", () => {
		const args = applyArgs("in.ivf", "meta.json", "out.ivf", false);
		expect(args).toContain("--fix-color");
		expect(args).not.toContain("--verify");
		expect(applyArgs("in.ivf", "meta.json", "out.ivf", true)).toContain("--verify");
	});

	test("describes where the scenes come from", () => {
		expect(describeMeasurement({ frames: 48, scenes: 2, sceneSource: "dolby_vision_shots" })).toBe("2 scenes from Dolby Vision shots");
		expect(describeMeasurement({ frames: 48, scenes: 1, sceneSource: "measured" })).toBe("1 scene");
	});
});

function available(command: string[]): boolean {
	try {
		return Bun.spawnSync(command, { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
	} catch {
		return false;
	}
}

const tools = available(["retone", "--version"]) && available(["ffmpeg", "-version"]);

describe.skipIf(!tools)("retone on a PQ video", () => {
	test("measures it and writes the metadata into an AV1 encode", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rabbit-hdr10plus-"));
		try {
			const source = join(dir, "source.mkv");
			const filter =
				"testsrc2=size=192x128:rate=24:duration=1[a];smptehdbars=size=192x128:rate=24:duration=1[b];[a][b]concat=n=2,format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc";
			expect(available(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", filter, "-c:v", "ffv1", source])).toBe(true);
			const metadataPath = join(dir, "hdr10plus.json");
			const progress: number[] = [];
			const measurement = await measureHdr10Plus({ videoPath: source, metadataPath, onProgress: (p) => progress.push(p.frames) });
			expect(measurement.frames).toBe(48);
			expect(measurement.scenes).toBe(2);
			expect(JSON.parse(readFileSync(metadataPath, "utf8")).SceneInfo).toHaveLength(48);

			// An encoder that leaves out the colour tags, as ffmpeg's SVT-AV1 wrapper can.
			const ivf = join(dir, "encode.ivf");
			if (!available(["ffmpeg", "-v", "error", "-y", "-i", source, "-c:v", "libsvtav1", "-preset", "12", "-crf", "40", ivf])) return;
			const output = join(dir, "hdr10plus.ivf");
			const run = await runRetone(applyArgs(ivf, metadataPath, output, true));
			expect(run.code).toBe(0);
			expect(existsSync(output)).toBe(true);

			// A Dolby Vision source that does not fit falls back to measured scenes.
			const fallback = await measureHdr10Plus({ videoPath: source, dolbyVisionPath: ivf, metadataPath });
			expect(fallback.sceneSource).toBe("measured");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 120_000);
});
