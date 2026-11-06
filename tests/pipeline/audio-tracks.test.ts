import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getDefaultJobSettings } from "../../src/core/config";
import type { AppConfig, AudioTracksPlan, Job } from "../../src/core/types";
import {
	buildAudioTracksMkvmergeArgs,
	buildAudioTracksPlan,
	inspectAudioTracksFile,
	planAudioTracks,
	runAudioTracksJob,
	type AudioTracksFile,
	type AudioTracksFileTrack,
} from "../../src/pipeline/audio-tracks";
import { identifyMatroska, type MkvIdentification } from "../../src/pipeline/repair";
import { command } from "./release-fixtures";

function track(index: number, language: string, codec: string, channels: number, extra: Partial<AudioTracksFileTrack> = {}): AudioTracksFileTrack {
	const kind = extra.kind ?? "main";
	return {
		index,
		language,
		codec,
		channels,
		channelLayout: channels === 6 ? "5.1(side)" : "stereo",
		delayMs: 0,
		title: extra.currentName ?? "",
		currentName: "",
		kind,
		format: `${codec} ${channels}`,
		isDefault: false,
		isCommentaryFlag: kind === "commentary",
		isVisualImpairedFlag: false,
		isHearingImpaired: false,
		signature: `${language}|${kind}|${codec}|${channels}`,
		...extra,
	};
}

const settings = { ...getDefaultJobSettings(), audioLanguages: ["jpn", "eng"], audioLanguagePriority: ["jpn", "eng", "*"] };
const file: AudioTracksFile = {
	path: "/v/show.mkv",
	name: "show.mkv",
	tracks: [
		track(1, "eng", "flac", 6, { isDefault: true }),
		track(2, "jpn", "opus", 2, { bitrate: 96_000, isOriginal: true }),
		track(3, "ger", "aac", 2),
		track(4, "eng", "ac3", 2, { kind: "commentary", currentName: "Commentary [GRP]", title: "Commentary [GRP]" }),
	],
};

describe("planAudioTracks", () => {
	const plan = planAudioTracks(file, settings);
	const of = (id: number) => plan.tracks.find((t) => t.trackId === id)!;

	it("keeps, orders and encodes the tracks as an encode would", () => {
		expect(plan.tracks.map((t) => [t.trackId, t.position, t.action])).toEqual([
			[2, 0, "copy"],
			[1, 1, "encode"],
			[4, 2, "encode"],
			[3, null, "remove"],
		]);
		expect(of(2).reason).toBe(`Already Opus at or under ${settings.audioBitrates.stereo} kbps`);
		expect(of(1)).toMatchObject({ bitrate: settings.audioBitrates["5.1"], reason: `At ${settings.audioBitrates["5.1"]} kbps` });
		expect(of(3).reason).toBe("Not one of your audio languages");
	});

	it("names and flags them as an encode does", () => {
		expect(plan.tracks.map((t) => [t.trackName, t.isDefault])).toEqual([
			["", true],
			["", true],
			["Commentary [GRP]", false],
			["", false],
		]);
		expect(plan.changes).toEqual(["2 tracks encoded to Opus", "1 track removed", "reordered", "1 track renamed or reflagged"]);
	});

	it("follows a choice for every track of its kind", () => {
		const kept = planAudioTracks(file, settings, { "ger|main|aac|2": "copy", "eng|main|flac|6": "copy" });
		expect(kept.tracks.map((t) => [t.trackId, t.action])).toEqual([
			[2, "copy"],
			[1, "copy"],
			[4, "encode"],
			[3, "copy"],
		]);
		expect(kept.tracks.find((t) => t.trackId === 3)!.suggested).toBe("remove");
	});

	it("leaves a file alone when its audio is already as the settings want it", () => {
		const done: AudioTracksFile = { ...file, tracks: [track(2, "jpn", "opus", 2, { bitrate: 96_000, isDefault: true })] };
		const unchanged = planAudioTracks(done, settings);
		expect(unchanged.changes).toEqual([]);
		expect(buildAudioTracksPlan(unchanged, done, true)).toBeNull();
	});

	it("copies everything when the settings copy audio", () => {
		const copy = planAudioTracks(file, { ...settings, audioEncode: "copy" });
		expect(copy.tracks.filter((t) => t.position !== null).every((t) => t.action === "copy")).toBe(true);
	});

	it("builds a job with the kept tracks in their new order", () => {
		const job = buildAudioTracksPlan(plan, file, false)!;
		expect(job.tracks.map((t) => [t.trackId, t.action, t.isDefault, t.isCommentary, t.isOriginal])).toEqual([
			[2, "copy", true, false, true],
			[1, "encode", true, false, false],
			[4, "encode", false, true, false],
		]);
		expect(job.replaceTarget).toBe(false);
	});
});

