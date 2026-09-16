import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { basename, dirname, join, parse, resolve } from "path";
import type { Web } from "@rabbit-company/web";
import type { AppConfig, RepairSubtitleTrackPlan } from "../core/types";
import { run } from "../core/process";
import { buildRepairMkvmergeArgs, identifyMatroska, inspectRepairFile } from "../pipeline/repair";
import { resolveUniqueOutputPath } from "../pipeline/output";
import { editSubtitleDocument, editorCues, editorFormat, validateEditorEdit, type SubtitleEditorEdit } from "../subtitles/editor";
import { resolveAllowedMkv } from "./repair";

function fingerprint(path: string): string {
	const stat = statSync(path);
	return `${stat.size}:${stat.mtimeMs}`;
}

async function checked(cmd: string[], cwd: string, signal?: AbortSignal, warnings = false): Promise<string> {
	if (signal?.aborted) throw new Error("Subtitle editor operation cancelled");
	const result = await run(cmd, { cwd, signal });
	if (signal?.aborted) throw new Error("Subtitle editor operation cancelled");
	if (result.code !== 0 && !(warnings && result.code === 1)) throw new Error(`${cmd[0]} failed: ${(result.stderr || result.stdout).slice(-1200)}`);
	return result.stdout;
}

async function extractDocument(path: string, trackId: number, format: string, temp: string, signal?: AbortSignal): Promise<string> {
	const name = `track-${trackId}.${format}`;
	await checked(["mkvextract", path, "tracks", `${trackId}:${name}`], temp, signal);
	return readFileSync(join(temp, name), "utf8");
}

