import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getDefaultJobSettings } from "../../src/core/config";
import type { AppConfig, Job, ReleaseAudioPlan } from "../../src/core/types";
import {
	buildReleaseAudioMkvmergeArgs,
	buildReleaseAudioPlan,
	normalizedAudioArgs,
	planAudioSegments,
	planReleaseAudio,
	releaseAudioDefaults,
	runReleaseAudioJob,
	scanReleaseAudio,
	syncedAudioArgs,
	type ReleaseAudioFile,
	type ReleaseAudioOptions,
	type ReleaseAudioTrack,
} from "../../src/pipeline/release-audio";
import { identifyMatroska, type MkvIdentification } from "../../src/pipeline/repair";
import { audioEnvelope, bestLag, ENVELOPE_RATE } from "../../src/sync/audio-envelope";
import { alignReleaseFiles } from "../../src/sync/release-align";
import { command, hasReleaseTools, makeAvMkv, RATE, speechLike, writeWav } from "./release-fixtures";

let nextId = 1;
function audio(language: string, codec: string, channels: number, flags: Partial<ReleaseAudioTrack> = {}): ReleaseAudioTrack {
	return {
		id: nextId++,
		codec,
		codecId: "",
		language,
		title: "",
		channels,
		sampleRate: 48000,
		bitrate: 0,
		durationMs: 1_420_000,
		isDefault: false,
		isOriginal: false,
		isCommentary: false,
		isVisualImpaired: false,
		isHearingImpaired: false,
		...flags,
	};
}

const file = (path: string, tracks: ReleaseAudioTrack[]): ReleaseAudioFile => ({
	path,
	filename: path.split("/").pop()!,
	durationMs: 1_420_000,
	audio: tracks,
});

const options: ReleaseAudioOptions = {
	codecPriority: "lossless-first",
	renameTracks: false,
	languagePriority: ["jpn", "eng", "*"],
	autoLanguages: [],
	autoKinds: ["main", "commentary"],
};

const target = file("/enc/Show - S01E01 [AV1]-Rabbit.mkv", [audio("ja", "Opus", 2, { isDefault: true, isOriginal: true })]);
const web = file("/web/[Erai-raws] Show - 01 [1080p CR WEB-DL][ABCD1234].mkv", [
	audio("ja", "AAC", 2),
	audio("en", "AAC", 2, { title: "English" }),
	audio("de", "AAC", 2),
]);
const bd = file("/bd/Show.S01E01.1080p.BluRay.FLAC-GRP.mkv", [
	audio("ja", "FLAC", 2),
	audio("en", "FLAC", 6, { title: "English 5.1" }),
	audio("en", "AC-3", 2, { title: "Commentary", isCommentary: true }),
	audio("en", "AC-3", 2, { title: "Audio Description", isVisualImpaired: true }),
]);

