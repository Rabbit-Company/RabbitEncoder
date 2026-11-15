import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_AVD_PARAMS,
	DEFAULT_RABBIT_PARAMS,
	assertAvdDeviceUsable,
	rabbitOptionArgs,
	avdEngineLabel,
	avdEngineUsesPreset,
	buildAvdArgs,
	isAvdEngine,
	isAvdSelfTuningEngine,
	mergeEqualStrengthRanges,
	normalizeAvdParams,
	probeRabbitDenoise,
	runAvdPass,
} from "../../src/video/avd";
import { run } from "../../src/core/process";

describe("rabbit-denoise engine", () => {
	test("is a self-tuning engine of its own program, without a speed preset", () => {
		expect(isAvdEngine("rabbit-denoise")).toBe(true);
		expect(isAvdSelfTuningEngine("rabbit-denoise")).toBe(true);
		expect(avdEngineUsesPreset("rabbit-denoise")).toBe(false);
		expect(avdEngineLabel("rabbit-denoise")).toBe("Rabbit Denoise");
	});

	test("denoises y4m from standard input at the scale, on the GPU when one works", () => {
		const params = normalizeAvdParams({ scales: { "avd-nlmeans-hq": 1, "avd-nl4d": 1, "rabbit-denoise": 1.5 } }, DEFAULT_AVD_PARAMS);
		expect(buildAvdArgs("rabbit-denoise", "heavy", params, "discrete:0", "-")).toEqual(["denoise", "-q", "--device", "auto", "--sigma-scale", "1.5", "-"]);
	});

	test("passes only the options that differ from rabbit-denoise's defaults", () => {
		expect(rabbitOptionArgs(DEFAULT_RABBIT_PARAMS)).toEqual([]);
		const changed = {
			...DEFAULT_RABBIT_PARAMS,
			step: 4,
			temporalRadius: 2,
			chromaScale: 1.5,
			followRadius: 2,
			motion: false,
			singleFrameCap: false,
			basic: true,
		};
		expect(rabbitOptionArgs(changed)).toEqual([
			"--chroma-scale",
			"1.5",
			"--step",
			"4",
			"--temporal-radius",
			"2",
			"--follow-radius",
			"2",
			"--basic",
			"--no-motion",
			"--no-single-frame-cap",
		]);
		const params = { ...DEFAULT_AVD_PARAMS, rabbit: { ...changed, device: "cpu" as const } };
		expect(buildAvdArgs("rabbit-denoise", "light", params, "default", "-").slice(0, 4)).toEqual(["denoise", "-q", "--device", "cpu"]);
	});

	test("keeps every option within what rabbit-denoise accepts", () => {
		const rabbit = normalizeAvdParams(
			{ rabbit: { ...DEFAULT_RABBIT_PARAMS, step: 9, temporalRadius: 2.6, lambda: 0, matchLimit: 100, followRadius: null, device: "tpu" as any } },
			DEFAULT_AVD_PARAMS,
		).rabbit;
		expect(rabbit.step).toBe(6);
		expect(rabbit.temporalRadius).toBe(3);
		expect(rabbit.lambda).toBe(1);
		expect(rabbit.matchLimit).toBe(8);
		expect(rabbit.followRadius).toBeNull();
		expect(rabbit.device).toBe("auto");
	});

	test("runs a job on the CPU when set to, and says so", async () => {
		const note = await assertAvdDeviceUsable("rabbit-denoise", "default", { ...DEFAULT_AVD_PARAMS, rabbit: { ...DEFAULT_RABBIT_PARAMS, device: "cpu" } });
		expect(note).toContain("CPU");
	});

	test("keeps the scale within what rabbit-denoise accepts, and fills it in for older settings", () => {
		const scales = (v: number) => normalizeAvdParams({ scales: { "avd-nlmeans-hq": 1, "avd-nl4d": 1, "rabbit-denoise": v } }, DEFAULT_AVD_PARAMS).scales;
		expect(scales(9)["rabbit-denoise"]).toBe(4);
		expect(scales(0.1)["rabbit-denoise"]).toBe(0.25);
		const older = normalizeAvdParams({ scales: { "avd-nlmeans-hq": 1.2, "avd-nl4d": 0.9 } as any }, DEFAULT_AVD_PARAMS);
		expect(older.scales["rabbit-denoise"]).toBe(1);
		expect(older.scales["avd-nl4d"]).toBe(0.9);
		expect(older.rabbit).toEqual(DEFAULT_RABBIT_PARAMS);
	});

	test("joins touching auto denoise ranges, as the level does not change its strength", () => {
		const plan = [
			{ start: 0, end: 10, level: "light" as const },
			{ start: 10, end: 20, level: "heavy" as const },
			{ start: 30, end: 40, level: "medium" as const },
		];
		expect(mergeEqualStrengthRanges(plan, "rabbit-denoise", DEFAULT_AVD_PARAMS).map((r) => [r.start, r.end])).toEqual([
			[0, 20],
			[30, 40],
		]);
	});
});

// Runs only where rabbit-denoise is installed and finds a GPU.
const installed = (await run(["bash", "-c", "command -v rabbit-denoise"]).catch(() => ({ code: 1 }))).code === 0;
const usable = installed && (await probeRabbitDenoise()) === null;

describe.skipIf(!usable)("rabbit-denoise pass", () => {
	test("writes FFV1 with every frame and the source's colour tags", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rabbit-denoise-"));
		try {
			const input = join(dir, "in.mkv");
			const output = join(dir, "out.mkv");
			const made = await run([
				"ffmpeg",
				"-v",
				"error",
				"-f",
				"lavfi",
				"-i",
				"testsrc2=size=320x180:rate=24:duration=1",
				"-vf",
				"setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv,format=yuv420p10le",
				"-c:v",
				"ffv1",
				input,
			]);
			expect(made.code).toBe(0);

			await runAvdPass({ inputPath: input, outputPath: output, engine: "rabbit-denoise", level: "medium", params: DEFAULT_AVD_PARAMS, device: "default" });
			expect(existsSync(output)).toBe(true);

			const probe = await run([
				"ffprobe",
				"-v",
				"error",
				"-count_frames",
				"-select_streams",
				"v:0",
				"-show_entries",
				"stream=codec_name,pix_fmt,nb_read_frames,color_primaries",
				"-of",
				"json",
				output,
			]);
			const stream = JSON.parse(probe.stdout).streams[0];
			expect(stream.codec_name).toBe("ffv1");
			expect(stream.pix_fmt).toBe("yuv420p10le");
			expect(stream.nb_read_frames).toBe("24");
			expect(stream.color_primaries).toBe("bt709");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 120_000);
});
