import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getDefaultJobSettings } from "../../src/core/config";
import type { AppConfig, Job, RepairInspectionFile, RepairSubtitleTrack, RepairSubtitleTrackPlan } from "../../src/core/types";
import { buildRepairMkvmergeArgs, inspectRepairFile, repairSources, repairTrackKey, runRepairJob, sanitizeRepairPlan } from "../../src/pipeline/repair";
import { buildReleaseRepairPlan, planReleaseSubtitles, type ReleaseSubsOptions } from "../../src/pipeline/release-subs";
import { dialogueCues } from "../../src/subsearch/cues";
import { command, extractSubtitle, hasReleaseTools, makeAvMkv, RATE, speechLike, srtOf, writeWav } from "./release-fixtures";

const track = (source: "target" | "source", trackId: number, order: number, sourceIndex?: number): RepairSubtitleTrackPlan => ({
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
	...(sourceIndex !== undefined ? { sourceIndex } : {}),
});

const base = { targetPath: "/media/encoded.mkv", sourcePath: "/media/erai.mkv", replaceTarget: false };

describe("repair plans with several sources", () => {
	it("keeps extra sources and which source each track comes from", () => {
		const plan = sanitizeRepairPlan({
			...base,
			alignSource: true,
			extraSources: [{ path: "/media/varyg.mkv", alignSource: true }],
			tracks: [track("source", 3, 0, 0), track("source", 3, 1, 1)],
		});
		expect(repairSources(plan)).toEqual([
			{ path: "/media/erai.mkv", alignSource: true },
			{ path: "/media/varyg.mkv", alignSource: true },
		]);
		expect(plan.tracks.map(repairTrackKey)).toEqual(["source:3", "source1:3"]);
		// Index 0 is left out, so single-source plans stay as they were.
		expect("sourceIndex" in plan.tracks[0]!).toBe(false);
	});

	it("refuses tracks of a source the plan does not have, and the same source twice", () => {
		expect(() => sanitizeRepairPlan({ ...base, tracks: [track("source", 3, 0, 1)] })).toThrow("names a source the plan does not have");
		expect(() => sanitizeRepairPlan({ ...base, extraSources: [{ path: "/media/erai.mkv" }], tracks: [] })).toThrow("chosen twice");
		expect(() => sanitizeRepairPlan({ targetPath: "/media/encoded.mkv", replaceTarget: false, extraSources: [{ path: "/media/x.mkv" }], tracks: [] })).toThrow(
			"need a first source",
		);
		expect(() => sanitizeRepairPlan({ ...base, replaceFromSource: true, extraSources: [{ path: "/media/x.mkv" }], tracks: [] } as any)).toThrow(
			"single source",
		);
	});

	const target = {
		tracks: [
			{ id: 0, type: "video", codec: "AV1", properties: { codec_id: "V_AV1" } },
			{ id: 1, type: "audio", codec: "Opus", properties: { codec_id: "A_OPUS" } },
			{ id: 2, type: "subtitles", codec: "SubStationAlpha", properties: { codec_id: "S_TEXT/ASS" } },
		],
		attachments: [{ id: 1, file_name: "Arial.ttf" }],
	};
	const erai = {
		tracks: [{ id: 3, type: "subtitles", codec: "HDMV PGS", properties: { codec_id: "S_HDMV/PGS" } }],
		attachments: [
			{ id: 1, file_name: "arial.ttf" },
			{ id: 2, file_name: "Trebuchet.ttf" },
		],
	};
	const varyg = {
		tracks: [{ id: 4, type: "subtitles", codec: "HDMV PGS", properties: { codec_id: "S_HDMV/PGS" } }],
		attachments: [{ id: 1, file_name: "trebuchet.ttf" }],
	};
	const other = {
		tracks: [{ id: 5, type: "subtitles", codec: "HDMV PGS", properties: { codec_id: "S_HDMV/PGS" } }],
		attachments: [{ id: 1, file_name: "gandhi.otf" }],
	};

	it("muxes every source as its own input with its own sync, bringing only fonts no earlier input has", () => {
		const plan = sanitizeRepairPlan({
			...base,
			extraSources: [{ path: "/media/varyg.mkv" }, { path: "/media/unused.mkv" }, { path: "/media/other.mkv" }],
			tracks: [track("target", 2, 0), track("source", 4, 1, 1), track("source", 3, 2, 0), track("source", 5, 3, 3)],
		});
		const args = buildRepairMkvmergeArgs({
			outputPath: "/tmp/out.mkv",
			plan,
			target,
			sources: [erai, varyg, { tracks: [] }, other],
			prepared: [],
			sourceSyncs: [{ delayMs: -1000, scale: 1 }, { delayMs: 2500, scale: 1 }, null, null],
		});
		expect(args[args.indexOf("--track-order") + 1]).toBe("0:0,0:1,0:2,2:4,1:3,3:5");
		const inputs = ["/media/erai.mkv", "/media/varyg.mkv", "/media/other.mkv"].map((path) => args.indexOf(path));
		expect(inputs.every((at, i) => at > 0 && (i === 0 || at > inputs[i - 1]!))).toBe(true);
		expect(args).not.toContain("/media/unused.mkv");
		const eraiArgs = args.slice(args.indexOf("/media/encoded.mkv") + 1, inputs[0]);
		const varygArgs = args.slice(inputs[0]! + 1, inputs[1]);
		const otherArgs = args.slice(inputs[1]! + 1, inputs[2]);
		// Erai brings Trebuchet but not the Arial the encode has, VARYG nothing, the third source all it has.
		expect(eraiArgs[eraiArgs.indexOf("--attachments") + 1]).toBe("2");
		expect(varygArgs).toContain("--no-attachments");
		expect(otherArgs).not.toContain("--no-attachments");
		expect(otherArgs).not.toContain("--attachments");
		expect(eraiArgs).toContain("3:-1000,1");
		expect(varygArgs).toContain("4:2500,1");
		expect(otherArgs).not.toContain("--sync");
	});

	it("muxes a prepared track of the second source from its file", () => {
		const plan = sanitizeRepairPlan({ ...base, extraSources: [{ path: "/media/varyg.mkv" }], tracks: [track("target", 2, 0), track("source", 4, 1, 1)] });
		const varygText = { tracks: [{ id: 4, type: "subtitles", codec: "SubStationAlpha", properties: { codec_id: "S_TEXT/ASS" } }], attachments: [] };
		const args = buildRepairMkvmergeArgs({
			outputPath: "/tmp/out.mkv",
			plan,
			target,
			sources: [erai, varygText],
			prepared: [{ plan: plan.tracks[1]!, path: "/tmp/source1_4.retimed.ass" }],
		});
		expect(args[args.indexOf("--track-order") + 1]).toBe("0:0,0:1,0:2,2:0");
		expect(args).not.toContain("/media/erai.mkv");
		expect(args.slice(args.indexOf("/media/varyg.mkv") + 1)).toContain("/tmp/source1_4.retimed.ass");
	});
});