describe("buildAudioTracksMkvmergeArgs", () => {
	const target: MkvIdentification = {
		tracks: [
			{ id: 0, type: "video", codec: "AV1", properties: {} },
			{ id: 1, type: "audio", codec: "FLAC", properties: {} },
			{ id: 2, type: "audio", codec: "Opus", properties: {} },
			{ id: 3, type: "audio", codec: "AAC", properties: {} },
			{ id: 4, type: "subtitles", codec: "ASS", properties: {} },
		],
	};

	it("copies kept tracks, reads encoded ones and drops the rest", () => {
		const plan = buildAudioTracksPlan(planAudioTracks(file, settings), file, true)!;
		const args = buildAudioTracksMkvmergeArgs({
			outputPath: "/v/out.mkv",
			plan,
			target,
			encoded: new Map([
				[1, "/t/1.opus"],
				[4, "/t/4.opus"],
			]),
		});
		expect(args[args.indexOf("--track-order") + 1]).toBe("0:0,0:2,1:0,2:0,0:4");
		expect(args[args.indexOf("--audio-tracks") + 1]).toBe("2");
		expect(args.slice(-1)).toEqual(["/t/4.opus"]);
		expect(args[args.indexOf("/t/1.opus") - 1]).toBe("0:0");
		expect(args).toContain("0:Commentary [GRP]");
	});
});

const hasTools = ["ffmpeg", "mkvmerge", "mediainfo"].every((tool) => Bun.which(tool));

(hasTools ? describe : describe.skip)("redoing the audio of a video", () => {
	const root = mkdtempSync(join(tmpdir(), "rabbit-audio-tracks-"));
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	async function makeVideo(name: string): Promise<string> {
		const out = join(root, name);
		await command([
			"ffmpeg",
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"color=black:s=64x64:r=10:d=6",
			"-f",
			"lavfi",
			"-i",
			"sine=f=300:d=6",
			"-f",
			"lavfi",
			"-i",
			"sine=f=500:d=6",
			"-f",
			"lavfi",
			"-i",
			"sine=f=700:d=6",
			"-map",
			"0",
			"-map",
			"1",
			"-map",
			"2",
			"-map",
			"3",
			"-c:v",
			"libx264",
			"-preset",
			"ultrafast",
			"-c:a",
			"flac",
			"-metadata:s:a:0",
			"language=eng",
			"-metadata:s:a:1",
			"language=ger",
			"-metadata:s:a:2",
			"language=jpn",
			out,
		]);
		return out;
	}

	async function redo(path: string, id: string, overrides: Partial<Job["settings"]>): Promise<Job> {
		const jobSettings = { ...settings, ...overrides };
		const inspected = await inspectAudioTracksFile(path, jobSettings);
		const plan: AudioTracksPlan = buildAudioTracksPlan(planAudioTracks(inspected, jobSettings), inspected, true)!;
		const job = { id, kind: "audio", audioTracksPlan: plan, settings: jobSettings, status: "queued", steps: [] } as unknown as Job;
		const config = { tempDir: join(root, "tmp") } as AppConfig;
		mkdirSync(config.tempDir, { recursive: true });
		await runAudioTracksJob(job, config, (partial) => Object.assign(job, partial));
		return job;
	}

	it("removes and reorders tracks in place, keeping their codecs when audio is copied", async () => {
		const path = await makeVideo("copy.mkv");
		const job = await redo(path, "tracks1", { audioEncode: "copy" });
		expect(job.error).toBeUndefined();
		expect(job.outputFilename).toBe(path);
		const audio = (await identifyMatroska(path)).tracks!.filter((t) => t.type === "audio");
		expect(audio.map((t) => [t.properties.language, t.codec, !!t.properties.default_track])).toEqual([
			["jpn", "FLAC", true],
			["eng", "FLAC", true],
		]);
	}, 60_000);

	it.skipIf(!Bun.which("opusenc"))(
		"encodes the kept tracks to Opus",
		async () => {
			const path = await makeVideo("opus.mkv");
			const job = await redo(path, "tracks2", {});
			expect(job.error).toBeUndefined();
			expect(job.steps[1]!.detail).toBe("2 encoded to Opus");
			const audio = (await identifyMatroska(path)).tracks!.filter((t) => t.type === "audio");
			expect(audio.map((t) => [t.properties.language, t.codec])).toEqual([
				["jpn", "Opus"],
				["eng", "Opus"],
			]);
		},
		60_000,
	);
});
