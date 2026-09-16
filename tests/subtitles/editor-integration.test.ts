import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Web } from "@rabbit-company/web";
import type { AppConfig } from "../../src/core/types";
import { run } from "../../src/core/process";
import { registerSubtitleEditorRoutes } from "../../src/api/subtitle-editor";

const hasTools = ["ffmpeg", "ffprobe", "mkvmerge", "mkvextract"].every((tool) => Bun.which(tool));

// A real PGS display set: one white rectangle at 4s, cleared at 5s.
function pgsFixture(): Buffer {
	const u16 = (n: number) => Buffer.from([n >> 8, n & 255]);
	const segment = (seconds: number, type: number, payload: Buffer) => {
		const header = Buffer.alloc(13);
		header.write("PG");
		header.writeUInt32BE(seconds * 90_000, 2);
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
	return Buffer.concat([
		segment(4, 0x16, composition(1, true)),
		segment(4, 0x17, Buffer.concat([Buffer.from([1, 0]), u16(220), u16(300), u16(200), u16(40)])),
		segment(4, 0x14, Buffer.from([0, 0, 0, 16, 128, 128, 0, 1, 235, 128, 128, 255])),
		segment(4, 0x15, Buffer.concat([u16(0), Buffer.from([0, 0xc0, 0, (rle.length + 4) >> 8, (rle.length + 4) & 255]), u16(200), u16(40), rle])),
		segment(4, 0x80, Buffer.alloc(0)),
		segment(5, 0x16, composition(2, false)),
		segment(5, 0x80, Buffer.alloc(0)),
	]);
}

(hasTools ? test : test.skip)(
	"subtitle editor previews real text/PGS offsets and saves without changing video or audio",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "rabbit-editor-test-"));
		const command = async (args: string[]) => {
			const result = await run(args, { cwd: root });
			if (result.code !== 0 && !(args[0] === "mkvmerge" && result.code === 1)) throw new Error(result.stderr || result.stdout);
			return result.stdout;
		};
		try {
			writeFileSync(join(root, "sub.srt"), "1\n00:00:04,000 --> 00:00:05,000\nHello world\n");
			writeFileSync(
				join(root, "sub.ass"),
				`[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans,30,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:04.00,0:00:05.00,Default,,0,0,0,,{\\i1}Hello ASS{\\i0}
Dialogue: 0,0:00:07.00,0:00:07.00,Default,,0,0,0,,Zero-length dummy
`,
			);
			await command([
				"ffmpeg",
				"-v",
				"error",
				"-f",
				"lavfi",
				"-i",
				"color=black:s=640x360:r=24:d=10",
				"-f",
				"lavfi",
				"-i",
				"sine=frequency=440:duration=10",
				"-i",
				"sub.srt",
				"-map",
				"0:v",
				"-map",
				"1:a",
				"-map",
				"2:s",
				"-c:v",
				"libx264",
				"-preset",
				"ultrafast",
				"-c:a",
				"aac",
				"-c:s",
				"copy",
				"source.mkv",
			]);
			writeFileSync(join(root, "sub.sup"), pgsFixture());
			await command(["mkvmerge", "-o", "episode.mkv", "source.mkv", "sub.ass", "sub.sup"]);
			const path = join(root, "episode.mkv");
			const app = new Web();
			registerSubtitleEditorRoutes(app, { inputDir: root, outputDir: root, libraryDirs: [], tempDir: join(root, "temp") } as unknown as AppConfig);
			const inspect = await app.handle(new Request(`http://localhost/api/subtitle-editor/inspect?${new URLSearchParams({ path })}`));
			expect(inspect.status).toBe(200);
			const file = (await inspect.json()) as any;
			const base = { path, fingerprint: file.fingerprint };
			const post = (route: string, body: object) =>
				app.handle(
					new Request(`http://localhost/api/subtitle-editor/${route}`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ ...base, ...body }),
					}),
				);
			const brightness = async (name: string, seconds: number) => {
				await command([
					"ffmpeg",
					"-v",
					"error",
					"-y",
					"-ss",
					String(seconds),
					"-i",
					name,
					"-frames:v",
					"1",
					"-vf",
					"format=gray",
					"-f",
					"rawvideo",
					"frame.raw",
				]);
				const bytes = readFileSync(join(root, "frame.raw"));
				return bytes.reduce((total, byte) => total + byte, 0) / bytes.length;
			};
			const edits = [];
			for (const track of file.subtitles) {
				const loaded = await post("track", { trackId: track.id });
				expect(loaded.status).toBe(200);
				const data = (await loaded.json()) as any;
				expect(data.cues.length).toBeGreaterThan(0);
				if (data.format === "ass") expect(data.cues.some((cue: any) => cue.startMs === cue.endMs && cue.text === "Zero-length dummy")).toBe(true);
				if (data.format === "bitmap") {
					expect(data.cues).toHaveLength(1);
					expect(data.cues[0]).toMatchObject({ startMs: 4000, endMs: 5000 });
				}
				for (const offsetMs of data.format === "ass" ? [-1000, 0, 2000, 1, 300, 1000] : [-1000, 0, 2000]) {
					const response = await post("preview", { edit: { trackId: track.id, offsetMs, cues: [] }, startSeconds: 3, durationSeconds: 5 });
					if (response.status !== 200) throw new Error(await response.text());
					const clip = `preview-${track.id}-${offsetMs}.mp4`;
					writeFileSync(join(root, clip), Buffer.from(await response.arrayBuffer()));
					const bright = await brightness(clip, 1.5);
					const shift = data.format === "ass" ? Math.round(offsetMs / 10) / 100 : offsetMs / 1000;
					if (1.5 >= 1 + shift && 1.5 < 2 + shift) expect(bright).toBeGreaterThan(0.1);
					else expect(bright).toBeLessThan(0.05);
					expect(await brightness(clip, 1.5 + shift)).toBeGreaterThan(0.1);
					expect(await brightness(clip, 4.5)).toBeLessThan(0.05);
				}
				const crossing = await post("preview", { edit: { trackId: track.id, offsetMs: 0, cues: [] }, startSeconds: 4.5, durationSeconds: 2 });
				if (crossing.status !== 200) throw new Error(await crossing.text());
				writeFileSync(join(root, "crossing.mp4"), Buffer.from(await crossing.arrayBuffer()));
				expect(await brightness("crossing.mp4", 0.1)).toBeGreaterThan(0.1);
				expect(await brightness("crossing.mp4", 1)).toBeLessThan(0.05);
				if (data.format !== "bitmap") {
					const changed = await post("preview", {
						edit: { trackId: track.id, offsetMs: 0, cues: [{ ...data.cues[0], startMs: 5000, endMs: 6000, text: "Edited preview" }] },
						startSeconds: 3,
						durationSeconds: 4,
					});
					if (changed.status !== 200) throw new Error(await changed.text());
					writeFileSync(join(root, "changed.mp4"), Buffer.from(await changed.arrayBuffer()));
					expect(await brightness("changed.mp4", 1.5)).toBeLessThan(0.05);
					expect(await brightness("changed.mp4", 2.5)).toBeGreaterThan(0.1);
				}
				edits.push({
					trackId: track.id,
					offsetMs: 2000,
					cues: data.format === "bitmap" ? [] : [{ ...data.cues[0], text: data.format === "srt" ? "Edited SRT" : "{\\i1}Edited ASS{\\i0}" }],
				});
			}
			const saved = await post("save", { edits });
			if (saved.status !== 200) throw new Error(await saved.text());
			const output = ((await saved.json()) as any).outputPath;
			expect(output).toEndWith(".subtitles-edited.mkv");
			for (const stream of ["0:v:0", "0:a:0"]) {
				const hash = (input: string) => command(["ffmpeg", "-v", "error", "-i", input, "-map", stream, "-c", "copy", "-f", "hash", "-"]);
				expect(await hash(output)).toBe(await hash(path));
			}
			await command([
				"mkvextract",
				output,
				"tracks",
				`${file.subtitles[0].id}:saved.srt`,
				`${file.subtitles[1].id}:saved.ass`,
				`${file.subtitles[2].id}:saved.sup`,
			]);
			expect(readFileSync(join(root, "saved.srt"), "utf8")).toContain("00:00:06,000 --> 00:00:07,000");
			expect(readFileSync(join(root, "saved.srt"), "utf8")).toContain("Edited SRT");
			expect(readFileSync(join(root, "saved.ass"), "utf8")).toContain("0:00:06.00,0:00:07.00");
			expect(readFileSync(join(root, "saved.ass"), "utf8")).toContain("{\\i1}Edited ASS{\\i0}");
			expect(readFileSync(join(root, "saved.ass"), "utf8")).toContain("0:00:09.00,0:00:09.00,Default,,0,0,0,,Zero-length dummy");
			const pgsProbe = JSON.parse(
				await command(["ffprobe", "-v", "error", "-select_streams", "s:2", "-show_packets", "-show_entries", "packet=pts_time", "-of", "json", output]),
			);
			expect(Number(pgsProbe.packets[0].pts_time)).toBeCloseTo(6, 1);
			expect((await post("save", { edits, fingerprint: "stale" })).status).toBe(400);
			expect((await post("preview", { edit: edits[0], startSeconds: 0, durationSeconds: 121 })).status).toBe(400);
			expect((await app.handle(new Request("http://localhost/api/subtitle-editor/inspect?path=/etc/passwd"))).status).toBe(400);
			const secondSave = await post("save", { edits });
			expect(secondSave.status).toBe(200);
			expect(((await secondSave.json()) as any).outputPath).toEndWith(".subtitles-edited (2).mkv");
			await command(["ffmpeg", "-v", "error", "-i", path, "-map", "0:v", "-map", "0:s", "-c", "copy", "silent.mkv"]);
			const silentPath = join(root, "silent.mkv");
			const silentFile = (await (
				await app.handle(new Request(`http://localhost/api/subtitle-editor/inspect?${new URLSearchParams({ path: silentPath })}`))
			).json()) as any;
			const silentPreview = await post("preview", {
				path: silentPath,
				fingerprint: silentFile.fingerprint,
				edit: { trackId: silentFile.subtitles.find((track: any) => track.codecId === "S_HDMV/PGS").id, offsetMs: 0, cues: [] },
				startSeconds: 3,
				durationSeconds: 3,
			});
			if (silentPreview.status !== 200) throw new Error(await silentPreview.text());
			writeFileSync(join(root, "silent-preview.mp4"), Buffer.from(await silentPreview.arrayBuffer()));
			expect(await brightness("silent-preview.mp4", 1.5)).toBeGreaterThan(0.1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
	60_000,
);

