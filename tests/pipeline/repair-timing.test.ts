import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getDefaultJobSettings } from "../../src/core/config";
import type { AppConfig, Job, RepairSubtitleTrackPlan } from "../../src/core/types";
import { buildRepairMkvmergeArgs, identifyMatroska, runRepairJob, sanitizeRepairPlan } from "../../src/pipeline/repair";
import {
	alignmentProblem,
	describeTiming,
	isIdentityTiming,
	mkvmergeSync,
	retimeSubtitleText,
	retimingFailed,
	retimingFits,
	snapOffsetsToFrames,
	sourceTimingFor,
} from "../../src/pipeline/repair-timing";
import { dialogueCues, type TimeMap } from "../../src/subsearch/cues";
import { assTime, command, extractSubtitle, hasReleaseTools, makeAvMkv, RATE, speechLike, srtTime, writeWav } from "./release-fixtures";

const cutMap: TimeMap = {
	scale: 1,
	pieces: [
		{ fromMs: 0, offsetMs: -5000 },
		{ fromMs: 80_000, offsetMs: -20_000 },
	],
};
const cutRemoved = [{ startMs: 65_000, endMs: 80_000 }];

describe("source timing", () => {
	it("accepts a source whose audio matches", () => {
		expect(alignmentProblem({ confidence: 0.9, coveredShare: 0.95 })).toBeNull();
		expect(alignmentProblem({ confidence: 0.9, coveredShare: 0.3 })).toContain("30% matched");
		expect(alignmentProblem({ confidence: 0.2, coveredShare: 0.9 })).toContain("another episode or cut");
	});

	it("needs no retiming for a source that already lines up", () => {
		expect(isIdentityTiming({ scale: 1, pieces: [{ fromMs: 0, offsetMs: 0 }] }, [])).toBe(true);
		expect(isIdentityTiming({ scale: 1, pieces: [{ fromMs: 0, offsetMs: 40 }] }, [])).toBe(false);
		expect(isIdentityTiming(cutMap, cutRemoved)).toBe(false);
		const probe = { videoStreamFps: 24000 / 1001, isFrameRateMismatch: false };
		expect(sourceTimingFor({ map: { scale: 1, pieces: [{ fromMs: 0, offsetMs: 0 }] }, removed: [] }, 1_000_000, probe)).toBeNull();
	});

	it("rounds offsets to whole frames of the encode when its frame rate is constant", () => {
		const alignment = {
			map: {
				scale: 1,
				pieces: [
					{ fromMs: 0, offsetMs: -5010 },
					{ fromMs: 80_000, offsetMs: -19_990 },
				],
			},
			removed: cutRemoved,
		};
		// 120 and 480 frames of 25 fps.
		expect(sourceTimingFor(alignment, 120_000, { videoStreamFps: 25, isFrameRateMismatch: false })).toEqual({
			map: {
				scale: 1,
				pieces: [
					{ fromMs: 0, offsetMs: -5000 },
					{ fromMs: 80_000, offsetMs: -20_000 },
				],
			},
			removed: cutRemoved,
			endMs: 120_000,
		});
		expect(sourceTimingFor(alignment, 120_000, { videoStreamFps: 25, isFrameRateMismatch: true })?.map).toEqual(alignment.map);
		expect(snapOffsetsToFrames({ scale: 1, pieces: [{ fromMs: 0, offsetMs: 2550 }] }, 24000 / 1001).pieces[0]!.offsetMs).toBe(2544);
	});

	it("needs no retiming when the offset rounds to no frames", () => {
		const probe = { videoStreamFps: 24000 / 1001, isFrameRateMismatch: false };
		expect(sourceTimingFor({ map: { scale: 1, pieces: [{ fromMs: 0, offsetMs: 10 }] }, removed: [] }, 1_000_000, probe)).toBeNull();
	});

	it("gives mkvmerge a sync only for a map without cuts", () => {
		expect(mkvmergeSync({ scale: 25 / 23.976, pieces: [{ fromMs: 0, offsetMs: -1200 }] })).toEqual({ delayMs: -1200, scale: 25 / 23.976 });
		expect(mkvmergeSync(cutMap)).toBeNull();
	});

	it("retimes an extracted SRT with a byte order mark", () => {
		const srt = "\uFEFF1\n00:00:10,000 --> 00:00:11,000\nBefore\n\n2\n00:01:10,000 --> 00:01:11,000\nCut\n\n3\n00:01:30,000 --> 00:01:31,000\nAfter\n";
		const out = retimeSubtitleText(srt, "srt", { map: cutMap, removed: cutRemoved, endMs: 120_000 });
		expect(dialogueCues({ format: "srt", content: out })).toEqual([
			{ startMs: 5000, endMs: 6000, text: "Before" },
			{ startMs: 70_000, endMs: 71_000, text: "After" },
		]);
	});

	it("does not judge a track with too few lines", async () => {
		let asked = false;
		const srt = "1\n00:00:01,000 --> 00:00:02,000\nHi\n";
		const fits = await retimingFits(srt, srt, "srt", async () => ((asked = true), null), 60_000);
		expect(fits).toBeNull();
		expect(asked).toBe(false);
	});

	it("measures the fit before and after retiming", async () => {
		const reference = Array.from({ length: 30 }, (_, i) => ({ startMs: 10_000 + i * 4000, endMs: 11_500 + i * 4000 }));
		const srt = (shift: number) =>
			reference.map((c, i) => `${i + 1}\n${srtTime(c.startMs + shift)} --> ${srtTime(c.endMs + shift)}\nLine ${i + 1}\n`).join("\n");
		const fits = await retimingFits(srt(5000), srt(0), "srt", async () => ({ intervals: reference, kind: "subtitle" }), 200_000);
		expect(fits!.after).toBeGreaterThan(0.9);
		expect(fits!.before).toBeLessThan(fits!.after);
	});

	it("leaves out a retimed track only when it fits badly and worse than before", () => {
		expect(retimingFailed(null)).toBe(false);
		expect(retimingFailed({ before: 0, after: 0 })).toBe(false);
		expect(retimingFailed({ before: 0.2, after: 0.95 })).toBe(false);
		expect(retimingFailed({ before: 0.9, after: 0.1 })).toBe(true);
		expect(retimingFailed({ before: 0.3, after: 0.6 })).toBe(false);
	});

	it("describes the timing", () => {
		expect(describeTiming(cutMap, cutRemoved)).toBe("-5.00 s, 2 parts, 15.0 s of the source left out");
	});
});

