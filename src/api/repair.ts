import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "fs";
import { randomUUID } from "crypto";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "path";
import type { Web } from "@rabbit-company/web";
import {
	MEDIA_EXTENSIONS,
	type AppConfig,
	type RepairAuditGroupEdit,
	type RepairAuditLanguageRemoval,
	type RepairAuditSubtitleOrder,
	type RepairInspectionFile,
	type RepairPlan,
	type RepairSourceLayout,
} from "../core/types";
import {
	buildRepairAuditGroupPlans,
	buildRepairLanguageRemovalPlans,
	buildRepairSubtitleOrderPlans,
	buildRepairFontPlans,
	buildSourceReplacementPlan,
	groupRepairAuditFiles,
	inspectRepairAuditFile,
	identifyMatroska,
	inspectRepairFile,
	sanitizeRepairPlan,
	subtitleSortOrder,
	subtitlesOutOfOrder,
} from "../pipeline/repair";
import { Logger } from "../core/logger";
import { run } from "../core/process";
import { mapPool } from "../core/concurrency";
import { clearOriginals, originalPath, originalsUsage } from "../fonts/font-cut";
import { estimateFontSavings } from "../fonts/rabbit-faces";
import { pairRepairFiles } from "../pipeline/repair-pairing";
import { buildLayoutRepairPlans, groupSourceLayouts, planToLayoutTracks } from "../pipeline/repair-layouts";
import { addRepairJob, getAllJobs, getAppConfig, getJob } from "../queue/store";
import type { SubtitleSortOptions } from "../tracks/tracks";
import { browseFolder } from "../queue/library";

/** File extension for a downloadable subtitle codec. VobSub is left out because it extracts to two files. */
const SUBTITLE_EXTENSIONS: Record<string, string> = {
	"S_TEXT/ASS": "ass",
	"S_TEXT/SSA": "ssa",
	"S_TEXT/UTF8": "srt",
	"S_TEXT/WEBVTT": "vtt",
	"S_HDMV/PGS": "sup",
};

/** File extension mkvextract writes for an audio codec, keyed by Matroska codec ID. AAC IDs carry a profile suffix. */
const AUDIO_EXTENSIONS: Record<string, string> = {
	A_AAC: "aac",
	A_AC3: "ac3",
	A_EAC3: "eac3",
	A_DTS: "dts",
	A_TRUEHD: "thd",
	A_MLP: "mlp",
	A_FLAC: "flac",
	A_OPUS: "opus",
	A_VORBIS: "ogg",
	"A_MPEG/L2": "mp2",
	"A_MPEG/L3": "mp3",
	"A_PCM/INT/LIT": "wav",
	"A_PCM/INT/BIG": "wav",
	"A_PCM/FLOAT/IEEE": "wav",
	A_ALAC: "caf",
	A_TTA1: "tta",
	A_WAVPACK4: "wv",
};

export function audioExtension(codecId: string): string | undefined {
	return AUDIO_EXTENSIONS[codecId] ?? (codecId.startsWith("A_AAC/") ? "aac" : codecId.startsWith("A_AC3/") ? "ac3" : undefined);
}

/** "Show - 01.mkv", track 24 in "slv" gives "Show - 01.24.slv.ass". */
export function trackDownloadName(mkvPath: string, trackId: number, language: string, extension: string): string {
	const stem = basename(mkvPath, extname(mkvPath));
	const lang = language.replace(/[^A-Za-z0-9-]/g, "") || "und";
	return `${stem}.${trackId}.${lang}.${extension}`;
}

