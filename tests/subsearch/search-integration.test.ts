import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { run } from "../../src/core/process";
import { buildZip } from "../../src/core/zip";
import { probeFile } from "../../src/pipeline/probe";
import { getDefaultJobSettings } from "../../src/core/config";
import { dialogueCues, type Interval } from "../../src/subsearch/cues";
import { buildReference } from "../../src/subsearch/reference";
import { searchSubtitles, tryCandidate } from "../../src/subsearch/search";

const hasTools = ["ffmpeg", "ffprobe", "mkvmerge"].every((tool) => Bun.which(tool));

function timeline(count: number, seed: number): Interval[] {
	let state = seed;
	const rand = () => (state = (state * 16807) % 2147483647) / 2147483647;
	const out: Interval[] = [];
	let t = 3000;
	for (let i = 0; i < count; i++) {
		const len = 800 + Math.round(rand() * 800);
		out.push({ startMs: t, endMs: t + len });
		t += len + 300 + Math.round(rand() * 900);
	}
	return out;
}

/** PGS with one small picture per cue, shown at its start and cleared at its end. */
function pgs(cues: Interval[]): Buffer {
	const u16 = (n: number) => Buffer.from([n >> 8, n & 255]);
	const segment = (ms: number, type: number, payload: Buffer) => {
		const header = Buffer.alloc(13);
		header.write("PG");
		header.writeUInt32BE(Math.round(ms * 90), 2);
		header[10] = type;
		header.writeUInt16BE(payload.length, 11);
		return Buffer.concat([header, payload]);
	};
	const composition = (number: number, show: boolean) =>
		Buffer.concat([
			u16(640),
			u16(360),
			Buffer.from([0x10]),
			u16(number),
			Buffer.from([0x80, 0, 0, show ? 1 : 0]),
			...(show ? [u16(0), Buffer.from([0, 0]), u16(220), u16(300)] : []),
		]);
	const rle = Buffer.concat(Array.from({ length: 40 }, () => Buffer.from([0, 0xc0, 200, 1, 0, 0])));
	const parts: Buffer[] = [];
	cues.forEach((cue, i) => {
		parts.push(
			segment(cue.startMs, 0x16, composition(i * 2 + 1, true)),
			segment(cue.startMs, 0x17, Buffer.concat([Buffer.from([1, 0]), u16(220), u16(300), u16(200), u16(40)])),
			segment(cue.startMs, 0x14, Buffer.from([0, 0, 0, 16, 128, 128, 0, 1, 235, 128, 128, 255])),
			segment(cue.startMs, 0x15, Buffer.concat([u16(0), Buffer.from([0, 0xc0, 0, (rle.length + 4) >> 8, (rle.length + 4) & 255]), u16(200), u16(40), rle])),
			segment(cue.startMs, 0x80, Buffer.alloc(0)),
			segment(cue.endMs, 0x16, composition(i * 2 + 2, false)),
			segment(cue.endMs, 0x80, Buffer.alloc(0)),
		);
	});
	return Buffer.concat(parts);
}

function srt(cues: Interval[], shiftMs = 0): string {
	const tc = (ms: number) => {
		const p = (n: number, w = 2) => String(Math.floor(n)).padStart(w, "0");
		return `${p(ms / 3_600_000)}:${p((ms / 60_000) % 60)}:${p((ms / 1000) % 60)},${p(ms % 1000, 3)}`;
	};
	return cues.map((c, i) => `${i + 1}\n${tc(c.startMs + shiftMs)} --> ${tc(c.endMs + shiftMs)}\nČrta številka ${i}\n`).join("\n");
}