describe("planReleaseAudio", () => {
	const plan = planReleaseAudio(target, [web, bd], options);
	const cell = (key: string) => plan.cells.find((c) => c.key === key)!;

	it("keeps the languages the video has and adds the ones it lacks", () => {
		expect(cell("ja:main").action).toBe("keep");
		expect(plan.additions.map((a) => a.key)).toEqual(["en:main", "en:commentary", "de:main"]);
	});

	it("takes the best quality first, whichever folder it is in", () => {
		expect(plan.additions[0]).toMatchObject({ sourcePath: bd.path, format: "FLAC 5.1", lossless: true });
		expect(cell("en:main").candidates.map((c) => c.format)).toEqual(["FLAC 5.1", "AAC 2.0"]);
		const small = planReleaseAudio(target, [web, bd], { ...options, codecPriority: "smallest-first" });
		expect(small.additions[0]).toMatchObject({ sourcePath: web.path, format: "AAC 2.0" });
	});

	it("only offers the kinds and languages the settings leave out", () => {
		expect(cell("en:descriptive").action).toBe("skip");
		const english = planReleaseAudio(target, [web, bd], { ...options, autoLanguages: ["eng"] });
		expect(english.additions.map((a) => a.key)).toEqual(["en:main", "en:commentary"]);
		expect(english.cells.find((c) => c.key === "de:main")!.action).toBe("skip");
	});

	it("replaces a track of the video only when picked by hand", () => {
		const replaced = planReleaseAudio(target, [web, bd], { ...options, choices: { "ja:main": { sourcePath: bd.path, trackId: bd.audio[0]!.id } } });
		const ja = replaced.additions.find((a) => a.key === "ja:main")!;
		expect(ja).toMatchObject({ sourcePath: bd.path, replaces: [target.audio[0]!.id] });
		const skipped = planReleaseAudio(target, [web, bd], { ...options, choices: { "en:main": null } });
		expect(skipped.additions.map((a) => a.key)).toEqual(["en:commentary", "de:main"]);
	});

	it("names commentary the way an encode does when renaming", () => {
		const renamed = planReleaseAudio(target, [bd], { ...options, renameTracks: true });
		expect(renamed.additions.map((a) => a.trackName)).toEqual(["", "Commentary"]);
	});

	it("follows the encode settings for what to add", () => {
		const settings = { ...getDefaultJobSettings(), audioLanguages: ["eng"], removeCommentaryAudio: true };
		const defaults = releaseAudioDefaults(settings);
		expect(defaults.autoKinds).not.toContain("commentary");
		expect(planReleaseAudio(target, [web, bd], defaults).additions.map((a) => a.key)).toEqual(["en:main", "en:descriptive"]);
	});

	it("builds a job plan with the releases it takes from", () => {
		const job = buildReleaseAudioPlan(plan, true)!;
		expect(job.sources).toEqual([bd.path, web.path]);
		expect(job.additions.map((a) => [a.sourceIndex, a.language, a.isCommentary])).toEqual([
			[0, "en", false],
			[0, "en", true],
			[1, "de", false],
		]);
		expect(buildReleaseAudioPlan({ targetPath: target.path, additions: [] }, true)).toBeNull();
	});
});

describe("planAudioSegments", () => {
	const map = (offsetMs: number, scale = 1) => ({ scale, pieces: [{ fromMs: 0, offsetMs }] });

	it("starts a release that starts later at the video's zero", () => {
		expect(planAudioSegments(map(-3000), [], 100_000, 90_000)).toEqual([{ sourceStartMs: 3000, sourceEndMs: 93_000, targetStartMs: 0 }]);
	});

	it("leaves the start silent for a release that starts earlier", () => {
		expect(planAudioSegments(map(2000), [], 100_000, 90_000)).toEqual([{ sourceStartMs: 0, sourceEndMs: 88_000, targetStartMs: 2000 }]);
	});

	it("takes out what the video lacks", () => {
		const cut = {
			scale: 1,
			pieces: [
				{ fromMs: 0, offsetMs: 0 },
				{ fromMs: 50_000, offsetMs: -10_000 },
			],
		};
		expect(planAudioSegments(cut, [{ startMs: 40_000, endMs: 50_000 }], 100_000, 90_000)).toEqual([
			{ sourceStartMs: 0, sourceEndMs: 40_000, targetStartMs: 0 },
			{ sourceStartMs: 50_000, sourceEndMs: 100_000, targetStartMs: 40_000 },
		]);
	});

	it("leaves a gap where the video has footage the release lacks", () => {
		const extra = {
			scale: 1,
			pieces: [
				{ fromMs: 0, offsetMs: 0 },
				{ fromMs: 40_000, offsetMs: 5000 },
			],
		};
		const segments = planAudioSegments(extra, [], 85_000, 90_000);
		expect(segments.map((s) => s.targetStartMs)).toEqual([0, 45_000]);
		expect(segments[1]!.sourceEndMs).toBe(85_000);
	});

	it("stretches a release of another frame rate and stops at the video's end", () => {
		const [segment] = planAudioSegments(map(0, 25 / 23.976), [], 100_000, 90_000);
		expect(segment!.sourceStartMs).toBe(0);
		expect(segment!.sourceEndMs * (25 / 23.976)).toBeCloseTo(90_000, 3);
	});
});

