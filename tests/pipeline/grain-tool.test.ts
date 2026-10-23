import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig, GrainPlan, Job } from "../../src/core/types";
import {
	checkFilmGrainTable,
	describeGrainPlan,
	exportFilmGrainTable,
	grainWriteArgs,
	inspectGrainFile,
	runGrainJob,
	sanitizeGrainPlan,
} from "../../src/pipeline/grain-tool";

describe("Film grain plans", () => {
	test("need an action, a strength or a table", () => {
		expect(() => sanitizeGrainPlan({ targetPath: "a.mkv" })).toThrow("Choose what to do");
		expect(() => sanitizeGrainPlan({ targetPath: "a.mkv", action: "synthetic" })).toThrow("strength");
		expect(() => sanitizeGrainPlan({ targetPath: "a.mkv", action: "synthetic", strength: 0 })).toThrow("strength");
		expect(() => sanitizeGrainPlan({ targetPath: "a.mkv", action: "synthetic", strength: 65 })).toThrow("strength");
		expect(() => sanitizeGrainPlan({ targetPath: "a.mkv", action: "table" })).toThrow("Upload");
		expect(sanitizeGrainPlan({ targetPath: "a.mkv", action: "synthetic", strength: "3.14" as unknown as number, size: "huge" as never })).toEqual({
			targetPath: "a.mkv",
			action: "synthetic",
			strength: 3.1,
			size: "medium",
			chroma: 0,
		});
	});

	test("take an ISO instead of a strength", () => {
		const plan = sanitizeGrainPlan({ targetPath: "a.mkv", action: "synthetic", iso: 400.2, strength: 3 });
		expect(plan).toEqual({ targetPath: "a.mkv", action: "synthetic", iso: 400, size: "medium", chroma: 0 });
		expect(describeGrainPlan(plan)).toBe("ISO 400 grain, medium");
		expect(() => sanitizeGrainPlan({ targetPath: "a.mkv", action: "synthetic", iso: 20 })).toThrow("ISO");
	});

	test("measure from an original, but never in a folder", () => {
		expect(() => sanitizeGrainPlan({ targetPath: "a.mkv", action: "measure" })).toThrow("original");
		expect(() => sanitizeGrainPlan({ targetPath: "", action: "measure", sourcePath: "/o.mkv", batch: true })).toThrow("own original");
		const plan = sanitizeGrainPlan({ targetPath: "a.mkv", action: "measure", sourcePath: "/o.mkv", sampling: "nope" as never, justEnough: true });
		expect(plan).toEqual({ targetPath: "a.mkv", action: "measure", sourcePath: "/o.mkv", sampling: "all", range: "representative", justEnough: true });
		expect(describeGrainPlan({ ...plan, range: "full", measureChroma: true })).toBe("Grain measured from the original, just enough, with chroma, full video");
	});

	test("keep static grain only when grain is written, and batch options only in a batch", () => {
		expect(sanitizeGrainPlan({ targetPath: "a.mkv", action: "remove", staticGrain: true, skipExisting: true })).toEqual({
			targetPath: "a.mkv",
			action: "remove",
		});
		expect(sanitizeGrainPlan({ targetPath: "", action: "table", tablePath: "/t.tbl", staticGrain: true, batch: true, skipExisting: true })).toEqual({
			targetPath: "",
			action: "table",
			tablePath: "/t.tbl",
			staticGrain: true,
			batch: true,
			skipExisting: true,
		});
	});

	test("describe themselves and become regrain runs", () => {
		const synthetic = sanitizeGrainPlan({ targetPath: "a.mkv", action: "synthetic", strength: 4, size: "coarse", chroma: 1, staticGrain: true });
		expect(describeGrainPlan(synthetic)).toBe("Synthetic grain 4, coarse, chroma 1, static");
		expect(describeGrainPlan({ targetPath: "a.mkv", action: "remove" })).toBe("Remove film grain");
		expect(grainWriteArgs(synthetic, "in.ivf", "out.ivf", "g.tbl")).toEqual([
			"regrain",
			"apply",
			"in.ivf",
			"-o",
			"out.ivf",
			"-t",
			"g.tbl",
			"-y",
			"--verify",
			"--progress",
			"json",
			"--static-grain",
		]);
		expect(grainWriteArgs({ targetPath: "a.mkv", action: "remove" }, "in.ivf", "out.ivf", null)).toEqual([
			"regrain",
			"remove",
			"in.ivf",
			"-o",
			"out.ivf",
			"-y",
			"--verify",
			"--progress",
			"json",
		]);
	});
});

