import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getDefaultJobSettings } from "../../src/core/config";
import { run } from "../../src/core/process";
import type { AppConfig, Job, RepairAuditTrack } from "../../src/core/types";
import type { Interval } from "../../src/subsearch/cues";
import { buildRepairRetimePlans, identifyMatroska, inspectRepairAuditFile, runRepairJob, sanitizeRepairPlan } from "../../src/pipeline/repair";
import { followCandidates, judgeDialogueTiming, judgeFileTiming } from "../../src/pipeline/subtitle-timing";

/** Deterministic dialogue-like timeline: lines of 1 to 4 s with pauses of 0.3 to 6 s. */
function dialogue(durationMs: number, seed = 7): Interval[] {
	let state = seed;
	const rand = () => {
		state = (state * 1103515245 + 12345) % 2147483648;
		return state / 2147483648;
	};
	const out: Interval[] = [];
	let t = 30_000;
	while (t < durationMs - 10_000) {
		const length = 1000 + rand() * 3000;
		out.push({ startMs: Math.round(t), endMs: Math.round(t + length) });
		t += length + 300 + rand() * (rand() < 0.1 ? 20_000 : 6000);
	}
	return out;
}

const shift = (cues: Interval[], ms: number) => cues.map((c) => ({ startMs: c.startMs + ms, endMs: c.endMs + ms }));

function subtitle(id: number, language: string, title: string, flags: Partial<RepairAuditTrack> = {}): RepairAuditTrack {
	return {
		id,
		type: "subtitles",
		codec: "SubStationAlpha",
		language,
		title,
		isDefault: false,
		isForced: false,
		isEnabled: true,
		isHearingImpaired: false,
		isVisualImpaired: false,
		isTextDescriptions: false,
		isOriginal: false,
		isCommentary: false,
		compression: "none",
		...flags,
	};
}

const DURATION = 1_400_000;
const speech = dialogue(DURATION);
/** A handful of signs at times unrelated to speech. */
const signs = [5_000, 200_000, 410_000, 800_000].map((startMs) => ({ startMs, endMs: startMs + 3000 }));

describe("judgeDialogueTiming", () => {
	test("leaves dialogue that follows the speech alone", () => {
		const result = judgeDialogueTiming(speech, speech, DURATION);
		expect(result.status).toBe("synced");
		expect(result.map).toBeUndefined();
	});

	test("finds dialogue shown too early and offers the shift back", () => {
		const result = judgeDialogueTiming(shift(speech, -1500), speech, DURATION);
		expect(result.status).toBe("off");
		expect(result.map!.scale).toBe(1);
		expect(Math.abs(result.map!.pieces[0]!.offsetMs - 1500)).toBeLessThanOrEqual(10);
		expect(result.fitAfter!).toBeGreaterThan(result.fitBefore!);
	});

	test("ignores shifts smaller than speech detection can tell", () => {
		expect(judgeDialogueTiming(shift(speech, -150), speech, DURATION).status).toBe("synced");
	});

	test("offers nothing for dialogue that does not belong to the audio", () => {
		const result = judgeDialogueTiming(dialogue(DURATION, 99), speech, DURATION);
		expect(result.status).toBe("unsure");
	});

	test("does not measure a track with too few lines", () => {
		expect(judgeDialogueTiming(signs, speech, DURATION).status).toBe("unchecked");
	});
});