describe("syncedAudioArgs", () => {
	it("pads the gaps between segments and slows a faster release by resampling", () => {
		const args = syncedAudioArgs(
			"/t/in.flac",
			"/t/out.flac",
			[
				{ sourceStartMs: 0, sourceEndMs: 40_000, targetStartMs: 1000 },
				{ sourceStartMs: 50_000, sourceEndMs: 60_000, targetStartMs: 45_000 },
			],
			1,
			48000,
		);
		const graph = args[args.indexOf("-filter_complex") + 1]!;
		expect(graph).toContain("[0:a]asetpts=PTS-STARTPTS,adelay=delays=48000S:all=1,apad=pad_len=192000[s0]");
		expect(graph).toContain("[s0][s1]concat=n=2:v=0:a=1[out]");
		expect(args.filter((a) => a === "-i")).toHaveLength(2);
		const slower = syncedAudioArgs("/t/in.flac", "/t/out.flac", [{ sourceStartMs: 0, sourceEndMs: 1000, targetStartMs: 0 }], 25 / 24, 48000);
		expect(slower[slower.indexOf("-filter_complex") + 1]).toBe("[0:a]asetpts=PTS-STARTPTS,aresample=192000,asetrate=184320,aresample=48000[out]");
	});
});

describe("buildReleaseAudioMkvmergeArgs", () => {
	const identified: MkvIdentification = {
		tracks: [
			{ id: 0, type: "video", codec: "AV1", properties: {} },
			{ id: 1, type: "audio", codec: "Opus", properties: { language: "jpn", default_track: true } },
			{ id: 2, type: "audio", codec: "Opus", properties: { language: "fre" } },
			{ id: 3, type: "subtitles", codec: "ASS", properties: { language: "eng" } },
		],
	};
	const addition = (sourceIndex: number, trackId: number, language: string, replaces: number[] = []) => ({
		sourceIndex,
		trackId,
		language,
		trackName: "",
		isOriginal: false,
		isCommentary: false,
		isVisualImpaired: false,
		isHearingImpaired: false,
		replaces,
	});
	const plan: ReleaseAudioPlan = { targetPath: "/v/target.mkv", sources: ["/r/a.mkv", "/r/b.mkv"], additions: [], replaceTarget: true };

	it("places added tracks by the language priority, copies or reads each, and drops what they replace", () => {
		const args = buildReleaseAudioMkvmergeArgs({
			outputPath: "/v/out.mkv",
			plan,
			target: identified,
			prepared: [
				{ addition: addition(1, 4, "en"), syncMs: -3000 },
				{ addition: addition(0, 2, "fr", [2]), file: "/tmp/fr.opus" },
			],
			languagePriority: ["jpn", "eng", "*"],
		});
		expect(args[args.indexOf("--track-order") + 1]).toBe("0:0,0:1,1:4,2:0,0:3");
		expect(args.slice(args.indexOf("--audio-tracks"), args.indexOf("--audio-tracks") + 3)).toEqual(["--audio-tracks", "1", "/v/target.mkv"]);
		expect(args).toContain("4:-3000");
		expect(args.indexOf("/r/b.mkv")).toBeGreaterThan(args.indexOf("4:-3000"));
		expect(args).not.toContain("/r/a.mkv");
		expect(args[args.length - 1]).toBe("/tmp/fr.opus");
		expect(args.filter((a) => a.endsWith(":1") && args[args.indexOf(a) - 1] === "--default-track-flag")).toEqual([]);
	});

	it("orders, names and flags all audio as an encode does when the settings are applied", () => {
		const settings = { ...getDefaultJobSettings(), audioLanguagePriority: ["jpn", "eng", "*"] };
		const commentary = { ...addition(1, 5, "en"), trackName: "Commentary", isCommentary: true };
		const args = buildReleaseAudioMkvmergeArgs({
			outputPath: "/v/out.mkv",
			plan,
			target: identified,
			prepared: [
				{ addition: commentary, sourceTitle: "Director's commentary", channels: 2 },
				{ addition: addition(1, 4, "en"), sourceTitle: "English", channels: 6 },
			],
			languagePriority: settings.audioLanguagePriority,
			settings,
		});
		expect(args[args.indexOf("--track-order") + 1]).toBe("0:0,0:1,1:4,1:5,0:2,0:3");
		const flag = (option: string, id: number) => args.find((a, i) => args[i - 1] === option && a.startsWith(`${id}:`));
		expect(flag("--default-track-flag", 1)).toBe("1:1");
		expect(flag("--default-track-flag", 2)).toBe("2:1");
		expect(flag("--default-track-flag", 4)).toBe("4:1");
		expect(flag("--default-track-flag", 5)).toBe("5:0");
		expect(flag("--track-name", 1)).toBe("1:");
		expect(args.indexOf("--track-name")).toBeLessThan(args.indexOf("/v/target.mkv"));
	});
});