function available(command: string[]): boolean {
	try {
		return Bun.spawnSync(command, { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
	} catch {
		return false;
	}
}

function sh(command: string[]): string {
	const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`${command.join(" ")}: ${result.stderr.toString()}`);
	return result.stdout.toString();
}

const tools = [
	["regrain", "--version"],
	["ffmpeg", "-version"],
	["mkvmerge", "--version"],
	["mkvextract", "--version"],
	["mkvpropedit", "--version"],
	["mediainfo", "--Version"],
].every((command) => available(command));

/** An AV1 MKV without grain, with a named video track, Opus audio, a subtitle, a font, chapters and global tags. */
function makeMkv(dir: string, name: string): string {
	const base = join(dir, `${name}-base.mkv`);
	const filter = "testsrc2=size=192x128:rate=24000/1001:duration=2,format=yuv420p10le";
	sh([
		"ffmpeg",
		"-v",
		"error",
		"-y",
		"-f",
		"lavfi",
		"-i",
		filter,
		"-f",
		"lavfi",
		"-i",
		"sine=d=2",
		"-c:v",
		"libsvtav1",
		"-preset",
		"12",
		"-crf",
		"45",
		"-c:a",
		"libopus",
		"-t",
		"2",
		base,
	]);
	writeFileSync(join(dir, "s.srt"), "1\n00:00:00,500 --> 00:00:01,500\nHello\n");
	writeFileSync(
		join(dir, "tags.xml"),
		'<?xml version="1.0"?><Tags><Tag><Targets><TargetTypeValue>50</TargetTypeValue></Targets><Simple><Name>RABBIT_ENCODER</Name><Simple><Name>SETTINGS</Name><String>RE1|c~q=h</String></Simple></Simple></Tag></Tags>',
	);
	writeFileSync(join(dir, "chapters.txt"), "CHAPTER01=00:00:00.000\nCHAPTER01NAME=Intro\n");
	writeFileSync(join(dir, "font.ttf"), "not really a font");
	const mkv = join(dir, `${name}.mkv`);
	sh([
		"mkvmerge",
		"-q",
		"-o",
		mkv,
		"--global-tags",
		join(dir, "tags.xml"),
		"--chapters",
		join(dir, "chapters.txt"),
		"--attachment-mime-type",
		"font/ttf",
		"--attach-file",
		join(dir, "font.ttf"),
		"--language",
		"0:jpn",
		"--track-name",
		"0:Main video",
		base,
		"--language",
		"0:slv",
		join(dir, "s.srt"),
	]);
	return mkv;
}

function job(plan: GrainPlan): Job {
	return {
		id: Math.random().toString(16).slice(2, 10),
		kind: "grain",
		filename: "Grain",
		inputPath: plan.targetPath,
		relativePath: "",
		status: "queued",
		progress: 0,
		queueOrder: 1,
		currentStage: "",
		steps: [],
		settings: {} as Job["settings"],
		replaceSource: false,
		grainPlan: plan,
	};
}

async function runPlan(dir: string, plan: GrainPlan): Promise<Job> {
	const target = job(plan);
	await runGrainJob(target, { tempDir: join(dir, "temp") } as AppConfig, (partial) => Object.assign(target, partial));
	return target;
}

/** The decoded picture without the grain the player adds, which a grain change must leave as it is. */
const picture = (path: string) =>
	sh(["ffmpeg", "-v", "error", "-c:v", "libdav1d", "-export_side_data", "film_grain", "-i", path, "-map", "0:v", "-f", "md5", "-"]);
const timestamps = (path: string, dir: string) => {
	const out = join(dir, "ts-check.txt");
	sh(["mkvextract", "-q", path, "timestamps_v2", `0:${out}`]);
	return Bun.file(out).text();
};
const describeTracks = (identified: any) => identified.tracks.map((t: any) => [t.type, t.codec, t.properties.language, t.properties.track_name ?? null]);

describe.skipIf(!tools)("Film grain jobs on an MKV", () => {
	test("add synthetic grain and remove it again, keeping the picture and every other track", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rabbit-grain-job-"));
		try {
			const mkv = makeMkv(dir, "episode");
			const before = { picture: picture(mkv), timestamps: await timestamps(mkv, dir), identify: JSON.parse(sh(["mkvmerge", "-J", mkv])) };
			const clean = await inspectGrainFile(mkv, join(dir, "temp"));
			expect(clean).toMatchObject({ editable: true, codec: "AV1", frames: 48, entries: 0, luma: null });

			const added = await runPlan(dir, sanitizeGrainPlan({ targetPath: mkv, action: "synthetic", strength: 4, size: "medium" }));
			expect(added.error).toBeUndefined();
			expect(added.status).toBe("done");
			const stages: string[] = [];
			const grained = await inspectGrainFile(mkv, join(dir, "temp"), undefined, (progress) => stages.push(progress.stage));
			expect([...new Set(stages)]).toEqual(["video", "table", "measure"]);
			expect(grained.entries).toBe(1);
			expect(grained.luma).toBeGreaterThan(3);
			expect(grained.luma).toBeLessThan(5);

			const after = JSON.parse(sh(["mkvmerge", "-J", mkv]));
			expect(describeTracks(after)).toEqual(describeTracks(before.identify));
			expect(after.attachments).toHaveLength(1);
			expect(after.chapters[0].num_entries).toBe(1);
			expect(sh(["mkvextract", mkv, "tags", "-"])).toContain("RE1|c~q=h");
			expect(after.tracks[0].properties.default_duration).toBe(before.identify.tracks[0].properties.default_duration);
			expect(await timestamps(mkv, dir)).toBe(before.timestamps);
			expect(picture(mkv)).toBe(before.picture);
			expect(readdirSync(dir).some((name) => name.startsWith(".rabbit-grain-"))).toBe(false);

			const removed = await runPlan(dir, sanitizeGrainPlan({ targetPath: mkv, action: "remove" }));
			expect(removed.error).toBeUndefined();
			expect((await inspectGrainFile(mkv, join(dir, "temp"))).entries).toBe(0);
			expect(picture(mkv)).toBe(before.picture);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 180_000);

	test("add ISO grain for the video's frame size", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rabbit-grain-iso-"));
		try {
			const mkv = makeMkv(dir, "episode");
			const before = picture(mkv);
			const done = await runPlan(dir, sanitizeGrainPlan({ targetPath: mkv, action: "synthetic", iso: 25600, size: "fine" }));
			expect(done.error).toBeUndefined();
			// The 192x128 test video has the frame of a 228x128 picture, whose pixels are large and noise weak.
			const expected = join(dir, "expected.tbl");
			sh(["regrain", "-q", "generate", "-o", expected, "-y", "--iso", "25600", "--resolution", "228x128", "--size", "fine"]);
			const stats = JSON.parse(sh(["regrain", "--progress", "json", "stats", expected]).trim().split("\n").pop()!);
			expect((await inspectGrainFile(mkv, join(dir, "temp"))).luma).toBe(Math.round(stats.luma * 100) / 100);
			expect(picture(mkv)).toBe(before);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 180_000);

	test("apply another video's table, and skip files a batch does not fit", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rabbit-grain-table-"));
		try {
			const donor = makeMkv(dir, "donor");
			expect((await runPlan(dir, sanitizeGrainPlan({ targetPath: donor, action: "synthetic", strength: 6, size: "coarse" }))).status).toBe("done");
			const table = join(dir, "donor.tbl");
			expect((await exportFilmGrainTable(donor, table)).entries).toBe(1);

			const target = makeMkv(dir, "target");
			const original = picture(target);
			const refused = await runPlan(dir, sanitizeGrainPlan({ targetPath: target, action: "remove" }));
			expect(refused.status).toBe("error");
			expect(refused.error).toContain("no film grain");
			const skipped = await runPlan(dir, sanitizeGrainPlan({ targetPath: target, action: "remove", batch: true }));
			expect(skipped.status).toBe("done");
			expect(skipped.currentStage).toBe("Skipped: has no film grain");

			const applied = await runPlan(dir, sanitizeGrainPlan({ targetPath: target, action: "table", tablePath: table, staticGrain: true }));
			expect(applied.error).toBeUndefined();
			const inspection = await inspectGrainFile(target, join(dir, "temp"));
			expect(inspection.luma).toBe((await inspectGrainFile(donor, join(dir, "temp"))).luma);
			expect(picture(target)).toBe(original);

			const kept = await runPlan(dir, sanitizeGrainPlan({ targetPath: target, action: "synthetic", strength: 2, batch: true, skipExisting: true }));
			expect(kept.currentStage).toBe("Skipped: already has film grain");
			expect((await inspectGrainFile(target, join(dir, "temp"))).luma).toBe(inspection.luma);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 180_000);

	// regrain 0.3.0 reads comments above the header and corrects what --fix can, which older versions refuse.
	const regrainVersion = tools
		? (Bun.spawnSync(["regrain", "--version"])
				.stdout.toString()
				.match(/(\d+)\.(\d+)\.(\d+)/)
				?.slice(1)
				.map(Number) ?? [])
		: [];
	const checkFixes = (regrainVersion[0] ?? 0) > 0 || (regrainVersion[1] ?? 0) >= 3;

	test.skipIf(!checkFixes)("correct a table with problems regrain can fix", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rabbit-grain-check-"));
		try {
			const table = join(dir, "hand.tbl");
			writeFileSync(
				table,
				"# made by hand\nfilmgrn1\nE 0 18446744073709551615 1 7391 1\n  p 3 8 0 11 0 1 128 192 256 128 192 256\n  sY 4 64 227 16 136 192 227 235 159\n  sCb 0\n  sCr 0\n  cY 0 0 0 0 0 0 0 0 -1 -2 -4 -3 -1 0 0 -3 11 62 29 5 1 0 -1 71\n  cCb 0 0 0 0 0 0 0 0 -1 -2 -4 -3 -1 0 0 -3 11 62 29 5 1 0 -1 71 0\n  cCr 0 0 0 0 0 0 0 0 -1 -2 -4 -3 -1 0 0 -3 11 62 29 5 1 0 -1 71 0\n",
			);
			const plain = await checkFilmGrainTable(table);
			expect(plain).toMatchObject({ errors: 1, warnings: 1, fixable: 2, fixed: false });
			expect(plain.findings.map((finding) => finding.code).sort()).toEqual(["points_out_of_order", "preamble"]);
			const fixedPath = join(dir, "fixed.tbl");
			expect(await checkFilmGrainTable(table, undefined, fixedPath)).toMatchObject({ errors: 1, warnings: 0, fixed: true });
			expect(await checkFilmGrainTable(fixedPath)).toMatchObject({ errors: 0, warnings: 0, findings: [] });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	const diffScales = tools && Bun.spawnSync(["regrain", "diff", "--help"]).stdout.toString().includes("--scale");

	test.skipIf(!diffScales)(
		"measure the grain a cropped and downscaled encode lost, and keep the encode's picture",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "rabbit-grain-measure-"));
			try {
				// A grainy original with black bars, cut to the picture and downscaled as Rabbit encodes it.
				const original = join(dir, "original.mkv");
				const clean = "testsrc2=size=384x192:rate=24000/1001:duration=4,format=yuv420p10le";
				sh(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", `${clean},noise=c0s=10:c0f=t,pad=384:256:0:32:black`, "-c:v", "ffv1", original]);
				const base = join(dir, "encode-base.mkv");
				sh([
					"ffmpeg",
					"-v",
					"error",
					"-y",
					"-i",
					original,
					"-vf",
					"crop=384:192:0:32,scale=-2:96:flags=lanczos",
					"-c:v",
					"libsvtav1",
					"-preset",
					"10",
					"-crf",
					"30",
					base,
				]);
				const encode = join(dir, "encode.mkv");
				sh(["mkvmerge", "-q", "-o", encode, "--track-name", "0:Main video", base]);
				const before = picture(encode);

				const done = await runPlan(dir, sanitizeGrainPlan({ targetPath: encode, action: "measure", sourcePath: original, range: "full" }));
				expect(done.error).toBeUndefined();
				expect(done.steps.map((step) => step.label)).toEqual(["Analyze", "Measure", "Write", "Replace"]);
				expect(done.steps[1]!.detail).toContain("cropped to 384x192, scaled to 192x96");
				const grained = await inspectGrainFile(encode, join(dir, "temp"));
				expect(grained.entries).toBeGreaterThan(0);
				// Only luma grain unless chroma is asked for.
				expect(grained.chroma).toBe(0);

				// The grain the encode lost is the noise, downscaled: about what measuring against the clean picture gives.
				const truthTable = join(dir, "truth.tbl");
				const noisy = join(dir, "noisy-scaled.mkv");
				const cleanScaled = join(dir, "clean-scaled.mkv");
				sh(["ffmpeg", "-v", "error", "-y", "-i", original, "-vf", "crop=384:192:0:32,scale=192:96:flags=lanczos", "-c:v", "ffv1", noisy]);
				sh(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", `${clean},scale=192:96:flags=lanczos`, "-c:v", "ffv1", cleanScaled]);
				sh(["regrain", "-q", "diff", noisy, cleanScaled, "-o", truthTable, "-y"]);
				const truth = JSON.parse(sh(["regrain", "--progress", "json", "stats", truthTable]).trim().split("\n").pop()!).luma as number;
				expect(Math.abs(grained.luma! - truth)).toBeLessThan(truth * 0.15);
				expect(picture(encode)).toBe(before);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		180_000,
	);

	test.skipIf(!diffScales)(
		"measure against an encode that already has grain without counting its own grain",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "rabbit-grain-remeasure-"));
			try {
				const original = join(dir, "original.mkv");
				sh([
					"ffmpeg",
					"-v",
					"error",
					"-y",
					"-f",
					"lavfi",
					"-i",
					"testsrc2=size=192x128:rate=24000/1001:duration=2,format=yuv420p10le,noise=c0s=6:c0f=t",
					"-c:v",
					"ffv1",
					original,
				]);
				const encode = makeMkv(dir, "episode");
				// Strong grain first, which a measurement that decoded it would mistake for grain the encode lost.
				expect((await runPlan(dir, sanitizeGrainPlan({ targetPath: encode, action: "synthetic", strength: 20 }))).status).toBe("done");
				const done = await runPlan(dir, sanitizeGrainPlan({ targetPath: encode, action: "measure", sourcePath: original, range: "full" }));
				expect(done.error).toBeUndefined();
				const inspection = await inspectGrainFile(encode, join(dir, "temp"));
				// Measured against its clean source, the original's noise is 3.1 on this scale. Counting the encode's own grain would give about 20.
				expect(inspection.luma).toBeGreaterThan(1);
				expect(inspection.luma).toBeLessThan(4);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		180_000,
	);
});