describe("judgeFileTiming", () => {
	test("signs follow the dialogue track of the same language and are never measured on their own", () => {
		const result = judgeFileTiming(
			[
				{ track: subtitle(2, "en", "Full Subtitles [Group]"), cues: shift(speech, -1500) },
				{ track: subtitle(3, "en", "Signs & Songs [Group]"), cues: signs },
				{ track: subtitle(4, "ger", "Signs"), cues: signs },
				{ track: subtitle(5, "en", "Commentary"), cues: speech },
			],
			speech,
			DURATION,
		);
		const [full, enSigns, deSigns, commentary] = result;
		expect(full!.status).toBe("off");
		expect(enSigns!.status).toBe("off");
		expect(enSigns!.follows).toBe(2);
		expect(enSigns!.map).toEqual(full!.map!);
		expect(enSigns!.fitBefore).toBeUndefined();
		expect(deSigns!.status).toBe("unchecked");
		expect(commentary!.status).toBe("unchecked");
	});

	test("a forced track with many lines still follows instead of being measured", () => {
		const result = judgeFileTiming(
			[
				{ track: subtitle(2, "en", "English"), cues: speech },
				{ track: subtitle(3, "en", "English", { isForced: true }), cues: shift(speech, -1500) },
			],
			speech,
			DURATION,
		);
		expect(result[1]!.status).toBe("synced");
		expect(result[1]!.follows).toBe(2);
	});

	test("signs are left unchecked when the dialogue tracks they could belong to disagree", () => {
		const result = judgeFileTiming(
			[
				{ track: subtitle(2, "en", "Full"), cues: speech },
				{ track: subtitle(3, "en", "Full"), cues: shift(speech, -1500) },
				{ track: subtitle(4, "en", "Signs"), cues: signs },
			],
			speech,
			DURATION,
		);
		expect(result[2]!.status).toBe("unchecked");
		expect(result[2]!.follows).toBeUndefined();
	});

	test("a fix is fine-tuned on a track in sync, as subtitles show a little before the speech", () => {
		const leading = shift(speech, -120);
		const result = judgeFileTiming(
			[
				{ track: subtitle(2, "en", "Full"), cues: leading },
				{ track: subtitle(3, "ger", "Full"), cues: shift(leading, -1500) },
			],
			speech,
			DURATION,
		);
		expect(result[0]!.status).toBe("synced");
		expect(result[1]!.status).toBe("off");
		expect(Math.abs(result[1]!.map!.pieces[0]!.offsetMs - 1500)).toBeLessThanOrEqual(10);
	});

	test("nothing is judged without speech", () => {
		const result = judgeFileTiming([{ track: subtitle(2, "en", "Full"), cues: speech }], null, DURATION);
		expect(result[0]!.status).toBe("unchecked");
	});
});

test("signs pick the dialogue track of their own release by shared title words", () => {
	const ours = subtitle(2, "en", "Full [Group A]");
	const theirs = subtitle(3, "eng", "Full [Group B]");
	expect(followCandidates(subtitle(4, "en", "Signs [Group A]"), [theirs, ours])).toEqual([ours]);
	expect(followCandidates(subtitle(4, "en", "Signs"), [theirs, ours])).toEqual([theirs, ours]);
	expect(followCandidates(subtitle(4, "ja", "Signs"), [theirs, ours])).toEqual([]);
	// Honorifics share the language group, but the exact tag wins.
	const honorifics = subtitle(5, "enm", "Honorifics [Group A]");
	expect(followCandidates(subtitle(4, "eng", "Signs [Group A]"), [honorifics, theirs])).toEqual([theirs]);
});

describe("buildRepairRetimePlans", () => {
	const files = [
		{
			path: "/show/e01.mkv",
			tracks: [subtitle(2, "en", "Full"), subtitle(3, "en", "Signs"), subtitle(4, "ger", "PGS", { codec: "HDMV PGS" })],
		},
		{ path: "/show/e02.mkv", tracks: [subtitle(2, "en", "Full")] },
	];
	const map = { scale: 1, pieces: [{ fromMs: 0, offsetMs: 1500 }] };

	test("moves only the chosen tracks and keeps every track", () => {
		const plans = buildRepairRetimePlans(files, {
			files: [
				{
					path: "/show/e01.mkv",
					tracks: [
						{ trackId: 2, map },
						{ trackId: 3, map },
					],
				},
				{ path: "/show/e02.mkv", tracks: [{ trackId: 2, map: { scale: 1, pieces: [{ fromMs: 0, offsetMs: 0 }] } }] },
			],
			replaceTarget: true,
		});
		expect(plans.map((plan) => plan.targetPath)).toEqual(["/show/e01.mkv"]);
		expect(plans[0]!.retimeSubtitles).toEqual([
			{ trackId: 2, map },
			{ trackId: 3, map },
		]);
		expect(plans[0]!.tracks.map((track) => [track.trackId, track.mode, track.compression])).toEqual([
			[2, "copy", "preserve"],
			[3, "copy", "preserve"],
			[4, "copy", "preserve"],
		]);
	});

	test("refuses picture tracks, unknown tracks and broken maps", () => {
		const one = (trackId: number, trackMap: unknown) => ({
			files: [{ path: "/show/e01.mkv", tracks: [{ trackId, map: trackMap as typeof map }] }],
			replaceTarget: true,
		});
		expect(() => buildRepairRetimePlans(files, one(4, map))).toThrow("holds pictures");
		expect(() => buildRepairRetimePlans(files, one(9, map))).toThrow("no subtitle track 9");
		expect(() => buildRepairRetimePlans(files, one(2, { scale: 2, pieces: map.pieces }))).toThrow("speed");
		expect(() => buildRepairRetimePlans(files, one(2, { scale: 1, pieces: [{ fromMs: 10, offsetMs: 5 }] }))).toThrow("shift");
		expect(() => buildRepairRetimePlans(files, one(2, { scale: 1, pieces: [{ fromMs: 0, offsetMs: 9e9 }] }))).toThrow("shift");
		expect(() => buildRepairRetimePlans(files, one(2, { scale: 1, pieces: [{ fromMs: 0, offsetMs: 0 }] }))).toThrow("No subtitle track needs moving");
		const plan = buildRepairRetimePlans(files, one(2, map))[0]!;
		expect(() => sanitizeRepairPlan({ ...plan, retimeSubtitles: [{ trackId: 7, map }] })).toThrow("not kept by the repair");
	});
});