(hasReleaseTools ? describe : describe.skip)("adding audio from another release", () => {
	const root = mkdtempSync(join(tmpdir(), "rabbit-release-audio-"));
	afterAll(() => rmSync(root, { recursive: true, force: true }));
	const speech = speechLike(120, 21);
	const seconds = 120;

	async function release(name: string, parts: Int16Array[], dub: Int16Array[]): Promise<string> {
		const wav = join(root, `${name}.wav`);
		const dubWav = join(root, `${name}.dub.wav`);
		writeWav(wav, ...parts);
		writeWav(dubWav, ...dub);
		const av = join(root, `${name}-av.mkv`);
		await makeAvMkv(av, wav, parts.reduce((n, p) => n + p.length, 0) / RATE);
		const out = join(root, `${name}.mkv`);
		await command(["mkvmerge", "-q", "-o", out, "--language", "1:ja", av, "--language", "0:en", "--track-name", "0:English", dubWav]);
		return out;
	}

	async function makeTarget(credits?: Int16Array, name = "target"): Promise<string> {
		const wav = join(root, `${name}.wav`);
		writeWav(wav, ...(credits ? [speech, credits] : [speech]));
		const av = join(root, `${name}-av.mkv`);
		await makeAvMkv(av, wav, seconds + (credits ? credits.length / RATE : 0));
		const out = join(root, `${name}.mkv`);
		await command(["mkvmerge", "-q", "-o", out, "--language", "1:ja", av]);
		return out;
	}

	/** Where the n-th audio track of a file sits against the target's audio, in ms, and how well it matches there. */
	async function placement(path: string, track: number, targetPath: string) {
		const info = await identifyMatroska(path);
		const index = (info.tracks ?? []).filter((t) => t.type === "audio")[track]!.id;
		const added = await audioEnvelope(path, index);
		const reference = await audioEnvelope(targetPath, 1);
		const hit = bestLag(reference, added, 20);
		return { lagMs: (hit.lag * 1000) / ENVELOPE_RATE, score: hit.score, seconds: added.length / ENVELOPE_RATE };
	}

	async function addEnglish(targetPath: string, source: string, id: string, applySettings = false, settings: Partial<Job["settings"]> = {}): Promise<Job> {
		const plan: ReleaseAudioPlan = {
			targetPath,
			sources: [source],
			replaceTarget: false,
			applySettings,
			additions: [
				{
					sourceIndex: 0,
					trackId: 2,
					language: "en",
					trackName: "English",
					isOriginal: false,
					isCommentary: false,
					isVisualImpaired: false,
					isHearingImpaired: false,
					replaces: [],
				},
			],
		};
		const job = { id, kind: "audio", audioPlan: plan, settings: { ...getDefaultJobSettings(), ...settings }, status: "queued", steps: [] } as unknown as Job;
		const config = { tempDir: join(root, "tmp") } as AppConfig;
		mkdirSync(config.tempDir, { recursive: true });
		await runReleaseAudioJob(job, config, (partial) => Object.assign(job, partial));
		return job;
	}

	it("applies the audio settings to the result while keeping the codecs when audio is copied", async () => {
		const targetPath = await makeTarget();
		const lead = speechLike(3, 25);
		const job = await addEnglish(targetPath, await release("apply-copy", [lead, speech], [lead, speech]), "audio3", true, {
			audioEncode: "copy",
			audioLanguagePriority: ["eng", "jpn", "*"],
		});
		expect(job.error).toBeUndefined();
		expect(job.steps[2]!.detail).toBe("1 copied");
		const audio = (await identifyMatroska(job.outputFilename!)).tracks!.filter((t) => t.type === "audio");
		expect(audio.map((t) => [t.properties.language, t.codec, !!t.properties.default_track])).toEqual([
			["eng", "PCM", true],
			["jpn", "FLAC", true],
		]);
	}, 120_000);

	it.skipIf(!Bun.which("opusenc"))(
		"encodes a dub that only needs a delay to Opus when the settings are applied",
		async () => {
			const targetPath = await makeTarget();
			const lead = speechLike(3, 26);
			const job = await addEnglish(targetPath, await release("apply-opus", [lead, speech], [lead, speech]), "audio4", true);
			expect(job.error).toBeUndefined();
			expect(job.steps[2]!.detail).toBe("1 encoded to Opus");
			const audio = (await identifyMatroska(job.outputFilename!)).tracks!.filter((t) => t.type === "audio");
			expect(audio.map((t) => [t.properties.language, t.codec])).toEqual([
				["jpn", "FLAC"],
				["eng", "Opus"],
			]);
			const placed = await placement(job.outputFilename!, 1, targetPath);
			expect(Math.abs(placed.lagMs)).toBeLessThanOrEqual(20);
			expect(placed.score).toBeGreaterThan(0.9);
		},
		120_000,
	);

	it.skipIf(!Bun.which("opusenc"))(
		"encodes a dub rebuilt across a cut to Opus",
		async () => {
			const targetPath = await makeTarget();
			const parts = [speech.slice(0, 60 * RATE), speechLike(15, 24), speech.slice(60 * RATE)];
			const job = await addEnglish(targetPath, await release("cut-job", parts, parts), "audio2");
			expect(job.error).toBeUndefined();
			expect(job.steps[2]!.detail).toBe("1 encoded to Opus");
			const placed = await placement(job.outputFilename!, 1, targetPath);
			expect(Math.abs(placed.lagMs)).toBeLessThanOrEqual(20);
			expect(placed.score).toBeGreaterThan(0.9);
			expect(Math.abs(placed.seconds - seconds)).toBeLessThan(0.2);
		},
		120_000,
	);

	it("cuts a release with an ending the video lacks at the video's end", async () => {
		const targetPath = await makeTarget(undefined, "no-preview");
		const preview = speechLike(20, 27);
		const job = await addEnglish(targetPath, await release("preview", [speech, preview], [speech, preview]), "audio5");
		expect(job.error).toBeUndefined();
		expect(job.steps[2]!.detail).toBe("1 encoded to Opus");
		const placed = await placement(job.outputFilename!, 1, targetPath);
		expect(Math.abs(placed.lagMs)).toBeLessThanOrEqual(20);
		expect(placed.score).toBeGreaterThan(0.9);
		expect(Math.abs(placed.seconds - seconds)).toBeLessThan(0.2);
	}, 120_000);

	it("copies a release without the video's credits as it is, ending before the video does", async () => {
		const credits = speechLike(20, 28);
		const targetPath = await makeTarget(credits, "credits");
		const job = await addEnglish(targetPath, await release("no-credits", [speech], [speech]), "audio6");
		expect(job.error).toBeUndefined();
		expect(job.steps[2]!.detail).toBe("1 copied");
		const placed = await placement(job.outputFilename!, 1, targetPath);
		expect(Math.abs(placed.lagMs)).toBeLessThanOrEqual(20);
		expect(placed.score).toBeGreaterThan(0.9);
		expect(Math.abs(placed.seconds - seconds)).toBeLessThan(0.2);
	}, 120_000);

	it("copies a dub of a release that starts later, moved to the video", async () => {
		const targetPath = await makeTarget();
		const lead = speechLike(3, 22);
		const job = await addEnglish(targetPath, await release("later", [lead, speech], [lead, speech]), "audio1");
		expect(job.error).toBeUndefined();
		expect(job.status).toBe("done");
		expect(job.steps[2]!.detail).toBe("1 copied");
		const output = job.outputFilename!;
		expect(output).toMatch(/target\.audio.*\.mkv$/);
		const info = await identifyMatroska(output);
		const added = (info.tracks ?? []).filter((t) => t.type === "audio");
		const own = (await identifyMatroska(targetPath)).tracks!.find((t) => t.type === "audio")!;
		expect(added.map((t) => [t.properties.language, t.properties.track_name ?? "", !!t.properties.default_track])).toEqual([
			["jpn", "", !!own.properties.default_track],
			["eng", "English", false],
		]);
		const placed = await placement(output, 1, targetPath);
		expect(Math.abs(placed.lagMs)).toBeLessThanOrEqual(20);
		expect(placed.score).toBeGreaterThan(0.9);
	}, 120_000);

	it("rebuilds a release with a scene the video lacks on the video's timeline", async () => {
		const targetPath = await makeTarget();
		const extra = speechLike(15, 23);
		const source = await release("cut", [speech.slice(0, 60 * RATE), extra, speech.slice(60 * RATE)], [speech]);
		const alignment = await alignReleaseFiles(targetPath, source, { cacheDir: join(root, "tmp") });
		expect(alignment.removed).toHaveLength(1);
		const normalized = join(root, "cut.source.flac");
		await command(normalizedAudioArgs(source, 0, 0, normalized));
		const segments = planAudioSegments(alignment.map, alignment.removed, 135_000, seconds * 1000);
		expect(segments).toHaveLength(2);
		const synced = join(root, "cut.synced.flac");
		await command(syncedAudioArgs(normalized, synced, segments, alignment.map.scale, RATE));
		const rebuilt = await audioEnvelope(synced, 0);
		const reference = await audioEnvelope(targetPath, 1);
		expect(Math.abs(rebuilt.length / ENVELOPE_RATE - seconds)).toBeLessThan(0.2);
		const hit = bestLag(reference, rebuilt, 20);
		expect(Math.abs(hit.lag)).toBeLessThanOrEqual(2);
		expect(hit.score).toBeGreaterThan(0.9);
	}, 120_000);
});

