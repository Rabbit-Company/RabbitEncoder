import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { inflateSync } from "zlib";
import { getDefaultJobSettings } from "../../src/core/config";
import { run } from "../../src/core/process";
import type { AppConfig, Job, JobSettings } from "../../src/core/types";
import { cleanOcrText } from "../../src/ocr/ocr";
import { addedDefaults } from "../../src/translate/translate-step";
import { decodeRle, parsePgs } from "../../src/ocr/pgs";
import { encodeGrayPng } from "../../src/ocr/png";
import { runTranslateOnlyJob } from "../../src/pipeline/translate-only";
import { runSubtitleAddJob } from "../../src/pipeline/subtitle-add";
import type { SubtitleOcrRequest } from "../../src/core/types";
import { buildPgs, type PgsBitmap } from "../fixtures/pgs";

const hasTools = ["ffmpeg", "ffprobe", "mkvmerge"].every((tool) => Bun.which(tool));

/** White bars on a transparent background with a black outline, `bars` of them, so bitmaps differ. */
function bars(bars: number): PgsBitmap {
	const width = 40 + bars * 30;
	const height = 40;
	const luma = new Uint8Array(width * height);
	const alpha = new Uint8Array(width * height);
	for (let y = 4; y < 36; y++)
		for (let x = 4; x < width - 4; x++) {
			const inBar = (x - 4) % 30 < 20 && y > 8 && y < 32;
			const i = y * width + x;
			alpha[i] = 255;
			luma[i] = inBar ? 235 : 16;
		}
	return { width, height, luma, alpha };
}

describe("PGS decoding", () => {
	it("decodes run-length rows", () => {
		// 2 pixels of colour 5, then 3 transparent, end of line, then a run of 4 of colour 7.
		const rle = new Uint8Array([5, 5, 0, 3, 0, 0, 0, 0x84, 7, 0, 0]);
		expect([...decodeRle(rle, 5, 2)]).toEqual([5, 5, 0, 0, 0, 7, 7, 7, 7, 0]);
	});

	it("reads cues, merges fades and draws text black on white", () => {
		const sup = buildPgs([
			{ startMs: 1000, endMs: 2500, bitmap: bars(2), fadeIn: true },
			{ startMs: 3000, endMs: 4000, bitmap: bars(3) },
			{ startMs: 5000, endMs: 6000, bitmap: bars(2) },
		]);
		const images = parsePgs(sup);
		expect(images.map((i) => [i.startMs, i.endMs])).toEqual([
			[1000, 2500],
			[3000, 4000],
			[5000, 6000],
		]);
		expect(images[0]!.hash).toBe(images[2]!.hash);
		expect(images[0]!.hash).not.toBe(images[1]!.hash);
		// The outline turns into paper and the bars into ink.
		const image = images[0]!;
		const at = (x: number, y: number) => image.pixels[y * image.width + x]!;
		expect(at(12 + 6, 12 + 6)).toBeGreaterThan(230);
		expect(at(12 + 10, 12 + 20)).toBeLessThan(40);
		expect(at(0, 0)).toBe(255);
	});

	it("writes a valid grayscale PNG", () => {
		const pixels = new Uint8Array([0, 128, 255, 64, 32, 16]);
		const png = Buffer.from(encodeGrayPng(pixels, 3, 2));
		expect(png.subarray(1, 4).toString()).toBe("PNG");
		expect(png.readUInt32BE(16)).toBe(3);
		expect(png.readUInt32BE(20)).toBe(2);
		const idatLength = png.readUInt32BE(33);
		const raw = inflateSync(png.subarray(41, 41 + idatLength));
		expect([...raw]).toEqual([0, 0, 128, 255, 0, 64, 32, 16]);
	});
});

describe("addedDefaults", () => {
	const stream = (index: number, language: string, extra: Record<string, unknown> = {}) => ({ index, codec: "hdmv_pgs_subtitle", language, ...extra });
	it("makes an added track the default only when nothing kept of its language is", () => {
		expect([...addedDefaults([stream(2, "eng")], [{ language: "eng", trackType: "full" }])]).toEqual([]);
		expect([...addedDefaults([], [{ language: "eng", trackType: "full" }])]).toEqual([0]);
		// A forced track is never the default, so it leaves the language without one.
		expect([...addedDefaults([stream(3, "eng", { isForced: true })], [{ language: "eng", trackType: "full" }])]).toEqual([0]);
		// An SDH track of the language already is, so a downloaded full track does not make it two.
		expect([...addedDefaults([stream(4, "slv", { isHearingImpaired: true, title: "SDH" })], [{ language: "sl", trackType: "full" }])]).toEqual([]);
	});

	it("prefers full to SDH, never picks forced tracks, and gives the most used languages a default too", () => {
		const added = [
			{ language: "slv", trackType: "sdh" },
			{ language: "slv", trackType: "full" },
			{ language: "ger", trackType: "forced" },
			{ language: "spa", trackType: "full", extra: true },
			{ language: "fre", trackType: "sdh" },
		];
		expect([...addedDefaults([], added)].sort()).toEqual([1, 3, 4]);
	});
});

