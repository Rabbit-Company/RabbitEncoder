import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getDefaultJobSettings } from "../../src/core/config";
import { run } from "../../src/core/process";
import type { AppConfig, Job, JobSettings } from "../../src/core/types";
import { runTranslateOnlyJob } from "../../src/pipeline/translate-only";
import { fontRegistry } from "../../src/fonts/fonts";
import { runSubtitleAddJob } from "../../src/pipeline/subtitle-add";
import type { Interval } from "../../src/subsearch/cues";
import { describeAddedSubtitles, missingTargetLanguages, type TranslatedTrack } from "../../src/translate/translate-step";

const hasTools = ["ffmpeg", "ffprobe", "mkvmerge"].every((tool) => Bun.which(tool));

describe("missingTargetLanguages", () => {
	it("skips languages with a full or honorifics track, and repeats", () => {
		const tracks = [
			{ index: 2, codec: "subrip", language: "eng", trackType: "full" },
			{ index: 3, codec: "subrip", language: "slv", trackType: "sdh" },
			{ index: 4, codec: "ass", language: "en-JP", trackType: "honorifics" },
			{ index: 5, codec: "ass", language: "ger", trackType: "forced" },
		];
		expect(missingTargetLanguages(tracks, ["en", "slv", "sl", "deu", "nonsense"])).toEqual(["slv", "deu"]);
	});
});

describe("describeAddedSubtitles", () => {
	const track = (downloaded: boolean) => ({ downloaded }) as TranslatedTrack;
	it("tells downloads from translations", () => {
		expect(describeAddedSubtitles([])).toBe("Nothing to add");
		expect(describeAddedSubtitles([track(true), track(false), track(false)])).toBe("Downloaded 1, translated 2 track(s)");
		expect(describeAddedSubtitles([track(false)])).toBe("Translated 1 track(s)");
	});
});

function timeline(count: number): Interval[] {
	let state = 21;
	const rand = () => (state = (state * 16807) % 2147483647) / 2147483647;
	const out: Interval[] = [];
	let t = 2000;
	for (let i = 0; i < count; i++) {
		const len = 800 + Math.round(rand() * 900);
		out.push({ startMs: t, endMs: t + len });
		t += len + 300 + Math.round(rand() * 1000);
	}
	return out;
}

function srt(cues: Interval[], text: string, shiftMs = 0): string {
	const tc = (ms: number) => {
		const p = (n: number, w = 2) => String(Math.floor(n)).padStart(w, "0");
		return `${p(ms / 3_600_000)}:${p((ms / 60_000) % 60)}:${p((ms / 1000) % 60)},${p(ms % 1000, 3)}`;
	};
	return cues.map((c, i) => `${i + 1}\n${tc(c.startMs + shiftMs)} --> ${tc(c.endMs + shiftMs)}\n${text} ${i}\n`).join("\n");
}