const hasTools = ["ffmpeg", "mkvmerge", "mkvextract"].every((tool) => Bun.which(tool));

(hasTools ? test : test.skip)(
	"a repair moves the chosen subtitle track and leaves the others as they were",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "rabbit-retime-"));
		const command = async (args: string[]) => {
			const result = await run(args, { cwd: root });
			if (result.code !== 0 && !(args[0] === "mkvmerge" && result.code === 1)) throw new Error(result.stderr || result.stdout);
		};
		try {
			writeFileSync(join(root, "a.srt"), "1\n00:00:01,000 --> 00:00:02,000\nHello\n\n2\n00:00:07,000 --> 00:00:09,000\nLate\n");
			writeFileSync(join(root, "b.srt"), "1\n00:00:01,000 --> 00:00:02,000\nHallo\n");
			// prettier-ignore
			await command([
				"ffmpeg", "-v", "error",
				"-f", "lavfi", "-i", "color=black:s=64x64:r=10:d=8",
				"-f", "lavfi", "-i", "sine=frequency=440:duration=8",
				"-i", "a.srt", "-i", "b.srt",
				"-map", "0:v", "-map", "1:a", "-map", "2:s", "-map", "3:s",
				"-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-c:s", "copy",
				"-metadata:s:s:0", "language=eng", "-metadata:s:s:1", "language=ger",
				"e01.mkv",
			]);
			const path = join(root, "e01.mkv");
			copyFileSync(path, join(root, "before.mkv"));
			const file = await inspectRepairAuditFile(path);
			const [eng, ger] = file.tracks.filter((track) => track.type === "subtitles");
			const [plan] = buildRepairRetimePlans([file], {
				files: [{ path, tracks: [{ trackId: eng!.id, map: { scale: 1, pieces: [{ fromMs: 0, offsetMs: 1500 }] } }] }],
				replaceTarget: true,
			});
			const job = {
				id: "retime",
				kind: "repair",
				inputPath: path,
				settings: getDefaultJobSettings(),
				repairPlan: plan,
				status: "queued",
				steps: [],
			} as unknown as Job;
			await runRepairJob(job, { tempDir: join(root, "tmp") } as AppConfig, (partial) => Object.assign(job, partial));
			expect(job.error).toBeUndefined();

			const tracks = (await identifyMatroska(path)).tracks!.filter((track) => track.type === "subtitles");
			expect(tracks.map((track) => track.properties.language)).toEqual(["eng", "ger"]);
			await command(["mkvextract", path, "tracks", `${tracks[0]!.id}:eng.srt`, `${tracks[1]!.id}:ger.srt`]);
			const moved = readFileSync(join(root, "eng.srt"), "utf-8");
			expect(moved).toContain("00:00:02,500 --> 00:00:03,500");
			// The last line now runs past the video, so it ends with it.
			expect(moved).not.toContain("00:00:10,500");
			expect(readFileSync(join(root, "ger.srt"), "utf-8")).toContain("00:00:01,000 --> 00:00:02,000");
			expect(ger!.language).toBe("ger");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
	60_000,
);
