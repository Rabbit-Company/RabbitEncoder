import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig, HdrPlan, Job } from "../../src/core/types";
import { describeHdrPlan, hdrWriteSteps, inspectHdrFile, runHdrJob, sanitizeHdrPlan } from "../../src/pipeline/hdr-tool";
import { videoTrackOptions } from "../../src/pipeline/av1-mkv";

describe("HDR plans", () => {
	test("need a change, and a source for what they import", () => {
		expect(() => sanitizeHdrPlan({ targetPath: "a.mkv" })).toThrow("at least one change");
		expect(() => sanitizeHdrPlan({ targetPath: "a.mkv", hdr10Plus: "dolby-vision" })).toThrow("Dolby Vision original");
		expect(() => sanitizeHdrPlan({ targetPath: "a.mkv", hdr10Plus: "file" })).toThrow("JSON");
		expect(() => sanitizeHdrPlan({ targetPath: "a.mkv", hdr10Plus: "measure", batch: true, skipExisting: true })).not.toThrow();
		expect(() => sanitizeHdrPlan({ targetPath: "a.mkv", hdr10Plus: "file", sourcePath: "b.mkv", batch: true })).toThrow("folder");
	});

	test("check the static metadata", () => {
		expect(() => sanitizeHdrPlan({ targetPath: "a.mkv", staticMetadata: "set", masteringMaxNits: 1000, masteringMinNits: 2000 })).toThrow("luminance");
		expect(() =>
			sanitizeHdrPlan({
				targetPath: "a.mkv",
				hdr10Plus: "remove",
				staticMetadata: "set",
				masteringMaxNits: 1000,
				masteringMinNits: 0.005,
				lightFromHdr10Plus: true,
			}),
		).toThrow("removed");
		const plan = sanitizeHdrPlan({
			targetPath: "a.mkv",
			staticMetadata: "set",
			masteringPrimaries: "p3",
			masteringMaxNits: 1000,
			masteringMinNits: 0.0001,
			maxCll: 900,
			maxFall: 200,
		});
		expect(plan).toMatchObject({ masteringPrimaries: "p3", maxCll: 900, maxFall: 200 });
		expect(describeHdrPlan(plan)).toBe("Set HDR10 static metadata");
	});

	test("write in order: remove, static metadata, then HDR10+", () => {
		const plan: HdrPlan = {
			targetPath: "a.mkv",
			hdr10Plus: "measure",
			removeDolbyVision: true,
			staticMetadata: "set",
			masteringPrimaries: "bt2020",
			masteringMaxNits: 4000,
			masteringMinNits: 0.005,
			lightFromHdr10Plus: true,
			fixColor: true,
		};
		const steps = hdrWriteSteps(plan, "in.ivf", "/w", "/w/meta.json", false);
		expect(steps.map((step) => step.args.slice(0, 3))).toEqual([
			["retone", "remove", "in.ivf"],
			["retone", "static", "/w/write-1.ivf"],
			["retone", "apply", "/w/write-2.ivf"],
		]);
		expect(steps[0]!.args).toContain("--keep-hdr10plus");
		expect(steps[1]!.args).toEqual(expect.arrayContaining(["--mastering-display", "bt2020,4000,0.005", "--cll-from", "/w/meta.json", "--fix-color"]));
		// The colour tags are already fixed when HDR10+ is written.
		expect(steps[2]!.args).not.toContain("--fix-color");
		expect(hdrWriteSteps({ ...plan, hdr10Plus: "keep", staticMetadata: "keep", removeDolbyVision: false }, "in.ivf", "/w", null, false)[0]!.args).toContain(
			"--fix-color",
		);
	});

	test("give the new video track the old one's properties", () => {
		const options = videoTrackOptions(
			{ id: 0, type: "video", codec: "AV1", properties: { language_ietf: "ja", track_name: "Main", default_track: true, forced_track: false } },
			"/t.txt",
		);
		expect(options).toEqual([
			"--timestamps",
			"0:/t.txt",
			"--language",
			"0:ja",
			"--track-name",
			"0:Main",
			"--default-track-flag",
			"0:yes",
			"--forced-display-flag",
			"0:no",
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
	["retone", "--version"],
	["ffmpeg", "-version"],
	["mkvmerge", "--version"],
	["mkvextract", "--version"],
	["mkvpropedit", "--version"],
	["mediainfo", "--Version"],
].every((command) => available(command));

/** An MKV as Rabbit writes it: AV1 video with a name, Opus audio, a subtitle, a font, chapters and nested global tags. */
function makeMkv(dir: string, name: string, color: string): string {
	const base = join(dir, `${name}-base.mkv`);
	const filter = `testsrc2=size=192x128:rate=24000/1001:duration=2,format=yuv420p10le,${color}`;
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

function job(plan: HdrPlan): Job {
	return {
		id: Math.random().toString(16).slice(2, 10),
		kind: "hdr",
		filename: "HDR",
		inputPath: plan.targetPath,
		relativePath: "",
		status: "queued",
		progress: 0,
		queueOrder: 1,
		currentStage: "",
		steps: [],
		settings: {} as Job["settings"],
		replaceSource: false,
		hdrPlan: plan,
	};
}

async function runPlan(dir: string, plan: HdrPlan): Promise<Job> {
	const target = job(plan);
	await runHdrJob(target, { tempDir: join(dir, "temp") } as AppConfig, (partial) => Object.assign(target, partial));
	return target;
}

const picture = (path: string) => sh(["ffmpeg", "-v", "error", "-i", path, "-map", "0:v", "-f", "md5", "-"]);
const timestamps = (path: string, dir: string) => {
	const out = join(dir, "ts-check.txt");
	sh(["mkvextract", "-q", path, "timestamps_v2", `0:${out}`]);
	return Bun.file(out).text();
};
const PQ = "setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc";

describe.skipIf(!tools)("HDR jobs on an MKV", () => {
	test("measure HDR10+ and set static metadata, then remove both, keeping every other track", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rabbit-hdr-job-"));
		try {
			const mkv = makeMkv(dir, "episode", PQ);
			const before = { picture: picture(mkv), timestamps: await timestamps(mkv, dir), identify: JSON.parse(sh(["mkvmerge", "-J", mkv])) };
			const plan = sanitizeHdrPlan({
				targetPath: mkv,
				hdr10Plus: "measure",
				staticMetadata: "set",
				masteringPrimaries: "p3",
				masteringMaxNits: 1000,
				masteringMinNits: 0.0001,
				lightFromHdr10Plus: true,
			});
			const done = await runPlan(dir, plan);
			expect(done.error).toBeUndefined();
			expect(done.status).toBe("done");

			const inspection = await inspectHdrFile(mkv);
			expect(inspection.hdr10PlusFrames).toBe(48);
			expect(inspection.formats).toEqual(["HDR10", "HDR10+"]);
			expect(inspection.masteringDisplay).toMatchObject({ primaries: "Display P3", maxNits: 1000 });
			expect(inspection.contentLight?.maxCll).toBe(inspection.hdr10PlusMaxCll!);
			expect(inspection.findings.filter((finding) => finding.severity === "error")).toEqual([]);

			const after = JSON.parse(sh(["mkvmerge", "-J", mkv]));
			const describe = (identified: any) => identified.tracks.map((t: any) => [t.type, t.codec, t.properties.language, t.properties.track_name ?? null]);
			expect(describe(after)).toEqual(describe(before.identify));
			expect(after.attachments).toHaveLength(1);
			expect(after.chapters[0].num_entries).toBe(1);
			expect(sh(["mkvextract", mkv, "tags", "-"])).toContain("RE1|c~q=h");
			expect(after.tracks[0].properties.default_duration).toBe(before.identify.tracks[0].properties.default_duration);
			expect(await timestamps(mkv, dir)).toBe(before.timestamps);
			expect(picture(mkv)).toBe(before.picture);
			const mediainfo = sh(["mediainfo", "--Inform=Video;%MaxCLL%|%MasteringDisplay_Luminance%", mkv]);
			expect(mediainfo).toContain("1000 cd/m2");
			expect(readdirSync(dir).some((name) => name.startsWith(".rabbit-hdr-"))).toBe(false);

			const removed = await runPlan(dir, sanitizeHdrPlan({ targetPath: mkv, hdr10Plus: "remove", staticMetadata: "remove" }));
			expect(removed.status).toBe("done");
			const cleaned = await inspectHdrFile(mkv);
			expect(cleaned.hdr10PlusFrames).toBe(0);
			expect(cleaned.masteringDisplay).toBeNull();
			expect(cleaned.formats).toEqual(["PQ"]);
			expect(picture(mkv)).toBe(before.picture);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 180_000);

	test("tag an untagged video as PQ, but leave SDR alone", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rabbit-hdr-color-"));
		try {
			const untagged = makeMkv(dir, "untagged", "setparams=color_primaries=unknown:color_trc=unknown:colorspace=unknown");
			const tagged = await runPlan(dir, sanitizeHdrPlan({ targetPath: untagged, hdr10Plus: "measure", fixColor: true }));
			expect(tagged.error).toBeUndefined();
			const inspection = await inspectHdrFile(untagged);
			expect(inspection.isPq).toBe(true);
			expect(inspection.hdr10PlusFrames).toBe(48);

			const sdr = makeMkv(dir, "sdr", "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709");
			const original = picture(sdr);
			const refused = await runPlan(dir, sanitizeHdrPlan({ targetPath: sdr, hdr10Plus: "measure", fixColor: true }));
			expect(refused.status).toBe("error");
			expect(refused.error).toContain("not PQ");
			const skipped = await runPlan(dir, sanitizeHdrPlan({ targetPath: sdr, hdr10Plus: "measure", fixColor: true, batch: true }));
			expect(skipped.status).toBe("done");
			expect(skipped.currentStage).toContain("Skipped");
			expect(picture(sdr)).toBe(original);
			expect(existsSync(sdr)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 180_000);
});