export function registerSubtitleEditorRoutes(app: Web, config: AppConfig): void {
	let active = 0;
	const saving = new Set<string>();
	// Reuse extracted tracks during live editing. Bound memory and expire idle entries.
	const cache = new Map<string, { data: string | Buffer; bytes: number; used: number }>();
	const maxCacheBytes = 80_000_000;
	let cacheBytes = 0;
	const cached = async (key: string, load: () => Promise<string | Buffer>): Promise<string | Buffer> => {
		for (const [entryKey, entry] of cache)
			if (Date.now() - entry.used > 30 * 60_000) {
				cache.delete(entryKey);
				cacheBytes -= entry.bytes;
			}
		const found = cache.get(key);
		if (found) {
			cache.delete(key);
			found.used = Date.now();
			cache.set(key, found);
			return found.data;
		}
		const data = await load();
		const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.length;
		// The cache budget controls retention, not which subtitle tracks can be edited.
		if (bytes > maxCacheBytes) return data;
		// A concurrent request may have populated the same entry while extraction ran.
		const previous = cache.get(key);
		if (previous) {
			cache.delete(key);
			cacheBytes -= previous.bytes;
		}
		while (cache.size >= 16 || cacheBytes + bytes > maxCacheBytes) {
			const oldest = cache.keys().next().value;
			if (oldest === undefined) break;
			cacheBytes -= cache.get(oldest)!.bytes;
			cache.delete(oldest);
		}
		cache.set(key, { data, bytes, used: Date.now() });
		cacheBytes += bytes;
		return data;
	};
	const documentFor = async (path: string, id: number, format: string, temp: string, signal: AbortSignal) =>
		(await cached(JSON.stringify([path, fingerprint(path), id, format]), () => extractDocument(path, id, format, temp, signal))) as string;
	const bitmapFor = async (path: string, id: number, temp: string, signal: AbortSignal) => {
		const data = await cached(JSON.stringify([path, fingerprint(path), id, "bitmap"]), async () => {
			await checked(
				[
					"mkvmerge",
					"-o",
					"extracted-bitmap.mkv",
					"--no-video",
					"--no-audio",
					"--no-chapters",
					"--no-global-tags",
					"--no-attachments",
					"--subtitle-tracks",
					String(id),
					path,
				],
				temp,
				signal,
				true,
			);
			return readFileSync(join(temp, "extracted-bitmap.mkv"));
		});
		writeFileSync(join(temp, "bitmap.mkv"), data);
	};
	const workspace = async (signal: AbortSignal, action: (temp: string, signal: AbortSignal) => Promise<Response>) => {
		if (active >= 2)
			return new Response(JSON.stringify({ error: "Subtitle editor is busy. Try again shortly." }), {
				status: 429,
				headers: { "Content-Type": "application/json" },
			});
		active++;
		let temp = "";
		try {
			mkdirSync(config.tempDir, { recursive: true });
			temp = mkdtempSync(join(resolve(config.tempDir), "subtitle-editor-"));
			return await action(temp, AbortSignal.any([signal, AbortSignal.timeout(240_000)]));
		} finally {
			active--;
			if (temp) rmSync(temp, { recursive: true, force: true });
		}
	};
	const errorResponse = (error: any) =>
		new Response(JSON.stringify({ error: error?.message || String(error) }), { status: 400, headers: { "Content-Type": "application/json" } });
	const input = (raw: { path: unknown; fingerprint: unknown }) => {
		const path = resolveAllowedMkv(raw.path, config, "Subtitle editor file");
		if (raw.fingerprint !== fingerprint(path)) throw new Error("The MKV changed since it was opened. Choose the file again before editing.");
		return path;
	};

	app.get("/api/subtitle-editor/inspect", async (c) => {
		try {
			const path = resolveAllowedMkv(c.query().get("path"), config, "Subtitle editor file");
			const version = fingerprint(path);
			const file = await inspectRepairFile(path, c.req.signal);
			if (version !== fingerprint(path)) throw new Error("The MKV changed during inspection. Try again.");
			return c.json({ ...file, fingerprint: version });
		} catch (error) {
			return errorResponse(error);
		}
	});

	app.post("/api/subtitle-editor/track", async (c) => {
		try {
			const raw = (await c.req.json()) as { path: string; fingerprint: string; trackId: number };
			const path = input(raw);
			return await workspace(c.req.signal, async (temp, signal) => {
				const file = await inspectRepairFile(path, signal);
				const track = file.subtitles.find((track) => track.id === raw.trackId);
				const format = track && editorFormat(track.codecId);
				if (!track || !format) throw new Error("This subtitle codec is not supported by the editor");
				if (format !== "bitmap") {
					const document = await documentFor(path, track.id, format, temp, signal);
					input(raw);
					return c.json({ format, cues: editorCues(document, format) });
				}
				await bitmapFor(path, track.id, temp, signal);
				const probe = JSON.parse(
					await checked(
						[
							"ffprobe",
							"-v",
							"error",
							"-select_streams",
							"s:0",
							"-show_frames",
							"-show_entries",
							"frame=pts_time,start_display_time,end_display_time,num_rects",
							"-of",
							"json",
							"bitmap.mkv",
						],
						temp,
						signal,
					),
				);
				const frames = (probe.frames || []).filter((frame: any) => Number.isFinite(Number(frame.pts_time)));
				const cues = frames.flatMap((frame: any, id: number) => {
					if (!(frame.num_rects > 0)) return [];
					const ptsMs = Number(frame.pts_time) * 1000;
					const startMs = Math.round(ptsMs + (Number(frame.start_display_time) || 0));
					const displayEnd = Number(frame.end_display_time);
					const next = Number(frames[id + 1]?.pts_time) * 1000 + (Number(frames[id + 1]?.start_display_time) || 0);
					const end = displayEnd > 0 && displayEnd < 86_400_000 ? ptsMs + displayEnd : next > startMs ? next : startMs + 3000;
					return [
						{ id, startMs, endMs: Math.round(Math.min(end, file.durationSeconds * 1000 || end)), text: `Bitmap subtitle at ${(startMs / 1000).toFixed(2)}s` },
					];
				});
				input(raw);
				return c.json({ format, cues });
			});
		} catch (error) {
			return errorResponse(error);
		}
	});

	app.post("/api/subtitle-editor/preview", async (c) => {
		try {
			const raw = (await c.req.json()) as { path: string; fingerprint: string; edit: SubtitleEditorEdit; startSeconds: number; durationSeconds: number };
			const path = input(raw);
			const edit = validateEditorEdit(raw.edit);
			if (
				!Number.isFinite(raw.startSeconds) ||
				raw.startSeconds < 0 ||
				!Number.isFinite(raw.durationSeconds) ||
				raw.durationSeconds < 0.1 ||
				raw.durationSeconds > 120
			)
				throw new Error("Preview start must be nonnegative and duration must be between 0.1 and 120 seconds");
			return await workspace(c.req.signal, async (temp, signal) => {
				const identified = await identifyMatroska(path, signal);
				const subs = (identified.tracks || []).filter((track) => track.type === "subtitles");
				const track = subs.find((track) => track.id === edit.trackId);
				const format = track && editorFormat(track.properties.codec_id || "");
				if (!track || !format) throw new Error("Unsupported subtitle track");
				const duration = (identified.container?.properties?.duration || 0) / 1e9;
				if (duration && raw.startSeconds >= duration) throw new Error("Preview starts after the episode ends");
				const args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", String(raw.startSeconds), "-i", path];
				let filter: string;
				if (format === "bitmap") {
					args.splice(1, 0, "-copyts");
					if (edit.cues.length) throw new Error("Bitmap subtitle text and cue times cannot be edited");
					await bitmapFor(path, track.id, temp, signal);
					const probe = JSON.parse(
						await checked(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", path], temp, signal),
					);
					const video = probe.streams?.[0];
					if (!video?.width || !video?.height) throw new Error("No video stream found");
					args.push("-canvas_size", `${video.width}x${video.height}`, "-itsoffset", String(edit.offsetMs / 1000 - raw.startSeconds), "-i", "bitmap.mkv");
					filter = "[0:v:0]setpts=PTS-STARTPTS[base];[base][1:s:0]overlay[burned];[burned]scale=w='min(1280,iw)':h=-2,setsar=1[v]";
					args.push("-af", "asetpts=PTS-STARTPTS");
				} else {
					const document = await documentFor(path, track.id, format, temp, signal);
					writeFileSync(join(temp, `preview.${format}`), editSubtitleDocument(document, format, edit));
					mkdirSync(join(temp, "fonts"));
					const fonts = (identified.attachments || []).filter((attachment) => /\.(ttf|otf|ttc|woff2?)$/i.test(attachment.file_name));
					if (fonts.length)
						await checked(
							["mkvextract", path, "attachments", ...fonts.map((font) => `${font.id}:fonts/${font.id}${/\.[^.]+$/.exec(font.file_name)?.[0] || ".ttf"}`)],
							temp,
							signal,
						);
					filter = `[0:v:0]setpts=PTS+${raw.startSeconds}/TB,subtitles=filename=preview.${format}:fontsdir=fonts,setpts=PTS-STARTPTS,scale=w='min(1280,iw)':h=-2,setsar=1[v]`;
				}
				args.push(
					"-filter_complex",
					filter,
					"-map",
					"[v]",
					"-map",
					"0:a:0?",
					"-t",
					String(raw.durationSeconds),
					"-c:v",
					"libx264",
					"-preset",
					"ultrafast",
					"-crf",
					"23",
					"-pix_fmt",
					"yuv420p",
					"-c:a",
					"aac",
					"-ac",
					"2",
					"-movflags",
					"+faststart",
					"preview.mp4",
				);
				await checked(args, temp, signal);
				input(raw);
				return new Response(readFileSync(join(temp, "preview.mp4")), { headers: { "Content-Type": "video/mp4", "Cache-Control": "no-store" } });
			});
		} catch (error) {
			return errorResponse(error);
		}
	});

	app.post("/api/subtitle-editor/save", async (c) => {
		let lockedPath = "";
		let stage = "";
		try {
			const raw = (await c.req.json()) as { path: string; fingerprint: string; edits: SubtitleEditorEdit[] };
			const path = input(raw);
			if (!Array.isArray(raw.edits) || !raw.edits.length || raw.edits.length > 128) throw new Error("Select subtitle changes to save");
			const edits = raw.edits.map(validateEditorEdit);
			if (new Set(edits.map((edit) => edit.trackId)).size !== edits.length) throw new Error("Duplicate subtitle tracks");
			if (saving.has(path)) throw new Error("This file is already being saved");
			saving.add(path);
			lockedPath = path;
			return await workspace(c.req.signal, async (temp, signal) => {
				const [target, file] = await Promise.all([identifyMatroska(path, signal), inspectRepairFile(path, signal)]);
				if (edits.some((edit) => !file.subtitles.some((track) => track.id === edit.trackId))) throw new Error("Subtitle track no longer exists");
				const tracks: RepairSubtitleTrackPlan[] = file.subtitles.map((track, order) => ({
					...track,
					source: "target",
					trackId: track.id,
					mode: edits.some((edit) => edit.trackId === track.id) && editorFormat(track.codecId) !== "bitmap" ? "rabbit" : "copy",
					order,
					compression: "preserve",
				}));
				const prepared = [];
				for (const edit of edits) {
					const track = file.subtitles.find((track) => track.id === edit.trackId)!;
					const format = editorFormat(track.codecId);
					if (!format) throw new Error("Unsupported subtitle codec");
					if (format === "bitmap") {
						if (edit.cues.length) throw new Error("Bitmap subtitle text and cue times cannot be edited");
						continue;
					}
					const document = await documentFor(path, track.id, format, temp, signal);
					const output = join(temp, `edited-${track.id}.${format}`);
					writeFileSync(output, editSubtitleDocument(document, format, edit));
					prepared.push({ plan: tracks.find((plan) => plan.trackId === track.id)!, path: output });
				}
				stage = join(dirname(path), `.rabbit-subtitles-${basename(temp)}.mkv`);
				const args = buildRepairMkvmergeArgs({ outputPath: stage, plan: { targetPath: path, replaceTarget: false, tracks }, target, prepared });
				const sourceIndex = args.indexOf(path);
				args.splice(
					sourceIndex,
					0,
					...edits
						.filter((edit) => editorFormat(file.subtitles.find((track) => track.id === edit.trackId)!.codecId) === "bitmap")
						.flatMap((edit) => ["--sync", `${edit.trackId}:${edit.offsetMs}`]),
				);
				await checked(args, temp, signal, true);
				const verified = await identifyMatroska(stage, signal);
				const signature = (data: typeof target) =>
					["video", "audio", "subtitles"].map((type) =>
						(data.tracks || []).filter((track) => track.type === type).map((track) => track.properties.codec_id || track.codec),
					);
				if (JSON.stringify(signature(target)) !== JSON.stringify(signature(verified)))
					throw new Error("Verification failed: output tracks differ from the source");
				input(raw);
				const name = parse(path);
				const outputPath = resolveUniqueOutputPath(name.dir, `${name.name}.subtitles-edited.mkv`);
				renameSync(stage, outputPath);
				stage = "";
				return c.json({ outputPath });
			});
		} catch (error) {
			return errorResponse(error);
		} finally {
			if (lockedPath) saving.delete(lockedPath);
			if (stage) rmSync(stage, { force: true });
		}
	});
}