let nextId = 2;
function sub(language: string, title: string, flags: Partial<RepairSubtitleTrack> = {}): RepairSubtitleTrack {
	return {
		id: nextId++,
		codec: "SubStationAlpha",
		codecId: "S_TEXT/ASS",
		language,
		title,
		isDefault: false,
		isForced: false,
		isEnabled: true,
		isHearingImpaired: false,
		isOriginal: false,
		isCommentary: false,
		canRabbitProcess: true,
		currentCompression: "none",
		...flags,
	};
}
const file = (path: string, subtitles: RepairSubtitleTrack[]): RepairInspectionFile => ({
	path,
	filename: path.split("/").pop()!,
	durationSeconds: 1420,
	subtitles,
});
const options: ReleaseSubsOptions = { preferredSources: ["CR", "NF"], formatPriority: "text-first", renameTracks: true, languagePriority: ["eng", "jpn", "*"] };
const bridge = { replaceTarget: false, languagePriority: ["eng", "jpn", "*"], formatPriority: "text-first" as const, compression: "none" as const };

describe("buildReleaseRepairPlan", () => {
	const target = file("/enc/Show - S01E01.mkv", [
		sub("en", "Full Subtitles [YURASUKA]", { isDefault: true }),
		sub("en", "Signs & Songs [YURASUKA]", { isForced: true }),
	]);
	const erai = file("/erai/[Erai-raws] Show - 01 [1080p CR WEB-DL].mkv", [sub("en", "English"), sub("de", "Deutsch")]);
	const varyg = file("/varyg/Show.S01E01.1080p.NF.WEB-DL-VARYG.mkv", [sub("it", "Italian"), sub("de", "German")]);

	it("adds each language from its release, after the encode's own tracks in language order", () => {
		const plan = buildReleaseRepairPlan(target, planReleaseSubtitles(target, [varyg, erai], options), bridge)!;
		expect(repairSources(plan)).toEqual([
			{ path: erai.path, alignSource: true },
			{ path: varyg.path, alignSource: true },
		]);
		expect(plan.tracks.map((t) => [repairTrackKey(t), t.title, t.isDefault])).toEqual([
			[`target:${target.subtitles[0]!.id}`, "Full Subtitles [YURASUKA]", true],
			[`target:${target.subtitles[1]!.id}`, "Signs & Songs [YURASUKA]", false],
			[`source:${erai.subtitles[1]!.id}`, "Full Subtitles [CR]", true],
			[`source1:${varyg.subtitles[0]!.id}`, "Full Subtitles [NF]", true],
		]);
	});

	it("puts a replacement where the replaced track was and moves the default to it", () => {
		const plan = buildReleaseRepairPlan(target, planReleaseSubtitles(target, [erai], { ...options, replaceWorse: true }), bridge)!;
		expect(plan.tracks.map((t) => [t.source, t.title, t.isDefault])).toEqual([
			["source", "Full Subtitles [CR]", true],
			["target", "Signs & Songs [YURASUKA]", false],
			["source", "Full Subtitles [CR]", true],
		]);
		expect(plan.tracks.map((t) => t.language)).toEqual(["en", "en", "de"]);
	});

	it("has nothing to do when the target lacks nothing", () => {
		expect(buildReleaseRepairPlan(erai, planReleaseSubtitles(erai, [file("/x/[Erai-raws] x.mkv", [sub("de", "Deutsch")])], options), bridge)).toBeNull();
	});
});

