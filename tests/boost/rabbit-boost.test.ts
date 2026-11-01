import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { run } from "../../src/core/process";
import { readIvf } from "../../src/boost/ivf";
import { runRabbitBoost, type BoostStage, type RabbitBoostOptions } from "../../src/boost/rabbit-boost";

const SVT = "SVT-AV1-Essential";
const hasTools =
	!!Bun.which(SVT) && !!Bun.which("ffmpeg") && Bun.spawnSync(["python3", "-c", "import vapoursynth as vs; vs.core.vszip; vs.core.ffms2"]).exitCode === 0;

(hasTools ? describe : describe.skip)("runRabbitBoost", () => {
	const root = mkdtempSync(join(tmpdir(), "rabbit-boost-"));
	afterAll(() => rmSync(root, { recursive: true, force: true }));
	const input = join(root, "source_video.mkv");

	async function source() {
		if (existsSync(input)) return;
		// Three patterns two seconds each, so the fast pass finds scene cuts between them.
		const made = await run([
			"ffmpeg",
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"testsrc2=size=320x180:rate=24:duration=2",
			"-f",
			"lavfi",
			"-i",
			"mandelbrot=size=320x180:rate=24",
			"-f",
			"lavfi",
			"-i",
			"cellauto=size=320x180:rate=24:rule=110",
			"-filter_complex",
			"[1]trim=duration=2,setpts=PTS-STARTPTS[b];[2]trim=duration=2,setpts=PTS-STARTPTS[c];[0][b][c]concat=n=3,format=yuv420p[v]",
			"-map",
			"[v]",
			"-c:v",
			"ffv1",
			input,
		]);
		if (made.code !== 0) throw new Error(made.stderr);
	}

	async function boost(name: string, options: Partial<RabbitBoostOptions> = {}) {
		await source();
		const stages: string[] = [];
		const output = join(root, `${name}.ivf`);
		const result = await runRabbitBoost({
			binary: SVT,
			input,
			output,
			workDir: join(root, name),
			quality: "medium",
			finalSpeed: "faster",
			speedNames: true,
			colorParams: [],
			customParams: [],
			dark: true,
			maxKbps: 0,
			skipBoosting: false,
			expectedFrames: 144,
			onStage: (stage: BoostStage, status) => stages.push(`${stage}:${status}`),
			onProgress: () => {},
			...options,
		});
		return { result, stages, output };
	}

	it("encodes in five stages with a zone per scene of the fast pass", async () => {
		const { result, stages, output } = await boost("plain");
		expect(stages).toEqual([
			"fast:active",
			"fast:done",
			"scenes:active",
			"scenes:done",
			"metrics:active",
			"metrics:done",
			"zones:active",
			"zones:done",
			"final:active",
			"final:done",
		]);
		const fast = readIvf(join(root, "plain", "fast.ivf"));
		const keyframes = fast.frames.flatMap((f, i) => (f.keyframe ? [i] : []));
		expect(result.zones.map((z) => z.start)).toEqual(keyframes);
		expect(result.zones.length).toBeGreaterThanOrEqual(3);
		expect(readFileSync(join(root, "plain", "zones.cfg"), "utf-8")).toMatch(/^Zones : 0,\d+,[\d.]+;/);
		expect(readIvf(output).frames).toHaveLength(144);
		expect(result.zones.every((z) => z.score > 0)).toBe(true);
	}, 180_000);

	it("keeps the encode under a bitrate cap", async () => {
		const plain = await boost("uncapped-ref");
		const plainKbps = (statSync(plain.output).size * 8) / 6 / 1000;
		const capKbps = Math.round(plainKbps / 3);
		const { result, output } = await boost("capped", { maxKbps: capKbps });
		const kbps = (statSync(output).size * 8) / 6 / 1000;
		expect(result.zones.some((z) => z.capped)).toBe(true);
		expect(result.summary).toContain("capped at");
		expect(kbps).toBeLessThanOrEqual(capKbps * 1.1);
	}, 240_000);

	(Bun.which("SVT-AV1-Tritium") ? it : it.skip)(
		"drives SVT-AV1-Tritium with CRF and preset",
		async () => {
			const { result, output } = await boost("tritium", {
				binary: "SVT-AV1-Tritium",
				speedNames: false,
				manual: { crf: 28, preset: 10 },
			});
			expect(result.zones.length).toBeGreaterThanOrEqual(3);
			// Without scores to separate them, every zone sits around the CRF given.
			expect(result.zones.every((z) => Math.abs(z.crf - 28) <= 5)).toBe(true);
			expect(readIvf(output).frames).toHaveLength(144);
		},
		180_000,
	);

	it("refuses an encoder without quality presets when no CRF is given", async () => {
		await expect(boost("no-crf", { binary: "SVT-AV1-Tritium", speedNames: false })).rejects.toThrow("takes a CRF and preset");
	});

	it("encodes once without the fast pass when boosting is skipped", async () => {
		const { result, stages, output } = await boost("skipped", { skipBoosting: true, maxKbps: 200 });
		expect(stages).toEqual(["final:active", "final:done"]);
		expect(result.zones).toEqual([]);
		expect(existsSync(join(root, "skipped", "fast.ivf"))).toBe(false);
		expect(readIvf(output).frames).toHaveLength(144);
	}, 180_000);
});