describe("cleanOcrText", () => {
	it("keeps text, line breaks and italics", () => {
		expect(cleanOcrText("Čaša vode, prosim.\nKaj počneš?")).toBe("Čaša vode, prosim.\nKaj počneš?");
		expect(cleanOcrText("<p>Hello<br/><em>there</em> &amp; you</p>")).toBe("Hello\n<i>there</i> & you");
		expect(cleanOcrText('```\n"Where are you?"\n```')).toBe("Where are you?");
		expect(cleanOcrText("*I know.*")).toBe("<i>I know.</i>");
		expect(cleanOcrText('Subtitle: He said "run" and left.')).toBe('He said "run" and left.');
	});
});

(hasTools ? describe : describe.skip)("OCR in translate jobs", () => {
	const root = mkdtempSync(join(tmpdir(), "rabbit-ocr-"));
	const realFetch = globalThis.fetch;
	const ocrRequests: Array<{ image: string; prompt: string }> = [];
	const cues = [
		{ startMs: 2000, endMs: 3500, bitmap: bars(2) },
		{ startMs: 4000, endMs: 5200, bitmap: bars(3) },
		{ startMs: 6000, endMs: 7000, bitmap: bars(2) },
		{ startMs: 8000, endMs: 9000, bitmap: bars(4) },
	];

	beforeAll(async () => {
		writeFileSync(join(root, "eng.sup"), buildPgs(cues));
		const a = await run([
			"ffmpeg",
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"color=c=gray:s=32x32:r=1:d=12",
			"-f",
			"lavfi",
			"-i",
			"anullsrc=r=8000:cl=mono:d=12",
			"-c:v",
			"ffv1",
			"-c:a",
			"flac",
			"-t",
			"12",
			join(root, "plain.mkv"),
		]);
		if (a.code !== 0) throw new Error(a.stderr);
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			if (url.hostname === "127.0.0.1") throw new TypeError("Unable to connect");
			if (url.pathname === "/v1/chat/completions") {
				const content = JSON.parse(String(init?.body)).messages[0].content as any[];
				const image = content.find((c) => c.type === "image_url").image_url.url as string;
				const prompt = content.find((c) => c.type === "text").text as string;
				ocrRequests.push({ image, prompt });
				return Response.json({ choices: [{ message: { content: `<p>Line ${ocrRequests.length}</p>` }, finish_reason: "stop" }] });
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch;
	}, 60_000);

	afterAll(() => {
		globalThis.fetch = realFetch;
		rmSync(root, { recursive: true, force: true });
	});

	async function job(name: string, settings: Partial<JobSettings>): Promise<Job> {
		const folder = join(root, name);
		mkdirSync(folder, { recursive: true });
		const video = join(folder, "Movie.mkv");
		const b = await run(["mkvmerge", "-q", "-o", video, join(root, "plain.mkv"), "--language", "0:eng", "--track-name", "0:English", join(root, "eng.sup")]);
		if (b.code !== 0 && b.code !== 1) throw new Error(b.stderr || b.stdout);
		const job = {
			id: name,
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
				subtitleProcessing: "translate",
				translateSubtitles: true,
				translateSourceTrack: "auto",
				translateSourceMatch: { language: "eng", type: "full" },
				ocrPictureSubtitles: true,
				ocrBaseUrl: "http://ocr.example/v1",
				ocrModel: "surya",
				...settings,
			},
		} as Job;
		const config = { tempDir: join(root, `tmp-${name}`), outputDir: join(root, "out"), recycleBinDir: "", organization: "RabbitCompany" } as AppConfig;
		mkdirSync(config.tempDir, { recursive: true });
		await runTranslateOnlyJob(job, config, (partial) => Object.assign(job, partial));
		return job;
	}

	it("adds the text of a picture track, reading each picture once", async () => {
		const done = await job("read", { translateTargetLanguages: ["eng"], translateBaseUrl: "http://127.0.0.1:9/v1" });
		// English is a target, and the text read from its picture track covers it without AI.
		expect(done.error).toBeUndefined();
		expect(done.status).toBe("done");
		expect(done.steps[1]!.detail).toBe("Read 1 with OCR track(s)");
		expect(ocrRequests).toHaveLength(3);
		expect(ocrRequests[0]!.image.startsWith("data:image/png;base64,iVBOR")).toBe(true);
		expect(ocrRequests[0]!.prompt).toContain("in English");

		const info = JSON.parse((await run(["mkvmerge", "-J", done.inputPath])).stdout);
		const subs = (info.tracks as any[]).filter((t) => t.type === "subtitles");
		// Text comes before pictures of the same language, as for native tracks.
		expect(subs.map((t) => [t.codec, t.properties.track_name])).toEqual([
			["SubRip/SRT", "Full Subtitles [OCR]"],
			["HDMV PGS", "English"],
		]);
		const out = join(root, "read.srt");
		await run(["mkvextract", done.inputPath, "tracks", `${subs[0].id}:${out}`]);
		const srt = readFileSync(out, "utf-8");
		expect(srt).toContain("00:00:02,000 --> 00:00:03,500\nLine 1");
		expect(srt).toContain("00:00:06,000 --> 00:00:07,000\nLine 1");
		expect(srt.match(/-->/g)).toHaveLength(4);
	}, 60_000);

	async function ocrTool(name: string, ocr: SubtitleOcrRequest): Promise<Job> {
		const folder = join(root, name);
		mkdirSync(join(folder, "work"), { recursive: true });
		const video = join(folder, "Movie.mkv");
		await run(["mkvmerge", "-q", "-o", video, join(root, "plain.mkv"), "--language", "0:eng", "--track-name", "0:English", join(root, "eng.sup")]);
		const job = {
			id: name,
			kind: "subtitles",
			filename: "OCR: Movie.mkv",
			inputPath: video,
			relativePath: "",
			status: "queued",
			progress: 0,
			queueOrder: 1,
			currentStage: "",
			steps: [],
			replaceSource: true,
			settings: { ...getDefaultJobSettings(), ocrBaseUrl: "http://ocr.example/v1", ocrModel: "surya" },
			subtitleAddPlan: { targetPath: video, workDir: join(folder, "work"), tracks: [], ocr },
		} as Job;
		const config = { tempDir: join(root, `tmp-${name}`), outputDir: join(root, "out"), recycleBinDir: "", organization: "RabbitCompany" } as AppConfig;
		await runSubtitleAddJob(job, config, (partial) => Object.assign(job, partial));
		return job;
	}

	async function subtitleTracks(path: string) {
		const info = JSON.parse((await run(["mkvmerge", "-J", path])).stdout);
		return (info.tracks as any[]).filter((t) => t.type === "subtitles").map((t) => [t.codec, t.properties.track_name, t.properties.default_track]);
	}

	it("reads a chosen picture track from the Subtitles menu and can remove it", async () => {
		const done = await ocrTool("tool", { streams: [2], removePictures: true });
		expect(done.error).toBeUndefined();
		expect(done.steps.map((s) => s.label)).toEqual(["Read Subtitles", "Mux", "Write Output"]);
		// With the picture track gone, the text is the only English subtitle, so it is the default.
		expect(await subtitleTracks(done.inputPath)).toEqual([["SubRip/SRT", "Full Subtitles [OCR]", true]]);
	}, 60_000);

	it("reads picture tracks by language for folder jobs, and leaves files without them alone", async () => {
		const english = await ocrTool("tool-eng", { languages: ["en"] });
		expect(english.status).toBe("done");
		// The picture track stays and keeps the default, so the text does not take it too.
		expect((await subtitleTracks(english.inputPath)).map((t) => [t[0], t[2]])).toEqual([
			["SubRip/SRT", false],
			["HDMV PGS", true],
		]);
		const german = await ocrTool("tool-ger", { languages: ["deu"] });
		expect(german.status).toBe("done");
		expect(german.steps[0]!.detail).toBe("No picture subtitles to read");
		expect((await subtitleTracks(german.inputPath)).map((t) => t[0])).toEqual(["HDMV PGS"]);
	}, 60_000);

	it("translates from the text read from a picture track", async () => {
		const done = await job("source", { translateTargetLanguages: ["slv"], translateBaseUrl: "http://127.0.0.1:9/v1", translateTimeoutMs: 2000 });
		// The translation reached the AI provider, which only happens with a text source. It is down, so the OCR track is kept.
		expect(done.status).toBe("done");
		expect(done.warning).toContain("AI translation failed, slv not translated");
		expect(done.steps[1]!.detail).toBe("Read 1 with OCR track(s)");
	}, 60_000);
});