(hasReleaseTools ? describe : describe.skip)("choosing single videos and release files", () => {
	const root = mkdtempSync(join(tmpdir(), "rabbit-release-audio-pick-"));
	afterAll(() => rmSync(root, { recursive: true, force: true }));
	const options = releaseAudioDefaults(getDefaultJobSettings());

	async function audioFile(path: string, languages: string[]): Promise<void> {
		const args = ["ffmpeg", "-v", "error", "-y"];
		for (const _ of languages) args.push("-f", "lavfi", "-i", "sine=f=400:d=2");
		languages.forEach((_, i) => args.push("-map", `${i}:a`));
		args.push("-c:a", "flac");
		languages.forEach((language, i) => args.push(`-metadata:s:a:${i}`, `language=${language}`));
		await command([...args, path]);
	}

	it("pairs one chosen episode with its episode in a release folder", async () => {
		for (const dir of ["enc", "bd"]) mkdirSync(join(root, dir));
		for (const n of ["01", "02"]) {
			await audioFile(join(root, "enc", `Show - S01E${n}.mkv`), ["jpn"]);
			await audioFile(join(root, "bd", `Show.S01E${n}.BluRay-GRP.mkv`), ["jpn", "eng"]);
		}
		const scan = await scanReleaseAudio({ targets: [join(root, "enc", "Show - S01E02.mkv")], sourceDirs: [join(root, "bd")], options });
		expect(scan.rows.map((r) => [r.targetName, r.sources.map((s) => [s.name, s.method])])).toEqual([
			["Show - S01E02.mkv", [["Show.S01E02.BluRay-GRP.mkv", "episode"]]],
		]);
		expect(scan.rows[0]!.additions.map((a) => a.key)).toEqual(["en:main"]);
	}, 30_000);

	it("takes a chosen release file from a folder of other releases", async () => {
		for (const dir of ["movie", "releases"]) mkdirSync(join(root, dir));
		await audioFile(join(root, "movie", "Movie (2020).mkv"), ["jpn"]);
		await audioFile(join(root, "releases", "Another Movie (2019).mkv"), ["jpn", "ger"]);
		await audioFile(join(root, "releases", "Movie.2020.BluRay-GRP.mkv"), ["jpn", "eng"]);
		const scan = await scanReleaseAudio({
			targets: [join(root, "movie", "Movie (2020).mkv")],
			sourceDirs: [join(root, "releases", "Movie.2020.BluRay-GRP.mkv")],
			options,
		});
		expect(scan.rows[0]!.sources.map((s) => s.name)).toEqual(["Movie.2020.BluRay-GRP.mkv"]);
		expect(scan.rows[0]!.additions.map((a) => a.key)).toEqual(["en:main"]);
		const folder = await scanReleaseAudio({ targets: [join(root, "movie", "Movie (2020).mkv")], sourceDirs: [join(root, "releases")], options });
		expect(folder.rows[0]!.sources).toEqual([]);
	}, 30_000);
});
