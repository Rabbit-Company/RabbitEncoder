import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_AUTO_THRESHOLDS,
	DEFAULT_BITRATE_THRESHOLDS,
	DEFAULT_GRAIN_THRESHOLDS,
	autoThresholdsFor,
	buildPlanFromScenes,
	grainScenesFromEvents,
	runGrainSceneAnalysis,
} from "../../src/video/auto-denoise";
import { run } from "../../src/core/process";

const scene = (start: number, end: number, grain: number | null) =>
	JSON.stringify({ event: "scene", index: 0, first_frame: 0, last_frame: 0, frames: 1, start_seconds: start, end_seconds: end, grain });

describe("grain metric", () => {
	test("reads every scene of rabbit-denoise analyze, a scene without grain as 0", () => {
		const lines = [
			JSON.stringify({ event: "start", width: 1920, height: 1080, fps: 24, total: 96 }),
			scene(0, 1, 0.4),
			JSON.stringify({ event: "progress", frames: 30, total: 96, percent: 31 }),
			scene(1, 2.5, 3.2),
			scene(2.5, 4, null),
			"not json",
			JSON.stringify({ event: "summary", frames: 96, scenes: 3 }),
		];
		expect(grainScenesFromEvents(lines)).toEqual([
			{ start: 0, end: 1, value: 0.4 },
			{ start: 1, end: 2.5, value: 3.2 },
			{ start: 2.5, end: 4, value: 0 },
		]);
	});

	test("denoises only the scenes whose grain reaches light, at the level they reach", () => {
		const plan = buildPlanFromScenes(
			[
				{ start: 0, end: 10, value: 0.3 },
				{ start: 10, end: 20, value: 2.4 },
				{ start: 20, end: 30, value: 3.5 },
				{ start: 30, end: 40, value: 0.8 },
				{ start: 40, end: 50, value: 6 },
			],
			DEFAULT_GRAIN_THRESHOLDS,
		);
		expect(plan).toEqual([
			{ start: 10, end: 20, level: "light" },
			{ start: 20, end: 30, level: "medium" },
			{ start: 40, end: 50, level: "heavy" },
		]);
	});

	test("keeps the reading of a short scene, as rabbit-denoise does", () => {
		// A clean half second between grainy scenes stays undenoised, and a grainy one stays denoised.
		const plan = buildPlanFromScenes(
			[
				{ start: 0, end: 5, value: 3.5 },
				{ start: 5, end: 5.5, value: 0.4 },
				{ start: 5.5, end: 10, value: 3.5 },
				{ start: 10, end: 20, value: 0.5 },
				{ start: 20, end: 20.3, value: 2.2 },
				{ start: 20.3, end: 30, value: 0.5 },
			],
			DEFAULT_GRAIN_THRESHOLDS,
		);
		expect(plan).toEqual([
			{ start: 0, end: 5, level: "medium" },
			{ start: 5.5, end: 10, level: "medium" },
			{ start: 20, end: 20.3, level: "light" },
		]);
	});

	test("uses the thresholds of the job's metric", () => {
		const grain = { light: 1.5, medium: 2.5, heavy: 4 };
		const settings = {
			autoDenoiseMetric: "grain" as const,
			autoDenoiseThresholds: DEFAULT_AUTO_THRESHOLDS,
			autoDenoiseBitrateThresholds: DEFAULT_BITRATE_THRESHOLDS,
			autoDenoiseGrainThresholds: grain,
		};
		expect(autoThresholdsFor(settings)).toBe(grain);
		expect(autoThresholdsFor({ ...settings, autoDenoiseMetric: "bitrate" })).toBe(DEFAULT_BITRATE_THRESHOLDS);
		expect(autoThresholdsFor({ ...settings, autoDenoiseMetric: "noise" })).toBe(DEFAULT_AUTO_THRESHOLDS);
		// Settings saved before the grain metric existed.
		expect(autoThresholdsFor({ ...settings, autoDenoiseGrainThresholds: undefined as any })).toBe(DEFAULT_GRAIN_THRESHOLDS);
	});
});

// Runs only where a rabbit-denoise with `analyze` (0.1.8 and later) is installed. It needs no GPU.
const analyzes = (await run(["bash", "-c", "rabbit-denoise analyze --help"]).catch(() => ({ code: 1 }))).code === 0;

describe.skipIf(!analyzes)("rabbit-denoise analyze", () => {
	test("finds a clean scene and a grainy one", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rabbit-grain-"));
		try {
			// Two seconds of a flat picture, then two seconds of a different one with strong grain.
			const clip = join(dir, "clip.mkv");
			const made = await run([
				"ffmpeg",
				"-v",
				"error",
				"-f",
				"lavfi",
				"-i",
				"color=c=0x606060:size=640x360:rate=24:duration=2",
				"-f",
				"lavfi",
				"-i",
				"color=c=0xc0c0c0:size=640x360:rate=24:duration=2",
				"-filter_complex",
				"[1:v]noise=alls=40:allf=t[g];[0:v][g]concat=n=2:v=1:a=0,format=yuv420p",
				"-c:v",
				"ffv1",
				clip,
			]);
			expect(made.code).toBe(0);
			const fractions: number[] = [];
			const scenes = await runGrainSceneAnalysis(clip, undefined, (fraction) => fractions.push(fraction));
			expect(scenes).not.toBeNull();
			expect(scenes!.length).toBe(2);
			expect(scenes![0]!.start).toBe(0);
			expect(scenes![1]!.start).toBeCloseTo(2, 2);
			expect(scenes![0]!.value).toBeLessThan(1);
			expect(scenes![1]!.value).toBeGreaterThan(3);
			const plan = buildPlanFromScenes(scenes!, DEFAULT_GRAIN_THRESHOLDS);
			expect(plan.length).toBe(1);
			expect(plan[0]!.start).toBeCloseTo(2, 2);
			expect(fractions.length).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("fails without a video", async () => {
		expect(await runGrainSceneAnalysis("/nonexistent/video.mkv")).toBeNull();
	});
});