(hasTools ? describe : describe.skip)("subtitle search on a real file", () => {
	const root = mkdtempSync(join(tmpdir(), "rabbit-subsearch-int-"));
	const video = join(root, "The.Matrix.1999.1080p.BluRay.x264-GROUP.mkv");
	const cues = timeline(100, 11);
	const realFetch = globalThis.fetch;
	const downloads: number[] = [];
	const subdlDownloads: string[] = [];
	let userChecks = 0;

	beforeAll(async () => {
		const duration = Math.ceil(cues[cues.length - 1]!.endMs / 1000) + 5;
		writeFileSync(join(root, "sub.sup"), pgs(cues));
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
		const b = await run(["mkvmerge", "-q", "-o", video, join(root, "plain.mkv"), "--language", "0:eng", join(root, "sub.sup")]);
		if (b.code !== 0 && b.code !== 1) throw new Error(b.stderr || b.stdout);

		const files: Record<number, Uint8Array> = {
			101: new TextEncoder().encode(srt(timeline(100, 77))),
			// Windows-1250, as old Slovenian subtitles are.
			102: new Uint8Array([...srt(cues, 1800)].map((ch) => ({ Č: 0xc8, š: 0x9a, ž: 0x9e })[ch as "Č"] ?? ch.charCodeAt(0))),
			103: new TextEncoder().encode(srt(cues)),
			201: new TextEncoder().encode(srt(cues)),
		};
		const item = (fileId: number, language: string, release: string, downloads: number, extra: Record<string, unknown> = {}) => ({
			id: String(fileId),
			attributes: {
				language,
				release,
				download_count: downloads,
				files: [{ file_id: fileId, file_name: `${release}.srt` }],
				url: `https://example/${fileId}`,
				...extra,
			},
		});
		const encoder = new TextEncoder();
		const subdlFiles: Record<string, Uint8Array> = {
			"/subtitle/500-501.zip": buildZip([
				{ name: "The.Matrix.1999.1080p.BluRay.x264-SD.sl.srt", data: encoder.encode(srt(cues, -2500)) },
				{ name: "readme.nfo", data: encoder.encode("nothing") },
			]),
			"/subtitle/500-502.zip": buildZip([{ name: "Wrong.srt", data: encoder.encode(srt(timeline(100, 99))) }]),
		};
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			if (url.hostname === "api.subdl.com") {
				expect(url.pathname).toBe("/api/v1/subtitles");
				expect(url.searchParams.get("api_key")).toBe("sdkey");
				expect(url.searchParams.get("film_name")?.toLowerCase()).toBe("the matrix");
				expect(url.searchParams.get("type")).toBe("movie");
				expect(url.searchParams.get("languages")).toBe("SL");
				return Response.json({
					status: true,
					results: [{ name: "The Matrix", type: "movie", year: 1999 }],
					subtitles: [
						{
							release_name: "The.Matrix.1999.1080p.BluRay.x264-GROUP",
							name: "SUBDL.matrix.zip",
							url: "/subtitle/500-502.zip",
							language: "SL",
							hi: false,
							author: "someone",
						},
						{
							release_name: "The.Matrix.1999.1080p.BluRay.x264-SD",
							name: "SUBDL.matrix.zip",
							url: "/subtitle/500-501.zip",
							language: "SL",
							hi: false,
							author: "sduser",
							subtitlePage: "/s/info/x/y",
						},
					],
				});
			}
			if (url.hostname === "dl.subdl.com") {
				subdlDownloads.push(url.pathname);
				const bytes = subdlFiles[url.pathname];
				return bytes ? new Response(Buffer.from(bytes)) : new Response("not found", { status: 404 });
			}
			if (url.pathname === "/api/v1/login") return Response.json({ token: "tok", base_url: "api.opensubtitles.com" });
			if (url.pathname === "/api/v1/infos/user") {
				userChecks++;
				return Response.json({ data: { username: "rabbit", remaining_downloads: 50, allowed_downloads: 1000 } });
			}
			if (url.pathname === "/api/v1/subtitles") {
				expect(url.searchParams.get("query")).toBe("the matrix");
				expect(url.searchParams.get("year")).toBe("1999");
				return Response.json({
					total_pages: 1,
					data: [
						// Ranked first on its release name and downloads, but made for something else.
						item(101, "sl", "The.Matrix.1999.1080p.BluRay.x264-GROUP", 90_000),
						item(102, "sl", "The.Matrix.1999.1080p.BluRay.x264-OTHER", 3000),
						item(103, "sl", "The.Matrix.1999.1080p.BluRay", 50_000, { machine_translated: true }),
						item(201, "en", "The.Matrix.1999.1080p.BluRay.x264-GROUP", 10_000),
					],
				});
			}
			if (url.pathname === "/api/v1/download") {
				if (new Headers(init?.headers).get("Authorization") !== "Bearer tok") return new Response("{}", { status: 401 });
				const fileId = JSON.parse(String(init?.body)).file_id as number;
				downloads.push(fileId);
				return Response.json({ link: `https://dl.example/${fileId}`, file_name: `${fileId}.srt`, remaining: 20 - downloads.length });
			}
			if (url.hostname === "dl.example") return new Response(Buffer.from(files[Number(url.pathname.slice(1))]!));
			return new Response("not found", { status: 404 });
		}) as typeof fetch;
	}, 60_000);

	afterAll(() => {
		globalThis.fetch = realFetch;
		rmSync(root, { recursive: true, force: true });
	});

	it("reads the display times of picture subtitles", async () => {
		const workDir = join(root, "ref");
		mkdirSync(workDir, { recursive: true });
		const reference = await buildReference(video, await probeFile(video), workDir);
		expect(reference?.kind).toBe("bitmap");
		expect(reference!.intervals).toHaveLength(cues.length);
		reference!.intervals.forEach((interval, i) => {
			expect(Math.abs(interval.startMs - cues[i]!.startMs)).toBeLessThanOrEqual(2);
			expect(Math.abs(interval.endMs - cues[i]!.endMs)).toBeLessThanOrEqual(2);
		});
	});

	it("downloads, syncs and picks the right subtitle per language", async () => {
		const workDir = join(root, "search");
		mkdirSync(workDir, { recursive: true });
		const result = await searchSubtitles({
			inputPath: video,
			probe: await probeFile(video),
			languages: ["slv", "eng"],
			settings: { ...getDefaultJobSettings(), openSubtitlesUsername: "rabbit", openSubtitlesPassword: "secret", subtitleDownloadMaxTries: 3 },
			cacheDir: root,
			workDir,
		});
		expect(result.reference?.kind).toBe("bitmap");
		const [sl, en] = result.languages;
		expect(sl!.bestKey).toBe("os-102");
		const byKey = Object.fromEntries(sl!.candidates.map((c) => [c.key, c]));
		expect(byKey["os-103"]!.status).toBe("excluded");
		expect(downloads.slice(0, 2)).toEqual([101, 102]);
		expect(byKey["os-101"]!.rating!).toBeLessThan(40);
		expect(byKey["os-102"]!.rating!).toBeGreaterThanOrEqual(85);
		expect(Math.abs(byKey["os-102"]!.offsetMs! + 1800)).toBeLessThanOrEqual(20);
		const synced = readFileSync(join(workDir, "os-102.srt"), "utf-8");
		expect(synced).toContain("Črta številka 0");
		expect(Math.abs(dialogueCues({ format: "srt", content: synced })[50]!.startMs - cues[50]!.startMs)).toBeLessThanOrEqual(20);
		expect(en!.bestKey).toBe("os-201");
		expect(result.remainingDownloads).toBe(20 - downloads.length);
		expect(downloads).not.toContain(103);

		// A second search reuses the downloaded files.
		const before = downloads.length;
		await searchSubtitles({
			inputPath: video,
			probe: await probeFile(video),
			languages: ["slv"],
			settings: { ...getDefaultJobSettings(), openSubtitlesUsername: "rabbit", openSubtitlesPassword: "secret" },
			cacheDir: root,
			workDir,
		});
		expect(downloads.length).toBe(before);
	}, 60_000);

	it("tries a candidate the search did not get to and picks it when it rates best", async () => {
		const workDir = join(root, "search-try");
		mkdirSync(workDir, { recursive: true });
		const result = await searchSubtitles({
			inputPath: video,
			probe: await probeFile(video),
			languages: ["slv"],
			settings: { ...getDefaultJobSettings(), openSubtitlesUsername: "rabbit", openSubtitlesPassword: "secret", subtitleDownloadMaxTries: 1 },
			cacheDir: workDir,
			workDir,
		});
		const sl = result.languages[0]!;
		expect(sl.bestKey).toBeUndefined();
		expect(sl.note).toContain("below the minimum");
		const other = sl.candidates.find((c) => c.key === "os-102")!;
		expect(other.status).toBe("untested");

		const tried = await tryCandidate(result, "slv", "os-102");
		expect(tried.status).toBe("rated");
		expect(sl.bestKey).toBe("os-102");
		expect(sl.note).toBeUndefined();
		await expect(tryCandidate(result, "slv", "os-102")).rejects.toThrow("already tried");
	}, 60_000);

	it("downloads preferred sources first and picks them once they pass the minimum", async () => {
		const workDir = join(root, "search-preferred");
		mkdirSync(workDir, { recursive: true });
		const settings = { ...getDefaultJobSettings(), openSubtitlesUsername: "rabbit", openSubtitlesPassword: "secret" };
		const first = downloads.length;
		const result = await searchSubtitles({
			inputPath: video,
			probe: await probeFile(video),
			languages: ["slv"],
			settings: { ...settings, subtitleDownloadMaxTries: 1, subtitleDownloadPreferredSources: ["GROUP"] },
			preferredSources: ["OTHER"],
			cacheDir: workDir,
			workDir,
		});
		expect(downloads.slice(first)).toEqual([102]);
		const sl = result.languages[0]!;
		expect(sl.candidates[0]!.key).toBe("os-102");
		expect(sl.candidates[0]!.preferred).toBe(0);
		expect(sl.bestKey).toBe("os-102");

		// A preferred source wins over a better rating, as long as it reaches the minimum.
		const picked = await searchSubtitles({
			inputPath: video,
			probe: await probeFile(video),
			languages: ["slv"],
			settings: { ...settings, subtitleDownloadMaxTries: 2, subtitleDownloadMinScore: 0, subtitleDownloadPreferredSources: ["GROUP"] },
			cacheDir: workDir,
			workDir,
		});
		expect(picked.languages[0]!.bestKey).toBe("os-101");
		const strict = await searchSubtitles({
			inputPath: video,
			probe: await probeFile(video),
			languages: ["slv"],
			settings: { ...settings, subtitleDownloadMaxTries: 2, subtitleDownloadPreferredSources: ["GROUP"] },
			cacheDir: workDir,
			workDir,
		});
		expect(strict.languages[0]!.bestKey).toBe("os-102");
	}, 60_000);

	it("adds extra languages after the chosen ones once the quota allows it", async () => {
		const workDir = join(root, "search-extra");
		mkdirSync(workDir, { recursive: true });
		const result = await searchSubtitles({
			inputPath: video,
			probe: await probeFile(video),
			languages: ["slv"],
			extraLanguages: ["eng"],
			settings: { ...getDefaultJobSettings(), openSubtitlesUsername: "rabbit", openSubtitlesPassword: "secret" },
			cacheDir: root,
			workDir,
		});
		expect(userChecks).toBe(1);
		expect(result.languages.map((l) => [l.language, !!l.extra])).toEqual([
			["slv", false],
			["eng", true],
		]);
		expect(result.languages[1]!.bestKey).toBe("os-201");
	}, 60_000);

	it("searches SubDL on its own and takes the subtitle out of its archive", async () => {
		const workDir = join(root, "search-subdl");
		mkdirSync(workDir, { recursive: true });
		const result = await searchSubtitles({
			inputPath: video,
			probe: await probeFile(video),
			languages: ["slv"],
			settings: { ...getDefaultJobSettings(), subdlApiKey: "sdkey", subtitleDownloadMaxTries: 2 },
			cacheDir: workDir,
			workDir,
		});
		const sl = result.languages[0]!;
		expect(sl.candidates.every((c) => c.provider === "subdl")).toBe(true);
		expect(sl.bestKey).toBe("sd-500-501");
		const best = sl.candidates.find((c) => c.key === "sd-500-501")!;
		expect(best.url).toBe("https://subdl.com/s/info/x/y");
		expect(Math.abs(best.offsetMs! - 2500)).toBeLessThanOrEqual(20);
		expect(readFileSync(join(workDir, "sd-500-501.srt"), "utf-8")).toContain("Črta številka 0");
		expect(result.remainingDownloads).toBeUndefined();

		// The archive is cached, so a second search downloads nothing.
		const before = subdlDownloads.length;
		await searchSubtitles({
			inputPath: video,
			probe: await probeFile(video),
			languages: ["slv"],
			settings: { ...getDefaultJobSettings(), subdlApiKey: "sdkey", subtitleDownloadMaxTries: 2 },
			cacheDir: workDir,
			workDir,
		});
		expect(subdlDownloads.length).toBe(before);
	}, 60_000);

	it("pools the subtitles of both sites in one language", async () => {
		const workDir = join(root, "search-both");
		mkdirSync(workDir, { recursive: true });
		const result = await searchSubtitles({
			inputPath: video,
			probe: await probeFile(video),
			languages: ["slv"],
			settings: { ...getDefaultJobSettings(), openSubtitlesUsername: "rabbit", openSubtitlesPassword: "secret", subdlApiKey: "sdkey" },
			cacheDir: root,
			workDir,
		});
		const keys = result.languages[0]!.candidates.map((c) => c.key);
		expect(keys).toContain("os-102");
		expect(keys).toContain("sd-500-501");
	}, 60_000);
});