function isInside(path: string, root: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function allowedRoots(config: AppConfig): string[] {
	return [config.inputDir, config.outputDir, ...config.libraryDirs].filter((root) => existsSync(root)).map((root) => realpathSync(root));
}

export function resolveAllowedMediaFile(raw: unknown, config: AppConfig, label: string): string {
	if (typeof raw !== "string" || !raw.trim()) throw new Error(`${label} path is required`);
	const candidate = resolve(raw.trim());
	if (!existsSync(candidate) || !statSync(candidate).isFile()) throw new Error(`${label} file does not exist`);
	const real = realpathSync(candidate);
	if (!allowedRoots(config).some((root) => isInside(real, root))) throw new Error(`${label} must be inside an input, output, or configured library directory`);
	if (!MEDIA_EXTENSIONS.has(extname(real).toLowerCase())) throw new Error(`${label} must be a supported video file`);
	return real;
}

export function resolveAllowedMkv(raw: unknown, config: AppConfig, label: string): string {
	const real = resolveAllowedMediaFile(raw, config, label);
	if (extname(real).toLowerCase() !== ".mkv") throw new Error(`${label} must be an MKV file`);
	return real;
}

export function resolveAllowedDirectory(raw: unknown, config: AppConfig): string {
	if (typeof raw !== "string" || !raw.trim()) throw new Error("Folder path is required");
	const candidate = resolve(raw.trim());
	if (!existsSync(candidate) || !statSync(candidate).isDirectory()) throw new Error("Folder does not exist");
	const real = realpathSync(candidate);
	if (!allowedRoots(config).some((root) => isInside(real, root))) throw new Error("Folder is outside Rabbit's configured media directories");
	return real;
}

function repairRoots(config: AppConfig): { path: string; name: string }[] {
	const candidates = [
		{ path: config.inputDir, name: `Input: ${basename(config.inputDir) || config.inputDir}` },
		{ path: config.outputDir, name: `Output: ${basename(config.outputDir) || config.outputDir}` },
		...config.libraryDirs.map((path) => ({ path, name: `Library: ${basename(path) || path}` })),
	];
	const seen = new Set<string>();
	return candidates.flatMap((candidate) => {
		if (!existsSync(candidate.path) || !statSync(candidate.path).isDirectory()) return [];
		const path = realpathSync(candidate.path);
		if (seen.has(path)) return [];
		seen.add(path);
		return [{ path, name: candidate.name }];
	});
}

function outputPathForJob(jobId: string, config: AppConfig): { targetPath: string; sourcePath?: string } {
	const job = getJob(jobId);
	if (!job) throw new Error("Job not found");
	let targetPath: string;
	if (job.kind === "repair" && job.outputFilename) {
		targetPath = job.outputFilename;
	} else if (job.status === "done" && job.outputFilename) {
		targetPath = job.replaceSource ? join(dirname(job.inputPath), basename(job.outputFilename)) : join(config.outputDir, job.outputFilename);
	} else {
		targetPath = job.inputPath;
	}
	return { targetPath, sourcePath: existsSync(job.inputPath) && resolve(job.inputPath) !== resolve(targetPath) ? job.inputPath : undefined };
}

/** Repairs rewrite the file, so nothing else may still be queued or running on it. */
function assertNoPendingJobs(paths: string[], action: string): void {
	const busy = getAllJobs().find((job) => paths.includes(job.inputPath) && !["done", "error", "cancelled"].includes(job.status));
	if (busy) throw new Error(`${basename(busy.inputPath)} already has an unfinished job. Finish or remove it before ${action}.`);
	const cancelledRepair = getAllJobs().find((job) => job.kind === "repair" && paths.includes(job.inputPath) && job.status === "cancelled");
	if (cancelledRepair) throw new Error(`${basename(cancelledRepair.inputPath)} has a cancelled repair. Remove it before ${action}.`);
}

async function inspectAuditPaths(inputs: { path: string; sourcePath?: string }[], folderPath: string | undefined, signal?: AbortSignal) {
	if (inputs.length > 500) throw new Error("A folder audit may contain at most 500 MKV files");
	const files = [];
	for (let offset = 0; offset < inputs.length; offset += 8) {
		files.push(
			...(await Promise.all(
				inputs.slice(offset, offset + 8).map(async (input) => ({ ...(await inspectRepairAuditFile(input.path, signal)), sourcePath: input.sourcePath })),
			)),
		);
	}
	const audit = groupRepairAuditFiles(files, folderPath);
	const order = subtitleSortOptions();
	return { ...audit, files: audit.files.map((file) => ({ ...file, subtitlesOutOfOrder: subtitlesOutOfOrder(file.tracks, order) })) };
}

/** The subtitle order an encode uses, from the default settings. */
function subtitleSortOptions(): SubtitleSortOptions {
	const defaults = getAppConfig().defaults;
	return {
		sourcePriority: defaults.subtitleSourcePriority,
		fansubTiebreak: defaults.subtitleFansubTiebreak,
		formatPriority: defaults.subtitleFormatPriority,
		languagePriority: defaults.subtitleLanguagePriority,
	};
}

function resolveBatchPairs(raw: unknown, config: AppConfig): { targetPath: string; sourcePath: string }[] {
	if (!Array.isArray(raw) || raw.length === 0) throw new Error("Confirm at least one encode/source pair");
	if (raw.length > 500) throw new Error("Batch replacement is limited to 500 files");
	return raw.map((entry: any) => ({
		targetPath: resolveAllowedMkv(entry?.targetPath, config, "Encoded target"),
		sourcePath: resolveAllowedMkv(entry?.sourcePath, config, "Subtitle source"),
	}));
}

async function inspectBatchSources(pairs: { sourcePath: string }[], signal?: AbortSignal): Promise<Map<string, RepairInspectionFile>> {
	const paths = [...new Set(pairs.map((pair) => pair.sourcePath))];
	const sources = new Map<string, RepairInspectionFile>();
	for (let offset = 0; offset < paths.length; offset += 8) {
		const inspected = await Promise.all(paths.slice(offset, offset + 8).map((path) => inspectRepairFile(path, signal)));
		for (const file of inspected) sources.set(file.path, file);
	}
	return sources;
}

export function registerRepairRoutes(app: Web, config: AppConfig): void {
	app.get("/api/repair/roots", (c) => c.json({ roots: repairRoots(config) }));

	app.get("/api/repair/browse", (c) => {
		try {
			const path = resolveAllowedDirectory(c.query().get("path"), config);
			const allMedia = c.query().get("allMedia") === "1";
			// The picker shows no folder counts, so subfolders are not scanned. On network storage that scan is slow.
			const entries = browseFolder(path, config.organization).filter(
				(entry) => entry.type === "directory" || allMedia || extname(entry.name).toLowerCase() === ".mkv",
			);
			return c.json({ path, entries });
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});

	app.get("/api/repair/inspect", async (c) => {
		try {
			const query = c.query();
			const fromJob = query.get("jobId") ? outputPathForJob(query.get("jobId")!, config) : undefined;
			const targetPath = resolveAllowedMkv(query.get("targetPath") || fromJob?.targetPath, config, "Encoded target");
			const rawSource = query.get("sourcePath") || fromJob?.sourcePath;
			const sourcePath = rawSource ? resolveAllowedMkv(rawSource, config, "Subtitle source") : undefined;
			const [target, source] = await Promise.all([
				inspectRepairFile(targetPath, c.req.signal),
				sourcePath ? inspectRepairFile(sourcePath, c.req.signal) : undefined,
			]);
			return c.json({ target, source });
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});

	app.post("/api/repair/subtitle-download", async (c) => {
		const temp = join(config.tempDir, `subtitle-download-${randomUUID()}`);
		try {
			const body = (await c.req.json().catch(() => ({}))) as { path?: unknown; trackId?: unknown };
			const path = resolveAllowedMkv(body.path, config, "MKV");
			const trackId = body.trackId;
			if (typeof trackId !== "number" || !Number.isInteger(trackId) || trackId < 0) throw new Error("Invalid subtitle track");
			const identified = await identifyMatroska(path, c.req.signal);
			const track = (identified.tracks || []).find((t) => t.id === trackId && t.type === "subtitles");
			if (!track) throw new Error(`Subtitle track ${trackId} not found`);
			const extension = SUBTITLE_EXTENSIONS[track.properties.codec_id || ""];
			if (!extension) throw new Error(`Downloading ${track.properties.codec_id || track.codec} subtitles is not supported`);

			mkdirSync(temp, { recursive: true });
			const out = join(temp, `track.${extension}`);
			const result = await run(["mkvextract", path, "tracks", `${trackId}:${out}`], { signal: c.req.signal });
			if (result.code !== 0 || !existsSync(out)) throw new Error(`mkvextract failed: ${(result.stderr || result.stdout).slice(-500)}`);
			const data = readFileSync(out);
			const name = trackDownloadName(path, trackId, track.properties.language_ietf || track.properties.language || "und", extension);
			return new Response(data, {
				headers: {
					"Content-Type": extension === "sup" ? "application/octet-stream" : "text/plain; charset=utf-8",
					"Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
				},
			});
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});

	app.post("/api/repair/audio-download", async (c) => {
		const temp = join(config.tempDir, `audio-download-${randomUUID()}`);
		const cleanup = () => rmSync(temp, { recursive: true, force: true });
		try {
			const body = (await c.req.json().catch(() => ({}))) as { path?: unknown; trackId?: unknown };
			const path = resolveAllowedMkv(body.path, config, "MKV");
			const trackId = body.trackId;
			if (typeof trackId !== "number" || !Number.isInteger(trackId) || trackId < 0) throw new Error("Invalid audio track");
			const identified = await identifyMatroska(path, c.req.signal);
			const track = (identified.tracks || []).find((t) => t.id === trackId && t.type === "audio");
			if (!track) throw new Error(`Audio track ${trackId} not found`);
			const extension = audioExtension(track.properties.codec_id || "");
			if (!extension) throw new Error(`Downloading ${track.properties.codec_id || track.codec} audio is not supported`);

			mkdirSync(temp, { recursive: true });
			const out = join(temp, `track.${extension}`);
			const result = await run(["mkvextract", path, "tracks", `${trackId}:${out}`], { signal: c.req.signal });
			if (result.code !== 0 || !existsSync(out)) throw new Error(`mkvextract failed: ${(result.stderr || result.stdout).slice(-500)}`);
			const file = Bun.file(out);
			const name = trackDownloadName(path, trackId, track.properties.language_ietf || track.properties.language || "und", extension);
			// Lossless tracks run to gigabytes, so stream the file and remove it once it is sent.
			const stream = file.stream().pipeThrough(new TransformStream({ flush: cleanup }));
			c.req.signal?.addEventListener("abort", cleanup, { once: true });
			return new Response(stream, {
				headers: {
					"Content-Type": "application/octet-stream",
					"Content-Length": String(file.size),
					"Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
				},
			});
		} catch (error: any) {
			cleanup();
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});

	app.post("/api/repair/audit", async (c) => {
		try {
			const raw = (await c.req.json()) as { path?: unknown; jobIds?: unknown };
			let folderPath: string | undefined;
			let inputs: { path: string; sourcePath?: string }[];
			if (typeof raw.path === "string" && raw.path.trim()) {
				folderPath = resolveAllowedDirectory(raw.path, config);
				inputs = readdirSync(folderPath, { withFileTypes: true })
					.filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".mkv")
					.map((entry) => ({ path: resolveAllowedMkv(join(folderPath!, entry.name), config, "Audit file") }))
					.sort((a, b) => basename(a.path).localeCompare(basename(b.path), undefined, { numeric: true }));
			} else if (Array.isArray(raw.jobIds)) {
				const seen = new Set<string>();
				inputs = raw.jobIds.flatMap((value) => {
					if (typeof value !== "string") return [];
					const job = getJob(value);
					if (!job || job.status !== "done") return [];
					const resolved = outputPathForJob(value, config);
					const path = resolveAllowedMkv(resolved.targetPath, config, "Completed output");
					if (seen.has(path)) return [];
					seen.add(path);
					const sourcePath =
						resolved.sourcePath && existsSync(resolved.sourcePath) ? resolveAllowedMkv(resolved.sourcePath, config, "Original source") : undefined;
					return [{ path, sourcePath }];
				});
			} else {
				throw new Error("Choose a folder or a completed encoding folder to audit");
			}
			return c.json(await inspectAuditPaths(inputs, folderPath, c.req.signal));
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});

	app.post("/api/repair/audit/group", async (c) => {
		try {
			const raw = (await c.req.json()) as RepairAuditGroupEdit;
			if (!Array.isArray(raw?.paths) || !raw.paths.length || raw.paths.length > 500) throw new Error("Choose between 1 and 500 group files");
			const paths = raw.paths.map((path) => resolveAllowedMkv(path, config, "Group file"));
			if (new Set(paths).size !== paths.length) throw new Error("Group files must not contain duplicate paths");
			const inspected = await inspectAuditPaths(
				paths.map((path) => ({ path })),
				undefined,
				c.req.signal,
			);
			const plans = buildRepairAuditGroupPlans(inspected.files, raw);
			assertNoPendingJobs(paths, "editing this group");
			if (c.req.signal.aborted) throw new Error("Group edit request was cancelled");
			const jobs = plans.map((plan) => addRepairJob(plan));
			return c.json({ jobIds: jobs.map((job) => job.id) }, 201);
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});

	/** Removes every subtitle track in the chosen languages from the audited files, one repair job per file. */
	app.post("/api/repair/audit/remove-languages", async (c) => {
		try {
			const raw = (await c.req.json()) as RepairAuditLanguageRemoval;
			if (!Array.isArray(raw?.paths) || !raw.paths.length || raw.paths.length > 500) throw new Error("Choose between 1 and 500 files");
			const paths = [...new Set(raw.paths.map((path) => resolveAllowedMkv(path, config, "Audit file")))];
			const inspected = await inspectAuditPaths(
				paths.map((path) => ({ path })),
				undefined,
				c.req.signal,
			);
			const plans = buildRepairLanguageRemovalPlans(inspected.files, raw);
			assertNoPendingJobs(
				plans.map((plan) => plan.targetPath),
				"removing languages",
			);
			if (c.req.signal.aborted) throw new Error("Language removal request was cancelled");
			const jobs = plans.map((plan) => addRepairJob(plan));
			return c.json({ jobIds: jobs.map((job) => job.id) }, 201);
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});

	/** Puts the subtitles of the audited files in the order an encode gives them, one repair job per file out of order. */
	app.post("/api/repair/audit/order-subtitles", async (c) => {
		try {
			const raw = (await c.req.json()) as RepairAuditSubtitleOrder;
			if (!Array.isArray(raw?.paths) || !raw.paths.length || raw.paths.length > 500) throw new Error("Choose between 1 and 500 files");
			const paths = [...new Set(raw.paths.map((path) => resolveAllowedMkv(path, config, "Audit file")))];
			const inspected = await inspectAuditPaths(
				paths.map((path) => ({ path })),
				undefined,
				c.req.signal,
			);
			const plans = buildRepairSubtitleOrderPlans(inspected.files, { ...subtitleSortOptions(), replaceTarget: !!raw.replaceTarget });
			assertNoPendingJobs(
				plans.map((plan) => plan.targetPath),
				"ordering subtitles",
			);
			if (c.req.signal.aborted) throw new Error("Subtitle ordering request was cancelled");
			const jobs = plans.map((plan) => addRepairJob(plan));
			return c.json({ jobIds: jobs.map((job) => job.id) }, 201);
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});

	/** Rebuilds the fonts of the audited files without changing a track, one repair job per file. */
	app.post("/api/repair/audit/rebuild-fonts", async (c) => {
		try {
			const raw = (await c.req.json()) as { paths?: unknown; subset?: unknown; replaceTarget?: unknown };
			if (!Array.isArray(raw?.paths) || !raw.paths.length || raw.paths.length > 500) throw new Error("Choose between 1 and 500 files");
			const paths = [...new Set(raw.paths.map((path) => resolveAllowedMkv(String(path), config, "Audit file")))];
			const inspected = await inspectAuditPaths(
				paths.map((path) => ({ path })),
				undefined,
				c.req.signal,
			);
			const plans = buildRepairFontPlans(inspected.files, { subset: raw.subset === true, replaceTarget: raw.replaceTarget === true });
			assertNoPendingJobs(
				plans.map((plan) => plan.targetPath),
				"rebuilding fonts",
			);
			if (c.req.signal.aborted) throw new Error("Font rebuild request was cancelled");
			const jobs = plans.map((plan) => addRepairJob(plan));
			return c.json({ jobIds: jobs.map((job) => job.id) }, 201);
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});

	/** What rebuilding the fonts of a few audited files would save, without changing them. The client sends a folder in batches. */
	app.post("/api/repair/audit/font-savings", async (c) => {
		try {
			const raw = (await c.req.json()) as { paths?: unknown };
			if (!Array.isArray(raw?.paths) || !raw.paths.length || raw.paths.length > 8) throw new Error("Choose between 1 and 8 files");
			const paths = [...new Set(raw.paths.map((path) => resolveAllowedMkv(String(path), config, "Audit file")))];
			const totals = { files: paths.length, analyzed: 0, now: 0, whole: 0, cut: 0, originals: {} as Record<string, number> };
			await mapPool(paths, 2, async (path) => {
				if (c.req.signal.aborted) return;
				const workDir = join(config.tempDir, `font-savings-${randomUUID()}`);
				mkdirSync(workDir, { recursive: true });
				try {
					const savings = await estimateFontSavings(path, config.defaults, workDir, c.req.signal);
					if (!savings) return;
					totals.analyzed++;
					totals.now += savings.now;
					totals.whole += savings.whole;
					totals.cut += savings.cut;
					for (const [sha, bytes] of savings.originals) if (!originalPath(sha)) totals.originals[sha] = bytes;
				} catch (error: any) {
					if (!c.req.signal.aborted) Logger.warn(`[fonts] Could not work out the font savings of ${basename(path)}: ${error?.message || error}`);
				} finally {
					rmSync(workDir, { recursive: true, force: true });
				}
			});
			if (c.req.signal.aborted) throw new Error("Font analysis was cancelled");
			return c.json(totals);
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});

	/** Full copies of the fonts Rabbit cut down, kept to restore characters later edits need. */
	app.get("/api/fonts/originals", (c) => c.json(originalsUsage()));
	app.delete("/api/fonts/originals", (c) => {
		clearOriginals();
		return c.json(originalsUsage());
	});

	/** The order an encode gives a list of subtitle tracks, as positions in the list. */
	app.post("/api/repair/sort-subtitles", async (c) => {
		try {
			const raw = (await c.req.json()) as { tracks?: unknown };
			if (!Array.isArray(raw?.tracks) || raw.tracks.length > 200) throw new Error("Send between 0 and 200 subtitle tracks");
			const text = (v: unknown) => (typeof v === "string" ? v.slice(0, 512) : "");
			const tracks = raw.tracks.map((t: any) => ({
				codec: text(t?.codec),
				language: text(t?.language) || "und",
				title: text(t?.title),
				isDefault: t?.isDefault === true,
				isForced: t?.isForced === true,
				isHearingImpaired: t?.isHearingImpaired === true,
				isOriginal: t?.isOriginal === true,
				isCommentary: t?.isCommentary === true,
			}));
			return c.json({ order: subtitleSortOrder(tracks, subtitleSortOptions()) });
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});

	app.post("/api/repair/replace-plan", async (c) => {
		const workDir = join(config.tempDir, `repair-plan-${randomUUID()}`);
		try {
			const raw = (await c.req.json()) as { targetPath?: unknown; sourcePath?: unknown; replaceTarget?: unknown };
			const targetPath = resolveAllowedMkv(raw.targetPath, config, "Encoded target");
			const sourcePath = resolveAllowedMkv(raw.sourcePath, config, "Subtitle source");
			mkdirSync(workDir, { recursive: true });
			const plan = await buildSourceReplacementPlan({
				targetPath,
				sourcePath,
				settings: config.defaults,
				tempDir: workDir,
				replaceTarget: raw.replaceTarget !== false,
				signal: c.req.signal,
			});
			return c.json(plan);
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		} finally {
			try {
				rmSync(workDir, { recursive: true, force: true });
			} catch {}
		}
	});

	app.post("/api/repair/batch/pair", async (c) => {
		try {
			const raw = (await c.req.json()) as { targetDir?: unknown; sourceDir?: unknown };
			const targetDir = resolveAllowedDirectory(raw.targetDir, config);
			const sourceDir = resolveAllowedDirectory(raw.sourceDir, config);
			if (targetDir === sourceDir) throw new Error("Choose two different folders - the encodes and their original sources");
			const mkvsIn = (dir: string) =>
				readdirSync(dir, { withFileTypes: true })
					.filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".mkv")
					.map((entry) => join(dir, entry.name));
			const targets = mkvsIn(targetDir);
			const sources = mkvsIn(sourceDir);
			if (targets.length === 0) throw new Error("The encodes folder has no MKV files");
			if (sources.length === 0) throw new Error("The sources folder has no MKV files");
			if (targets.length > 500 || sources.length > 500) throw new Error("Batch replacement is limited to 500 files per folder");
			return c.json({ targetDir, sourceDir, ...pairRepairFiles(targets, sources) });
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});

	app.post("/api/repair/batch/layouts", async (c) => {
		try {
			const raw = (await c.req.json()) as { pairs?: unknown };
			const pairs = resolveBatchPairs(raw.pairs, config);
			const sources = await inspectBatchSources(pairs, c.req.signal);
			const layouts: RepairSourceLayout[] = groupSourceLayouts([...sources.values()]);
			return c.json({ layouts });
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});

	// Separate from the layouts, since the workflow reads every subtitle of the source and that is slow on large remuxes.
	app.post("/api/repair/batch/suggestion", async (c) => {
		const workDir = join(config.tempDir, `repair-layout-${randomUUID()}`);
		try {
			const raw = (await c.req.json()) as { targetPath?: unknown; sourcePath?: unknown };
			const targetPath = resolveAllowedMkv(raw.targetPath, config, "Encoded target");
			const sourcePath = resolveAllowedMkv(raw.sourcePath, config, "Subtitle source");
			mkdirSync(workDir, { recursive: true });
			const [plan, source] = await Promise.all([
				buildSourceReplacementPlan({ targetPath, sourcePath, settings: config.defaults, tempDir: workDir, replaceTarget: true, signal: c.req.signal }),
				inspectRepairFile(sourcePath, c.req.signal),
			]);
			return c.json({ tracks: planToLayoutTracks(plan.tracks, source.subtitles) });
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		} finally {
			rmSync(workDir, { recursive: true, force: true });
		}
	});

	app.post("/api/repair/batch/jobs", async (c) => {
		try {
			const raw = (await c.req.json()) as { pairs?: unknown; replaceTarget?: unknown; layouts?: unknown };
			const pairs = resolveBatchPairs(raw.pairs, config);
			const replaceTarget = raw.replaceTarget !== false;

			// With layouts the tracks are chosen by the user, so the plans are final now.
			// Without them each job runs the subtitle workflow on its own source.
			let plans: RepairPlan[];
			if (Array.isArray(raw.layouts)) {
				const sources = await inspectBatchSources(pairs, c.req.signal);
				plans = buildLayoutRepairPlans({ pairs, sources, layouts: raw.layouts, replaceTarget });
			} else {
				plans = pairs.map((pair) => ({ ...pair, replaceTarget, replaceFromSource: true, tracks: [] }));
			}
			const targets = plans.map((plan) => plan.targetPath);
			if (new Set(targets).size !== targets.length) throw new Error("The same encode was paired more than once");

			const busy = getAllJobs().find((job) => targets.includes(job.inputPath) && !["done", "error", "cancelled"].includes(job.status));
			if (busy) throw new Error(`${basename(busy.inputPath)} already has an unfinished job. Finish or remove it first.`);
			const cancelled = getAllJobs().find((job) => job.kind === "repair" && targets.includes(job.inputPath) && job.status === "cancelled");
			if (cancelled) throw new Error(`${basename(cancelled.inputPath)} has a cancelled repair. Remove it before queueing another.`);

			const jobs = plans.map((plan) => addRepairJob(sanitizeRepairPlan(plan)));
			return c.json({ jobIds: jobs.map((job) => job.id) }, 201);
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});

	app.post("/api/repair/jobs", async (c) => {
		try {
			const raw = (await c.req.json()) as RepairPlan;
			const normalized = sanitizeRepairPlan(raw);
			normalized.targetPath = resolveAllowedMkv(normalized.targetPath, config, "Encoded target");
			if (normalized.sourcePath) normalized.sourcePath = resolveAllowedMkv(normalized.sourcePath, config, "Subtitle source");
			for (const source of normalized.extraSources ?? []) source.path = resolveAllowedMkv(source.path, config, "Subtitle source");
			const job = addRepairJob(normalized);
			return c.json(job, 201);
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});
}