const track = (source: "target" | "source", trackId: number, order: number): RepairSubtitleTrackPlan => ({
	source,
	trackId,
	mode: "copy",
	order,
	title: `Track ${trackId}`,
	language: "eng",
	compression: "none",
	isDefault: false,
	isForced: false,
	isEnabled: true,
	isHearingImpaired: false,
	isOriginal: false,
	isCommentary: false,
});

describe("repair plans with another release", () => {
	it("keeps alignSource only with a source", () => {
		const base = { targetPath: "/media/encoded.mkv", replaceTarget: false, alignSource: true, tracks: [track("target", 2, 0)] };
		expect(sanitizeRepairPlan(base).alignSource).toBeUndefined();
		expect(sanitizeRepairPlan({ ...base, sourcePath: "/media/other.mkv" }).alignSource).toBe(true);
		expect("alignSource" in sanitizeRepairPlan({ ...base, alignSource: false, sourcePath: "/media/other.mkv" })).toBe(false);
	});

	const target = {
		tracks: [
			{ id: 0, type: "video", codec: "AV1", properties: { codec_id: "V_AV1" } },
			{ id: 1, type: "audio", codec: "Opus", properties: { codec_id: "A_OPUS" } },
			{ id: 2, type: "subtitles", codec: "SubRip/SRT", properties: { codec_id: "S_TEXT/UTF8" } },
		],
	};
	const source = {
		tracks: [
			{ id: 3, type: "subtitles", codec: "SubStationAlpha", properties: { codec_id: "S_TEXT/ASS" } },
			{ id: 4, type: "subtitles", codec: "HDMV PGS", properties: { codec_id: "S_HDMV/PGS" } },
		],
	};

	it("muxes a retimed copy from its file and syncs the tracks copied as they are", () => {
		const plan = sanitizeRepairPlan({
			targetPath: "/media/encoded.mkv",
			sourcePath: "/media/other.mkv",
			replaceTarget: false,
			alignSource: true,
			tracks: [track("target", 2, 0), track("source", 3, 1), track("source", 4, 2)],
		});
		const prepared = [{ plan: plan.tracks[1]!, path: "/tmp/source_3.retimed.ass" }];
		const args = buildRepairMkvmergeArgs({
			outputPath: "/tmp/out.mkv",
			plan,
			target,
			source,
			prepared,
			sourceSyncs: [{ delayMs: -1200, scale: 1 }],
		});
		expect(args[args.indexOf("--track-order") + 1]).toBe("0:0,0:1,0:2,2:0,1:4");
		const sourceInput = args.indexOf("/media/other.mkv");
		const sourceArgs = args.slice(args.indexOf("--no-video"), sourceInput);
		expect(sourceArgs[sourceArgs.indexOf("--subtitle-tracks") + 1]).toBe("4");
		expect(sourceArgs).toContain("4:-1200,1");
		expect(args.slice(sourceInput)).toContain("/tmp/source_3.retimed.ass");
		expect(args.filter((arg) => arg === "--sync")).toHaveLength(1);
	});

	it("adds no sync without timing", () => {
		const plan = sanitizeRepairPlan({
			targetPath: "/media/encoded.mkv",
			sourcePath: "/media/other.mkv",
			replaceTarget: false,
			tracks: [track("target", 2, 0), track("source", 4, 1)],
		});
		expect(buildRepairMkvmergeArgs({ outputPath: "/tmp/out.mkv", plan, target, source, prepared: [] })).not.toContain("--sync");
	});
});