(hasTools ? describe : describe.skip)("OCR from an original into its encode", () => {
	const root = mkdtempSync(join(tmpdir(), "rabbit-ocr-original-"));
	const realFetch = globalThis.fetch;
	let state = 5;
	const rand = () => (state = (state * 16807) % 2147483647) / 2147483647;
	const timeline = (count: number) => {
		const out: Array<{ startMs: number; endMs: number }> = [];
		let t = 3000;
		for (let i = 0; i < count; i++) {
			const length = 900 + Math.round(rand() * 1500);
			out.push({ startMs: t, endMs: t + length });
			t += length + 300 + Math.round(rand() * 2500);
		}
		return out;
	};
	const cues = timeline(100);
	const duration = Math.ceil(cues[cues.length - 1]!.endMs / 1000) + 5;
	const srt = (list: Array<{ startMs: number; endMs: number }>, shift = 0) => {
		const tc = (ms: number) => {
			const p = (n: number, w = 2) => String(Math.floor(n)).padStart(w, "0");
			return `${p(ms / 3_600_000)}:${p((ms / 60_000) % 60)}:${p((ms / 1000) % 60)},${p(ms % 1000, 3)}`;
		};
		return list.map((c, i) => `${i + 1}\n${tc(c.startMs + shift)} --> ${tc(c.endMs + shift)}\nLine ${i}\n`).join("\n");
	};

	beforeAll(async () => {
		writeFileSync(join(root, "slv.sup"), buildPgs(cues.map((c, i) => ({ ...c, bitmap: bars(1 + (i % 5)) }))));
		writeFileSync(join(root, "shifted.srt"), srt(cues, -1200));
		writeFileSync(join(root, "other.srt"), srt(timeline(100)));
		const plain = join(root, "plain.mkv");
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
			plain,
		]);
		if (a.code !== 0) throw new Error(a.stderr);
		await run(["mkvmerge", "-q", "-o", join(root, "original.mkv"), plain, "--language", "0:slv", join(root, "slv.sup")]);
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = new URL(String(input));
			if (url.pathname === "/v1/chat/completions") return Response.json({ choices: [{ message: { content: "Vrstica" }, finish_reason: "stop" }] });
			return new Response("not found", { status: 404 });
		}) as typeof fetch;
	}, 60_000);

	afterAll(() => {
		globalThis.fetch = realFetch;
		rmSync(root, { recursive: true, force: true });
	});

	async function readInto(name: string, englishSrt: string): Promise<Job> {
		const folder = join(root, name);
		mkdirSync(join(folder, "work"), { recursive: true });
		const encode = join(folder, "Encode.mkv");
		await run(["mkvmerge", "-q", "-o", encode, join(root, "plain.mkv"), "--language", "0:eng", join(root, englishSrt)]);
		const job = {
			id: name,
			kind: "subtitles",
			filename: "OCR: Encode.mkv",
			inputPath: encode,
			relativePath: "",
			status: "queued",
			progress: 0,
			queueOrder: 1,
			currentStage: "",
			steps: [],
			replaceSource: true,
			settings: { ...getDefaultJobSettings(), ocrBaseUrl: "http://ocr.example/v1", ocrModel: "surya" },
			subtitleAddPlan: { targetPath: encode, workDir: join(folder, "work"), tracks: [], ocr: { sourcePath: join(root, "original.mkv") } },
		} as Job;
		const config = { tempDir: join(root, `tmp-${name}`), outputDir: join(root, "out"), recycleBinDir: "", organization: "RabbitCompany" } as AppConfig;
		await runSubtitleAddJob(job, config, (partial) => Object.assign(job, partial));
		return job;
	}

	it("reads the original's pictures into the encode and shifts them to its timing", async () => {
		const done = await readInto("shifted", "shifted.srt");
		expect(done.error).toBeUndefined();
		expect(done.status).toBe("done");
		expect(done.steps[0]!.detail).toBe("Read 1 track(s), shifted to fit the video (-1.20 s)");
		const info = JSON.parse((await run(["mkvmerge", "-J", done.inputPath])).stdout);
		const added = (info.tracks as any[]).find((t) => t.type === "subtitles" && t.properties.language === "slv");
		expect(added.properties.track_name).toBe("Full Subtitles [OCR]");
		expect(added.properties.default_track).toBe(true);
		const out = join(root, "shifted-out.srt");
		await run(["mkvextract", done.inputPath, "tracks", `${added.id}:${out}`]);
		const first = readFileSync(out, "utf-8").match(/(\d{2}):(\d{2}):(\d{2}),(\d{3}) -->/)!;
		const ms = Number(first[1]) * 3_600_000 + Number(first[2]) * 60_000 + Number(first[3]) * 1000 + Number(first[4]);
		expect(Math.abs(ms - (cues[0]!.startMs - 1200))).toBeLessThanOrEqual(20);
	}, 60_000);

	it("adds nothing when the original belongs to another video", async () => {
		const done = await readInto("other", "other.srt");
		expect(done.status).toBe("error");
		expect(done.error).toContain("do not match the video's timing");
		const info = JSON.parse((await run(["mkvmerge", "-J", done.inputPath])).stdout);
		expect((info.tracks as any[]).filter((t) => t.type === "subtitles")).toHaveLength(1);
	}, 60_000);
});