(hasReleaseTools ? describe : describe.skip)("repairing with several releases", () => {
	const root = mkdtempSync(join(tmpdir(), "rabbit-release-sources-"));
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	const lines = Array.from({ length: 33 }, (_, i) => 2000 + i * 3500).filter((t) => t + 1500 <= 58_000 || t >= 61_000);
	// Erai has 5 s more at the start and a 15 s scene the encode cut at 60 s. VARYG starts 3 s later.
	const toErai = (t: number) => (t < 60_000 ? t + 5000 : t + 20_000);
	const toVaryg = (t: number) => t + 3000;

	async function makeFiles(varygAudio: Int16Array[]) {
		const dir = mkdtempSync(join(root, "case-"));
		const speech = speechLike(120, 1);
		const parts = {
			target: [speech],
			erai: [speechLike(5, 2), speech.slice(0, 60 * RATE), speechLike(15, 3), speech.slice(60 * RATE)],
			varyg: varygAudio.length ? varygAudio : [speechLike(3, 4), speech],
		};
		const names = {
			target: "Show - S01E01 [AV1]-Rabbit.mkv",
			erai: "[Erai-raws] Show - 01 [1080p CR WEB-DL AVC AAC][MultiSub].mkv",
			varyg: "Show.S01E01.1080p.NF.WEB-DL.DDP2.0.H.264-VARYG.mkv",
		};
		const subs = {
			target: [["eng", srtOf(lines.map((t, i) => [t, `Line ${i + 1}`] as const))]],
			erai: [
				["eng", srtOf(lines.map((t, i) => [toErai(t), `Line ${i + 1}`] as const))],
				["ger", srtOf(lines.map((t, i) => [toErai(t), `Zeile ${i + 1}`] as const))],
			],
			varyg: [["ita", srtOf(lines.map((t, i) => [toVaryg(t), `Riga ${i + 1}`] as const))]],
		};
		const paths: Record<string, string> = {};
		for (const key of ["target", "erai", "varyg"] as const) {
			const seconds = parts[key].reduce((n, p) => n + p.length, 0) / RATE;
			writeWav(join(dir, `${key}.wav`), ...parts[key]);
			await makeAvMkv(join(dir, `${key}-av.mkv`), join(dir, `${key}.wav`), seconds);
			const args = ["mkvmerge", "-q", "-o", (paths[key] = join(dir, names[key])), join(dir, `${key}-av.mkv`)];
			for (const [i, [language, text]] of subs[key].entries()) {
				writeFileSync(join(dir, `${key}-${i}.srt`), text!);
				args.push("--language", `0:${language}`, join(dir, `${key}-${i}.srt`));
			}
			await command(args);
		}
		return paths as { target: string; erai: string; varyg: string };
	}

	async function repair(paths: { target: string; erai: string; varyg: string }): Promise<Job> {
		const [target, erai, varyg] = await Promise.all([paths.target, paths.erai, paths.varyg].map((p) => inspectRepairFile(p)));
		const plan = buildReleaseRepairPlan(target!, planReleaseSubtitles(target!, [erai!, varyg!], options), bridge)!;
		const job = {
			id: `sources-${Math.random().toString(36).slice(2, 8)}`,
			kind: "repair",
			inputPath: paths.target,
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

	it("takes German from one release and Italian from another, each retimed by its own audio", async () => {
		const job = await repair(await makeFiles([]));
		expect(job.error).toBeUndefined();
		expect(job.status).toBe("done");
		expect(job.steps[1]!.detail).toContain("[Erai-raws]");
		expect(job.steps[1]!.detail).toContain("VARYG");
		const output = job.outputFilename!;
		const german = dialogueCues({ format: "srt", content: await extractSubtitle(output, 1, ".srt", root) });
		const italian = dialogueCues({ format: "srt", content: await extractSubtitle(output, 2, ".srt", root) });
		expect(german[0]!.text).toBe("Zeile 1");
		expect(german.map((c) => c.startMs)).toEqual(lines);
		expect(italian[0]!.text).toBe("Riga 1");
		expect(italian.map((c) => c.startMs)).toEqual(lines);
	}, 120_000);

	it("leaves out a release whose audio belongs to another video and still takes the rest", async () => {
		const job = await repair(await makeFiles([speechLike(120, 9)]));
		expect(job.error).toBeUndefined();
		expect(job.status).toBe("done");
		expect(job.warning).toContain("VARYG");
		expect(job.warning).toContain("does not match the encode");
		const german = dialogueCues({ format: "srt", content: await extractSubtitle(job.outputFilename!, 1, ".srt", root) });
		expect(german.map((c) => c.startMs)).toEqual(lines);
	}, 120_000);
});