(hasTools ? describe : describe.skip)("translate jobs download before translating", () => {
	const root = mkdtempSync(join(tmpdir(), "rabbit-autodl-"));
	const cues = timeline(110);
	const realFetch = globalThis.fetch;
	const calls: string[] = [];
	let quotaUsedUp = false;
	let offerFrench = false;
	let offerExtras = false;
	let remainingToday = 100;
	const searchedLanguages: string[] = [];

	beforeAll(async () => {
		fontRegistry.configure(join(import.meta.dir, "../../fonts"), join(root, "fonts"));
		fontRegistry.seed(["Noto Sans"]);
		await fontRegistry.reload();
		const duration = Math.ceil(cues[cues.length - 1]!.endMs / 1000) + 5;
		writeFileSync(join(root, "eng.srt"), srt(cues, "English line"));
		const a = await run([
			"ffmpeg",
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			`color=c=gray:s=32x32:r=1:d=${duration}`,
			"-f",
			"lavfi",
			"-i",
			`anullsrc=r=8000:cl=mono:d=${duration}`,
			"-c:v",
			"ffv1",
			"-c:a",
			"flac",
			"-t",
			String(duration),
			join(root, "plain.mkv"),
		]);
		if (a.code !== 0) throw new Error(a.stderr);

		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			calls.push(`${init?.method ?? "GET"} ${url.hostname}${url.pathname}`);
			if (url.hostname === "127.0.0.1") throw new TypeError("Unable to connect");
			if (url.pathname === "/api/v1/login") return Response.json({ token: "tok", base_url: "api.opensubtitles.com" });
			if (url.pathname === "/api/v1/infos/user")
				return Response.json({ data: { username: "rabbit", remaining_downloads: remainingToday, allowed_downloads: 1000 } });
			if (url.pathname === "/api/v1/subtitles") {
				searchedLanguages.push(url.searchParams.get("languages") ?? "");
				return Response.json({
					total_pages: 1,
					data: [
						{ id: "1", attributes: { language: "sl", release: "Show.S01E01.1080p.WEB", download_count: 500, files: [{ file_id: 7001, file_name: "a.srt" }] } },
						...(offerExtras
							? ["es", "fr"].map((language, i) => ({
									id: `x${i}`,
									attributes: { language, release: "Show.S01E01.1080p.WEB", download_count: 50, files: [{ file_id: 7100 + i, file_name: `${language}.srt` }] },
								}))
							: []),
						...(offerFrench
							? [
									{
										id: "2",
										attributes: { language: "fr", release: "Show.S01E01.1080p.WEB", download_count: 90, files: [{ file_id: 7002, file_name: "b.srt" }] },
									},
								]
							: []),
					],
				});
			}
			if (url.pathname === "/api/v1/download") {
				if (new Headers(init?.headers).get("Authorization") !== "Bearer tok") return new Response("{}", { status: 401 });
				if (quotaUsedUp)
					return Response.json(
						{ message: "You have downloaded your allowed 20 subtitles", reset_time_utc: new Date(Date.now() + 400).toISOString() },
						{ status: 406 },
					);
				const fileId = JSON.parse(String(init?.body)).file_id;
				return Response.json({ link: `https://dl.example/${fileId}`, file_name: `${fileId}.srt`, remaining: 10 });
			}
			if (url.hostname === "dl.example") return new Response(srt(cues, url.pathname === "/7002" ? "Ligne française" : "Slovenska vrstica", 1500));
			return new Response("not found", { status: 404 });
		}) as typeof fetch;
	}, 60_000);

	afterAll(() => {
		globalThis.fetch = realFetch;
		rmSync(root, { recursive: true, force: true });
	});

	async function translateJob(name: string, settings: Partial<JobSettings>, tempDir: string, existing?: string): Promise<Job> {
		const folder = join(root, name);
		mkdirSync(folder, { recursive: true });
		const video = existing ?? join(folder, "Show.S01E01.1080p.WEB.mkv");
		if (!existing) {
			const b = await run(["mkvmerge", "-q", "-o", video, join(root, "plain.mkv"), "--language", "0:eng", join(root, "eng.srt")]);
			if (b.code !== 0 && b.code !== 1) throw new Error(b.stderr || b.stdout);
		}
		const job = {
			id: name,
			filename: "Show.S01E01.1080p.WEB.mkv",
			inputPath: video,
			relativePath: "",
			status: "queued",
			progress: 0,
			queueOrder: 1,
			currentStage: "",
			steps: [],
			replaceSource: true,
			settings: {
				...getDefaultJobSettings(),
				subtitleProcessing: "translate",
				translateSubtitles: true,
				translateTargetLanguages: ["slv", "deu"],
				translateSourceTrack: "auto",
				translateSourceMatch: { language: "eng", type: "full" },
				subtitleLanguagePriority: ["eng", "slv", "*"],
				openSubtitlesUsername: "rabbit",
				openSubtitlesPassword: "secret",
				subtitleDownloadAiFallback: false,
				convertSrtToAss: true,
				fontGroup: "Noto Sans",
				...settings,
			},
		} as Job;
		const config = { tempDir, outputDir: join(root, "out"), recycleBinDir: "", organization: "RabbitCompany" } as AppConfig;
		mkdirSync(tempDir, { recursive: true });
		await runTranslateOnlyJob(job, config, (partial) => Object.assign(job, partial));
		return job;
	}

	async function fonts(path: string): Promise<string[]> {
		const info = await run(["mkvmerge", "-J", path]);
		return ((JSON.parse(info.stdout).attachments ?? []) as any[]).map((a) => a.file_name).sort();
	}

	async function subtitleText(path: string, trackId: number): Promise<string> {
		const out = join(root, `extract_${trackId}_${Math.random().toString(36).slice(2)}.ass`);
		await run(["mkvextract", path, "tracks", `${trackId}:${out}`]);
		return readFileSync(out, "utf-8");
	}

	async function tracks(path: string) {
		const info = await run(["mkvmerge", "-J", path]);
		return (JSON.parse(info.stdout).tracks as any[])
			.filter((t) => t.type === "subtitles")
			.map((t) => ({ language: t.properties.language, name: t.properties.track_name, codec: t.codec }));
	}

	async function defaults(path: string): Promise<Record<string, boolean>> {
		const info = await run(["mkvmerge", "-J", path]);
		return Object.fromEntries(
			(JSON.parse(info.stdout).tracks as any[]).filter((t) => t.type === "subtitles").map((t) => [t.properties.language, t.properties.default_track]),
		);
	}

	it("adds the most used languages it can sync, after the targets and never as default", async () => {
		offerExtras = true;
		searchedLanguages.length = 0;
		const job = await translateJob("extras", { translateTargetLanguages: ["slv"], subtitleDownloadExtraLanguages: 10 }, join(root, "tmp-x"));
		offerExtras = false;
		expect(job.status).toBe("done");
		// The file already has English, so it is not among the extras.
		// One search lists the target and the extra languages together.
		expect(searchedLanguages).toEqual(["ar,de,es,fr,id,it,pt-br,ru,sl,zh-cn"]);
		expect((await tracks(job.inputPath)).map((t) => t.language).sort()).toEqual(["eng", "fre", "slv", "spa"]);
		expect(await defaults(job.inputPath)).toMatchObject({ slv: true, spa: false, fre: false });
	}, 60_000);

	it("leaves the extra languages out when the quota is nearly used up", async () => {
		offerExtras = true;
		remainingToday = 20;
		const job = await translateJob("extras-low", { translateTargetLanguages: ["slv"], subtitleDownloadExtraLanguages: 10 }, join(root, "tmp-y"));
		offerExtras = false;
		remainingToday = 100;
		expect(job.status).toBe("done");
		expect((await tracks(job.inputPath)).map((t) => t.language)).toEqual(["eng", "slv"]);
	}, 60_000);

	it("adds the downloaded language as a styled track and leaves the rest when AI is off", async () => {
		calls.length = 0;
		const job = await translateJob("found", {}, join(root, "tmp-a"));
		expect(job.error).toBeUndefined();
		expect(job.status).toBe("done");
		expect(job.steps[1]!.detail).toBe("Downloaded 1 track(s)");
		expect(await tracks(job.inputPath)).toEqual([
			{ language: "eng", name: undefined, codec: "SubRip/SRT" },
			{ language: "slv", name: "Full Subtitles [OpenSubtitles]", codec: "SubStationAlpha" },
		]);
		expect(calls.filter((c) => c.includes("/download"))).toHaveLength(1);
		// The converted track uses the font group's face, which is now attached.
		expect(await fonts(job.inputPath)).toEqual(["noto_sans.ttf"]);
		expect(await subtitleText(job.inputPath, 3)).toMatch(/^Style: Default,Noto Sans,/m);
	}, 60_000);

	it("reuses the face an earlier run attached instead of adding another copy", async () => {
		offerFrench = true;
		const video = join(root, "found", "Show.S01E01.1080p.WEB.mkv");
		const job = await translateJob("again", { translateTargetLanguages: ["slv", "fra"] }, join(root, "tmp-g"), video);
		offerFrench = false;
		expect(job.status).toBe("done");
		expect((await tracks(video)).map((t) => t.language)).toEqual(["eng", "slv", "fre"]);
		expect(await fonts(video)).toEqual(["noto_sans.ttf"]);
		expect(await subtitleText(video, 4)).toMatch(/^Style: Default,Noto Sans,/m);
	}, 60_000);

	const deadAi = { subtitleDownloadAiFallback: true, translateBaseUrl: "http://127.0.0.1:9/v1", translateTimeoutMs: 2000 };

	it("keeps the downloads and warns when the AI provider fails for the rest", async () => {
		const job = await translateJob("fallback", deadAi, join(root, "tmp-d"));
		expect(job.status).toBe("done");
		expect(job.warning).toContain("AI translation failed, deu not translated: Subtitle translation is enabled but");
		expect((await tracks(job.inputPath)).map((t) => t.language)).toEqual(["eng", "slv"]);
	}, 60_000);

	it("still fails when nothing was downloaded and the AI provider fails", async () => {
		const job = await translateJob("no-download", { ...deadAi, translateTargetLanguages: ["deu"] }, join(root, "tmp-e"));
		expect(job.status).toBe("error");
		expect(job.error).toContain("Subtitle translation is enabled but");
		expect(job.warning).toBeUndefined();
	}, 60_000);

	it("downloads without a source track and warns about the languages left out", async () => {
		const job = await translateJob("no-source", { ...deadAi, translateSourceMatch: { language: "jpn", type: "full" } }, join(root, "tmp-f"));
		expect(job.status).toBe("done");
		expect(job.warning).toBe('deu not added: no good subtitle to download, and there is no full text subtitle track in "jpn" to translate from');
		expect((await tracks(job.inputPath)).map((t) => t.language)).toEqual(["eng", "slv"]);
	}, 60_000);

	it("styles subtitles added from Subtitle search and attaches their font", async () => {
		const folder = join(root, "add");
		mkdirSync(join(folder, "work"), { recursive: true });
		const video = join(folder, "Movie.mkv");
		await run(["mkvmerge", "-q", "-o", video, join(root, "plain.mkv"), "--language", "0:eng", join(root, "eng.srt")]);
		// Long, repetitive lines, so zlib pays off and the probe turns it on.
		writeFileSync(join(folder, "work", "slv.srt"), srt(cues, "Slovenska vrstica ".repeat(12)));
		const job = {
			id: "add",
			kind: "subtitles",
			filename: "Movie.mkv",
			inputPath: video,
			relativePath: "",
			status: "queued",
			progress: 0,
			queueOrder: 1,
			currentStage: "",
			steps: [],
			replaceSource: true,
			settings: {
				...getDefaultJobSettings(),
				convertSrtToAss: true,
				fontGroup: "Noto Sans",
				subtitleLanguagePriority: ["eng", "slv", "*"],
				compressSubtitles: true,
				compressSubtitlesMinSavings: 0,
			},
			subtitleAddPlan: {
				targetPath: video,
				workDir: join(folder, "work"),
				tracks: [{ file: join(folder, "work", "slv.srt"), language: "slv", trackName: "Full Subtitles [OpenSubtitles]", hearingImpaired: false }],
			},
		} as Job;
		const config = { tempDir: join(root, "tmp-add"), outputDir: join(root, "out"), recycleBinDir: "", organization: "RabbitCompany" } as AppConfig;
		await runSubtitleAddJob(job, config, (partial) => Object.assign(job, partial));
		expect(job.error).toBeUndefined();
		expect(await tracks(video)).toEqual([
			{ language: "eng", name: undefined, codec: "SubRip/SRT" },
			{ language: "slv", name: "Full Subtitles [OpenSubtitles]", codec: "SubStationAlpha" },
		]);
		expect(await fonts(video)).toEqual(["noto_sans.ttf"]);
		const info = JSON.parse((await run(["mkvmerge", "-J", video])).stdout);
		// mkvmerge reports zlib as content encoding algorithm 0.
		expect(info.tracks.find((t: any) => t.properties.language === "slv").properties.content_encoding_algorithms).toBe("0");
	}, 60_000);

	it("remembers a used up quota and still finishes the job", async () => {
		quotaUsedUp = true;
		calls.length = 0;
		const first = await translateJob("quota-a", {}, join(root, "tmp-b"));
		expect(first.status).toBe("done");
		expect(first.steps[1]!.detail).toBe("Nothing to add");
		expect(calls.filter((c) => c.includes("/download"))).toHaveLength(1);
		// The next episode does not ask again while the quota is used up.
		const second = await translateJob("quota-b", {}, join(root, "tmp-c"));
		expect(second.status).toBe("done");
		expect(calls.filter((c) => c.includes("/download"))).toHaveLength(1);
		await Bun.sleep(500);
	}, 60_000);
});