(hasTools ? test : test.skip)(
	"subtitle editor opens, previews and saves ASS documents larger than 20 MB",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "rabbit-editor-large-test-"));
		const command = async (args: string[]) => {
			const result = await run(args, { cwd: root });
			if (result.code !== 0 && !(args[0] === "mkvmerge" && result.code === 1)) throw new Error(result.stderr || result.stdout);
		};
		try {
			const document =
				`[Script Info]
ScriptType: v4.00+
PlayResX: 320
PlayResY: 180
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans,20,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,First cue
` + `Dialogue: 0,3:00:00.00,3:00:01.00,Default,,0,0,0,,${"large subtitle ".repeat(300)}\n`.repeat(5000);
			writeFileSync(join(root, "large.ass"), document);
			expect(statSync(join(root, "large.ass")).size).toBeGreaterThan(20_000_000);
			await command(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=black:s=320x180:r=24:d=3", "-c:v", "libx264", "-preset", "ultrafast", "video.mkv"]);
			await command(["mkvmerge", "-o", "episode.mkv", "video.mkv", "large.ass"]);
			const path = join(root, "episode.mkv");
			const app = new Web();
			registerSubtitleEditorRoutes(app, { inputDir: root, outputDir: root, libraryDirs: [], tempDir: join(root, "temp") } as unknown as AppConfig);
			const file = (await (await app.handle(new Request(`http://localhost/api/subtitle-editor/inspect?${new URLSearchParams({ path })}`))).json()) as any;
			const trackId = file.subtitles[0].id;
			const post = (route: string, body: object) =>
				app.handle(
					new Request(`http://localhost/api/subtitle-editor/${route}`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ path, fingerprint: file.fingerprint, ...body }),
					}),
				);
			const loaded = await post("track", { trackId });
			if (loaded.status !== 200) throw new Error(await loaded.text());
			const data = (await loaded.json()) as any;
			expect(data.format).toBe("ass");
			expect(data.cues).toHaveLength(5001);
			const edit = { trackId, offsetMs: 500, cues: [{ ...data.cues[0], text: "Edited large ASS" }] };
			const preview = await post("preview", { edit, startSeconds: 0, durationSeconds: 3 });
			if (preview.status !== 200) throw new Error(await preview.text());
			expect(preview.headers.get("Content-Type")).toBe("video/mp4");
			expect((await preview.arrayBuffer()).byteLength).toBeGreaterThan(0);
			const saved = await post("save", { edits: [edit] });
			if (saved.status !== 200) throw new Error(await saved.text());
			const output = ((await saved.json()) as any).outputPath;
			await command(["mkvextract", output, "tracks", `${trackId}:saved.ass`]);
			expect(statSync(join(root, "saved.ass")).size).toBeGreaterThan(20_000_000);
			const result = readFileSync(join(root, "saved.ass"), "utf8");
			expect(result).toContain("0:00:01.50,0:00:02.50,Default,,0,0,0,,Edited large ASS");
			expect(result).toContain("3:00:00.50,3:00:01.50");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
	60_000,
);