(hasReleaseTools ? describe : describe.skip)("repairing with another release", () => {
	const root = mkdtempSync(join(tmpdir(), "rabbit-release-repair-"));
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	// Target times of the dialogue, every 3.5 s, none across the 60 s point where the source has an extra scene.
	const lines = Array.from({ length: 33 }, (_, i) => 2000 + i * 3500).filter((t) => t + 1500 <= 58_000 || t >= 61_000);
	const toSource = (t: number) => (t < 60_000 ? t + 5000 : t + 20_000);

	async function makeFiles(sourceAudio: Int16Array[]): Promise<{ targetPath: string; sourcePath: string }> {
		const dir = mkdtempSync(join(root, "case-"));
		const speech = speechLike(120, 1);
		writeWav(join(dir, "target.wav"), speech);
		writeWav(join(dir, "source.wav"), ...sourceAudio);
		const sourceSeconds = sourceAudio.reduce((n, p) => n + p.length, 0) / RATE;
		await makeAvMkv(join(dir, "target-av.mkv"), join(dir, "target.wav"), 120);
		await makeAvMkv(join(dir, "source-av.mkv"), join(dir, "source.wav"), sourceSeconds);

		writeFileSync(join(dir, "eng.srt"), lines.map((t, i) => `${i + 1}\n${srtTime(t)} --> ${srtTime(t + 1500)}\nLine ${i + 1}\n`).join("\n"));
		const ger = [...lines.map((t, i) => [toSource(t), `Zeile ${i + 1}`] as const), [70_000, "Geschnitten"] as const].sort((a, b) => a[0] - b[0]);
		writeFileSync(join(dir, "ger.srt"), ger.map(([t, text], i) => `${i + 1}\n${srtTime(t)} --> ${srtTime(t + 1500)}\n${text}\n`).join("\n"));
		const fre =
			"[Script Info]\nScriptType: v4.00+\nPlayResX: 640\nPlayResY: 360\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n" +
			"Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" +
			lines.map((t, i) => `Dialogue: 0,${assTime(toSource(t))},${assTime(toSource(t) + 1500)},Default,,0,0,0,,Ligne ${i + 1}\n`).join("") +
			`Dialogue: 0,${assTime(85_000)},${assTime(87_000)},Default,,0,0,0,,{\\pos(320,40)}Panneau\n`;
		writeFileSync(join(dir, "fre.ass"), fre);

		const targetPath = join(dir, "Target.mkv");
		const sourcePath = join(dir, "Source.mkv");
		await command(["mkvmerge", "-q", "-o", targetPath, join(dir, "target-av.mkv"), "--language", "0:eng", join(dir, "eng.srt")]);
		await command([
			"mkvmerge",
			"-q",
			"-o",
			sourcePath,
			join(dir, "source-av.mkv"),
			"--language",
			"0:ger",
			join(dir, "ger.srt"),
			"--language",
			"0:fre",
			join(dir, "fre.ass"),
		]);
		return { targetPath, sourcePath };
	}

	async function repair(targetPath: string, sourcePath: string): Promise<Job> {
		const [target, source] = await Promise.all([identifyMatroska(targetPath), identifyMatroska(sourcePath)]);
		const sub = (info: typeof target, n: number) => (info.tracks ?? []).filter((t) => t.type === "subtitles")[n]!.id;
		const plan = sanitizeRepairPlan({
			targetPath,
			sourcePath,
			replaceTarget: false,
			alignSource: true,
			tracks: [
				{ ...track("target", sub(target, 0), 0), title: "English" },
				{ ...track("source", sub(source, 0), 1), language: "de", title: "German" },
				{ ...track("source", sub(source, 1), 2), language: "fr", title: "French" },
			],
		});
		const id = `release-${Math.random().toString(36).slice(2, 8)}`;
		const job = {
			id,
			kind: "repair",
			inputPath: targetPath,
			settings: getDefaultJobSettings(),
			repairPlan: plan,
			status: "queued",
			steps: [],
		} as unknown as Job;
		const config = { tempDir: join(root, "tmp") } as AppConfig;
		mkdirSync(config.tempDir, { recursive: true });
		await runRepairJob(job, config, (partial) => Object.assign(job, partial));
		return job;
	}

	const extractSub = (path: string, n: number, extension: string) => extractSubtitle(path, n, extension, root);

	it("retimes the source's tracks through its extra start and a scene the encode cut", async () => {
		const { targetPath, sourcePath } = await makeFiles([
			speechLike(5, 2),
			speechLike(120, 1).slice(0, 60 * RATE),
			speechLike(15, 3),
			speechLike(120, 1).slice(60 * RATE),
		]);
		const job = await repair(targetPath, sourcePath);
		expect(job.error).toBeUndefined();
		expect(job.status).toBe("done");
		expect(job.steps.map((s) => s.label)).toEqual(["Inspect files", "Align timing", "Prepare subtitles", "Stream-copy remux"]);
		expect(job.steps[1]!.detail).toContain("2 parts");

		const output = job.outputFilename!;
		const german = dialogueCues({ format: "srt", content: await extractSub(output, 1, ".srt") });
		expect(german.map((c) => c.text)).not.toContain("Geschnitten");
		expect(german.map((c) => c.startMs)).toEqual(lines);
		const french = await extractSub(output, 2, ".ass");
		const frenchLines = dialogueCues({ format: "ass", content: french }).filter((c) => c.text !== "Panneau");
		expect(frenchLines.map((c) => c.startMs)).toEqual(lines);
		expect(french).toContain(`${assTime(65_000)},${assTime(67_000)},Default,,0,0,0,,{\\pos(320,40)}Panneau`);
	}, 120_000);

	it("refuses a source whose audio belongs to another video", async () => {
		const { targetPath, sourcePath } = await makeFiles([speechLike(120, 9)]);
		const job = await repair(targetPath, sourcePath);
		expect(job.status).toBe("error");
		expect(job.error).toContain("does not match the encode");
	}, 120_000);
});
