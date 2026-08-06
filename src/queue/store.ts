import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { resolve, dirname, join, extname, relative, basename } from "path";
import {
	type Job,
	type JobSettings,
	type AppConfig,
	type DenoiseBackend,
	type PreviewState,
	MEDIA_EXTENSIONS,
	type VideoEncodeMode,
	type AudioEncodeMode,
	type SubtitleProcessingMode,
	type EncoderId,
} from "../core/types";
import { encodeJob, CancelledError } from "../pipeline/encoder";
import { isAlreadyEncoded } from "./library";
import { Logger } from "../core/logger";
import { normalizeNlmeansLevelParams, normalizeGradfunLevelParams } from "../video/filters";
import {
	runPreviewEncode,
	deletePreviewDir,
	previewSettingsFingerprint,
	DEFAULT_PREVIEW_OPTIONS,
	type PreviewEncodeOptions,
} from "../pipeline/preview-encoder";
import { normalizeVsFilterChain } from "../video/vs-filters";
import { getDefaultJobSettings } from "../core/config";
import { isValidEncoder } from "../core/encoders";
import { runTranslateOnlyJob } from "../pipeline/translate-only";

const jobs = new Map<string, Job>();
let paused = false;
let processing = false;
let orderCounter = 0;
let appConfig: AppConfig;
let queueFile = "";
let settingsFile = "";
let activeAbortController: AbortController | null = null;
let activeJobId: string | null = null;

const previews = new Map<string, PreviewState>();
let activePreviewJobId: string | null = null;
let activePreviewAbort: AbortController | null = null;

const VALID_VIDEO_ENCODE: VideoEncodeMode[] = ["av1", "off"];
const VALID_AUDIO_ENCODE: AudioEncodeMode[] = ["opus", "copy"];
const VALID_SUBTITLE_PROCESSING: SubtitleProcessingMode[] = ["full", "copy", "translate"];
const VALID_DENOISE_BACKENDS: DenoiseBackend[] = ["cpu", "auto", "vulkan", "opencl"];

export function initStore(config: AppConfig) {
	appConfig = config;
	queueFile = join(config.tempDir, "queue.json");
	settingsFile = join(config.tempDir, "settings.json");
	loadSettings();
	loadQueue();
	processQueue();
}

export function isQueuePaused(): boolean {
	return paused;
}

export function pauseQueue(): boolean {
	if (paused) return false;
	paused = true;
	Logger.info("[store] Queue paused");
	if (activeAbortController) {
		activeAbortController.abort();
	}
	return true;
}

export function resumeQueue(): boolean {
	if (!paused) return false;
	paused = false;
	Logger.info("[store] Queue resumed");
	processQueue();
	return true;
}

function saveQueue(): void {
	if (!queueFile) return;
	try {
		const persistable = Array.from(jobs.values())
			.filter((j) => j.status !== "done" && j.status !== "cancelled")
			.map((j) => {
				const isActive = j.status !== "queued" && j.status !== "error";
				return {
					...j,
					status: isActive ? "queued" : j.status,
					progress: isActive ? 0 : j.progress,
					currentStage: isActive ? "Waiting in queue" : j.currentStage,
					steps: isActive ? [] : j.steps,
					startedAt: isActive ? undefined : j.startedAt,
					finishedAt: isActive ? undefined : j.finishedAt,
				};
			});
		writeFileSync(queueFile, JSON.stringify(persistable));
	} catch (err: any) {
		Logger.warn("[store] Failed to save queue:", { "error.message": err?.message });
	}
}

function loadQueue(): void {
	try {
		if (!existsSync(queueFile)) return;
		const data = JSON.parse(readFileSync(queueFile, "utf-8"));
		if (!Array.isArray(data)) return;

		for (const raw of data) {
			if (!raw.id || !raw.filename || !raw.inputPath) continue;
			try {
				statSync(raw.inputPath);
			} catch {
				Logger.info(`[store] Skipping restored job ${raw.id}: input file missing`);
				continue;
			}

			const restoredSettings = raw.settings && typeof raw.settings === "object" ? raw.settings : {};
			const restoredBitrates = restoredSettings.audioBitrates && typeof restoredSettings.audioBitrates === "object" ? restoredSettings.audioBitrates : {};
			raw.settings = {
				...appConfig.defaults,
				...restoredSettings,
				audioBitrates: { ...appConfig.defaults.audioBitrates, ...restoredBitrates },
			};

			jobs.set(raw.id, raw as Job);
			if (raw.queueOrder > orderCounter) {
				orderCounter = raw.queueOrder;
			}
		}

		const count = jobs.size;
		if (count > 0) {
			Logger.info(`[store] Restored ${count} job(s) from queue file`);
		}
	} catch (err: any) {
		Logger.warn("[store] Failed to load queue:", { "error.message": err?.message });
	}
}

function saveSettings(): void {
	if (!settingsFile) return;
	try {
		writeFileSync(settingsFile, JSON.stringify(appConfig.defaults, null, 2));
	} catch (err: any) {
		Logger.warn("[store] Failed to save settings:", { "error.message": err?.message });
	}
}

function loadSettings(): void {
	try {
		if (!existsSync(settingsFile)) return;
		const raw = JSON.parse(readFileSync(settingsFile, "utf-8"));
		if (!raw || typeof raw !== "object") return;
		const restoredBitrates = raw.audioBitrates && typeof raw.audioBitrates === "object" ? raw.audioBitrates : {};
		appConfig.defaults = {
			...appConfig.defaults,
			...raw,
			audioBitrates: { ...appConfig.defaults.audioBitrates, ...restoredBitrates },
		};
		Logger.info("[store] Restored defaults from settings.json");
	} catch (err: any) {
		Logger.warn("[store] Failed to load settings:", { "error.message": err?.message });
	}
}

export function getAppConfig(): AppConfig {
	return appConfig;
}

type Sanitizer = (value: unknown, current: any) => any;

const bool: Sanitizer = (v) => (typeof v === "boolean" ? v : undefined);
const str =
	(max = 2000): Sanitizer =>
	(v) =>
		typeof v === "string" ? v.slice(0, max) : undefined;
const enumOf =
	(values: readonly string[]): Sanitizer =>
	(v) =>
		typeof v === "string" && values.includes(v) ? v : undefined;
const numIn =
	(min: number, max: number): Sanitizer =>
	(v) =>
		typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : undefined;
const intIn =
	(min: number, max: number): Sanitizer =>
	(v) =>
		typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : undefined;
const strList = (v: unknown): string[] | undefined =>
	Array.isArray(v)
		? v
				.filter((x): x is string => typeof x === "string")
				.map((s) => s.trim())
				.filter((s) => s.length > 0)
		: undefined;

const SETTINGS_SANITIZERS: { [K in keyof JobSettings]?: Sanitizer } = {
	encoder: (v) => (isValidEncoder(v as string) ? (v as EncoderId) : undefined),
	manualCrf: numIn(1, 70), // NOTE: original did not round CRF — numIn preserves that
	manualPreset: intIn(-1, 13), // original rounded preset
	customEncoderParams: str(2000),

	quality: enumOf(["low", "medium", "high"]),
	finalSpeed: enumOf(["slower", "slow", "medium", "fast", "faster"]),
	videoEncode: enumOf(["av1", "off"]),
	audioEncode: enumOf(["opus", "copy"]),
	subtitleProcessing: enumOf(VALID_SUBTITLE_PROCESSING),

	crop: enumOf(["off", "auto"]),
	cropLimit: numIn(0, 1),
	denoise: enumOf(["off", "auto", "light", "medium", "heavy"]),
	deband: enumOf(["off", "light", "medium", "heavy"]),
	denoiseBackend: enumOf(["cpu", "auto", "vulkan", "opencl"]),
	gpuDevice: str(64),

	downscale: bool,
	skipBoosting: bool,
	noPhaseInv: bool,
	dedupeSubtitles: bool,
	keepBestAudioChannelsOnly: bool,
	removeCommentaryAudio: bool,

	audioLanguages: strList,
	subtitleLanguages: strList,

	autoDenoiseThresholds: (v, cur) => {
		const t = v as { light?: unknown; medium?: unknown; heavy?: unknown };
		if (t && typeof t.light === "number" && typeof t.medium === "number" && typeof t.heavy === "number") {
			return { light: t.light, medium: t.medium, heavy: t.heavy };
		}
		return undefined;
	},
	nlmeansParams: (v, cur) => (v ? normalizeNlmeansLevelParams(v as any, cur) : undefined),
	gradfunParams: (v, cur) => (v ? normalizeGradfunLevelParams(v as any, cur) : undefined),
	vsFilters: (v) => (Array.isArray(v) ? normalizeVsFilterChain(v as any) : undefined),
	audioBitrates: (v, cur) => (v && typeof v === "object" ? { ...cur, ...(v as object) } : undefined),

	removeDescriptiveAudio: bool,
	removeKaraokeAudio: bool,
	dropCompatibilityAudio: bool,
	audioCodecPriority: enumOf(["lossless-first", "smallest-first"]),
	preferUncensoredAudio: bool,
	dedupeAudio: bool,
	renameAudioTracks: bool,
	detectCommentaryAudio: bool,
	detectDescriptiveAudio: bool,
	detectKaraokeAudio: bool,
	audioLanguagePriority: strList,

	subtitleLanguagePriority: strList,

	subtitleLangDetect: enumOf(["enabled", "und-only", "disabled"]),
	subtitleLangDetectConfidence: numIn(0, 1),
	detectSignsSongs: bool,
	detectSDH: bool,
	detectHonorifics: bool,

	subtitleSourcePriority: enumOf(["official-first", "fansub-first"]),
	subtitleFansubTiebreak: enumOf(["alphabetical", "source-order"]),
	subtitleFormatPriority: enumOf(["text-first", "picture-first"]),
	dropPictureSubtitles: bool,
	dedupeAcrossFormat: bool,
	renameSubtitleTracks: bool,
	compressSubtitles: bool,
	compressSubtitlesMinSavings: numIn(0, 100),
	removeSDHSubtitles: bool,
	removeCommentarySubtitles: bool,
	removeForcedSignsSongs: bool,
	removeStoryboardSubtitles: bool,
	removeHonorificsSubtitles: bool,
	signsSongsStyleRatio: numIn(0, 1),
	signsSongsLineRatio: numIn(0, 1),
	sdhRatioThreshold: numIn(0, 1),
	sdhMinLines: intIn(0, 10000),
	honorificsMinCount: intIn(0, 10000),
	honorificsRatio: numIn(1, 100),
	assumeMislabeledTracks: bool,

	convertSrtToAss: bool,
	restyleAssFont: bool,
	removeUnusedFonts: bool,
	assRestyleTargets: strList,
	fontGroup: str(256),

	translateSubtitles: bool,
	translateProvider: enumOf(["openai", "anthropic"]),
	translateBaseUrl: str(512),
	translateModel: str(128),
	translateApiKey: str(512),
	translateTargetLanguages: strList,
	translateBatchSize: intIn(1, 1000),
	translateSignsSongs: bool,
	translateMaxTokens: intIn(512, 131072),
	translateTimeoutMs: intIn(1000, 3600000),
	translateConcurrency: intIn(1, 16),
	translateSourceTrack: (v) => (v === "auto" ? "auto" : typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined),
};

function sanitizeSettingsInto(target: JobSettings, partial: Partial<JobSettings>): void {
	for (const key of Object.keys(SETTINGS_SANITIZERS) as (keyof JobSettings)[]) {
		if (!(key in partial)) continue;
		const next = SETTINGS_SANITIZERS[key]!((partial as Record<string, unknown>)[key], (target as any)[key]);
		if (next !== undefined) (target as any)[key] = next;
	}
}

export function updateDefaults(settings: Partial<JobSettings>): JobSettings {
	sanitizeSettingsInto(appConfig.defaults, settings);
	saveSettings();
	return appConfig.defaults;
}

export function updateJobSettings(id: string, settings: Partial<JobSettings>): Job | null {
	const job = jobs.get(id);
	if (!job || job.status !== "queued") return null;
	sanitizeSettingsInto(job.settings, settings);
	saveQueue();
	return job;
}

export function resetDefaults(): JobSettings {
	appConfig.defaults = getDefaultJobSettings();
	try {
		if (settingsFile && existsSync(settingsFile)) unlinkSync(settingsFile);
	} catch (err: any) {
		Logger.warn("[store] Failed to delete settings.json:", { "error.message": err?.message });
	}
	Logger.info("[store] Defaults reset");
	return appConfig.defaults;
}

export function getAllJobs(): Job[] {
	return Array.from(jobs.values()).sort((a, b) => {
		const order: Record<string, number> = {
			probing: 0,
			encoding_video: 0,
			encoding_audio: 0,
			muxing: 0,
			queued: 1,
			done: 2,
			error: 3,
			cancelled: 3,
		};
		const diff = (order[a.status] ?? 1) - (order[b.status] ?? 1);
		if (diff !== 0) return diff;
		if (a.status === "queued" && b.status === "queued") {
			return a.queueOrder - b.queueOrder;
		}
		return (a.startedAt || 0) - (b.startedAt || 0);
	});
}

export function getJob(id: string): Job | undefined {
	return jobs.get(id);
}

export function addJob(filename: string, inputPath: string, relativePath: string = "", replaceSource: boolean = false): Job {
	for (const job of jobs.values()) {
		if (job.inputPath === inputPath && job.status !== "error" && job.status !== "done") {
			return job;
		}
	}

	const id = crypto.randomUUID().slice(0, 8);
	const job: Job = {
		id,
		filename,
		inputPath,
		relativePath,
		status: "queued",
		progress: 0,
		queueOrder: ++orderCounter,
		currentStage: "Waiting in queue",
		steps: [],
		settings: {
			...appConfig.defaults,
			audioBitrates: { ...appConfig.defaults.audioBitrates },
			autoDenoiseThresholds: { ...appConfig.defaults.autoDenoiseThresholds },
			nlmeansParams: {
				light: { ...appConfig.defaults.nlmeansParams.light },
				medium: { ...appConfig.defaults.nlmeansParams.medium },
				heavy: { ...appConfig.defaults.nlmeansParams.heavy },
			},
			gradfunParams: {
				light: { ...appConfig.defaults.gradfunParams.light },
				medium: { ...appConfig.defaults.gradfunParams.medium },
				heavy: { ...appConfig.defaults.gradfunParams.heavy },
			},
		},
		replaceSource,
	};

	jobs.set(id, job);
	saveQueue();
	processQueue();
	return job;
}

export function scanLibraryFolder(folderPath: string): { added: number; skipped: number; alreadyEncoded: number } {
	let added = 0;
	let skipped = 0;
	let alreadyEncoded = 0;

	function scan(dir: string) {
		try {
			const entries = readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				const fullPath = join(dir, entry.name);

				if (entry.isDirectory()) {
					scan(fullPath);
					continue;
				}

				const ext = extname(entry.name).toLowerCase();
				if (!MEDIA_EXTENSIONS.has(ext)) continue;

				if (appConfig.defaults.subtitleProcessing !== "translate" && isAlreadyEncoded(entry.name, appConfig.organization)) {
					alreadyEncoded++;
					continue;
				}

				let alreadyExists = false;
				for (const job of jobs.values()) {
					if (job.inputPath === fullPath && job.status !== "error" && job.status !== "done") {
						alreadyExists = true;
						break;
					}
				}

				if (alreadyExists) {
					skipped++;
					continue;
				}

				const folderName = basename(folderPath);
				const rel = relative(folderPath, dir);
				const relativePath = rel === "." ? folderName : `${folderName}/${rel}`;
				const displayName = relativePath ? `${relativePath}/${entry.name}` : entry.name;

				Logger.info(`[library] Queuing: ${displayName}`);
				addJob(entry.name, fullPath, relativePath, true);
				added++;
			}
		} catch (err: any) {
			Logger.error(`[library] Error scanning ${dir}:`, { "error.message": err?.message });
		}
	}

	scan(folderPath);
	return { added, skipped, alreadyEncoded };
}

export function scanLibraryPath(targetPath: string): { added: number; skipped: number; alreadyEncoded: number } {
	const resolved = resolve(targetPath);

	try {
		const stat = statSync(resolved);
		if (stat.isDirectory()) {
			return scanLibraryFolder(resolved);
		}
	} catch {
		return { added: 0, skipped: 0, alreadyEncoded: 0 };
	}

	const filename = basename(resolved);
	const ext = extname(filename).toLowerCase();

	if (!MEDIA_EXTENSIONS.has(ext)) {
		return { added: 0, skipped: 0, alreadyEncoded: 0 };
	}

	const translateOnly = appConfig.defaults.subtitleProcessing === "translate";
	if (!translateOnly && isAlreadyEncoded(filename, appConfig.organization)) {
		return { added: 0, skipped: 0, alreadyEncoded: 1 };
	}

	for (const job of jobs.values()) {
		if (job.inputPath === resolved && job.status !== "error" && job.status !== "done") {
			return { added: 0, skipped: 1, alreadyEncoded: 0 };
		}
	}

	const dir = dirname(resolved);
	const folderName = basename(dir);
	addJob(filename, resolved, folderName, true);
	return { added: 1, skipped: 0, alreadyEncoded: 0 };
}

export function removeJob(id: string): boolean {
	const job = jobs.get(id);
	if (!job) return false;
	if (job.status !== "queued" && job.status !== "done" && job.status !== "error" && job.status !== "cancelled") return false;
	jobs.delete(id);
	clearPreviewFor(id);
	saveQueue();
	return true;
}

export function retryJob(id: string): Job | null {
	const job = jobs.get(id);
	if (!job || job.status !== "error") return null;

	job.status = "queued";
	job.progress = 0;
	job.queueOrder = ++orderCounter;
	job.currentStage = "Waiting in queue";
	job.steps = [];
	job.error = undefined;
	job.startedAt = undefined;
	job.finishedAt = undefined;

	saveQueue();
	processQueue();
	return job;
}

export function cancelJob(id: string): boolean {
	if (!activeJobId || activeJobId !== id || !activeAbortController) return false;
	Logger.info(`[store] Cancelling job ${id}`);
	activeAbortController.abort();
	return true;
}

export function moveJob(id: string, direction: "up" | "down" | "top" | "bottom"): boolean {
	const job = jobs.get(id);
	if (!job || job.status !== "queued") return false;

	const queued = Array.from(jobs.values())
		.filter((j) => j.status === "queued")
		.sort((a, b) => a.queueOrder - b.queueOrder);

	const idx = queued.findIndex((j) => j.id === id);
	if (idx === -1) return false;

	if (direction === "up" && idx > 0) {
		const prev = queued[idx - 1]!;
		const tmp = job.queueOrder;
		job.queueOrder = prev.queueOrder;
		prev.queueOrder = tmp;
	} else if (direction === "down" && idx < queued.length - 1) {
		const next = queued[idx + 1]!;
		const tmp = job.queueOrder;
		job.queueOrder = next.queueOrder;
		next.queueOrder = tmp;
	} else if (direction === "top" && idx > 0) {
		const minOrder = queued[0]!.queueOrder;
		job.queueOrder = minOrder - 1;
	} else if (direction === "bottom" && idx < queued.length - 1) {
		const maxOrder = queued[queued.length - 1]!.queueOrder;
		job.queueOrder = maxOrder + 1;
	} else {
		return false;
	}

	saveQueue();
	return true;
}

export function reorderJobs(orderedIds: string[]): boolean {
	let seq = 1;
	for (const id of orderedIds) {
		const job = jobs.get(id);
		if (job && job.status === "queued") {
			job.queueOrder = seq++;
		}
	}
	saveQueue();
	return true;
}

async function processQueue() {
	if (processing || paused) return;

	const next = Array.from(jobs.values())
		.filter((j) => j.status === "queued")
		.sort((a, b) => a.queueOrder - b.queueOrder)[0];
	if (!next) return;

	clearPreviewFor(next.id);

	processing = true;
	next.startedAt = Date.now();
	saveQueue();

	const controller = new AbortController();
	activeAbortController = controller;
	activeJobId = next.id;

	const updateFn = (partial: Partial<Job>) => {
		Object.assign(next, partial);
	};

	try {
		if (next.settings.subtitleProcessing === "translate") {
			await runTranslateOnlyJob(next, appConfig, updateFn, controller.signal);
		} else {
			await encodeJob(next, appConfig, updateFn, controller.signal);
		}
	} catch (err: any) {
		if (err instanceof CancelledError) {
			if (paused) {
				next.status = "queued";
				next.progress = 0;
				next.currentStage = "Waiting in queue";
				next.steps = [];
				next.startedAt = undefined;
				next.finishedAt = undefined;
				next.error = undefined;
				Logger.info(`[store] Job ${next.id} paused and returned to queue`);
			} else {
				jobs.delete(next.id);
				Logger.info(`[store] Job ${next.id} cancelled and removed`);
			}
		} else {
			next.status = "error";
			next.error = err?.message || String(err);
		}
	}

	activeAbortController = null;
	activeJobId = null;
	processing = false;
	saveQueue();
	processQueue();
}

export function getPreviewState(jobId: string): PreviewState | null {
	return previews.get(jobId) ?? null;
}

export function isPreviewRunning(): boolean {
	return activePreviewJobId !== null;
}

export type StartPreviewResult = { ok: true; state: PreviewState } | { ok: false; error: string; status: 400 | 404 | 409 };

export function startPreview(jobId: string, options?: Partial<PreviewEncodeOptions>): StartPreviewResult {
	if (activePreviewJobId !== null) {
		return { ok: false, error: `Another preview is already running (job ${activePreviewJobId})`, status: 409 };
	}

	const job = jobs.get(jobId);
	if (!job) return { ok: false, error: "Job not found", status: 404 };
	if (job.status === "done") return { ok: false, error: "Preview only available for unfinished jobs", status: 400 };

	const opts: PreviewEncodeOptions = { ...DEFAULT_PREVIEW_OPTIONS, ...(options || {}) };

	const controller = new AbortController();
	activePreviewJobId = jobId;
	activePreviewAbort = controller;

	const state: PreviewState = {
		jobId,
		status: "running",
		progress: 0,
		currentDetail: "Starting…",
		samples: [],
		settingsFingerprint: previewSettingsFingerprint(job.settings),
		sampleCount: opts.sampleCount,
		windowSeconds: opts.windowSeconds,
		startedAt: Date.now(),
	};
	previews.set(jobId, state);

	(async () => {
		try {
			await runPreviewEncode({
				job,
				config: appConfig,
				options: opts,
				signal: controller.signal,
				onUpdate: (partial) => {
					const cur = previews.get(jobId);
					if (cur) Object.assign(cur, partial);
				},
			});
			const cur = previews.get(jobId);
			if (cur) {
				cur.status = "done";
				cur.progress = 100;
				cur.currentDetail = "Complete";
				cur.finishedAt = Date.now();
			}
			Logger.info(`[preview] Job ${jobId} preview complete`);
		} catch (err) {
			const cur = previews.get(jobId);
			if (cur) {
				if (err instanceof CancelledError) {
					cur.status = "cancelled";
					cur.currentDetail = "Cancelled";
				} else {
					cur.status = "error";
					cur.error = err instanceof Error ? err.message : String(err);
					cur.currentDetail = "Failed";
				}
				cur.finishedAt = Date.now();
			}
			Logger.warn(`[preview] Job ${jobId} preview ended: ${err instanceof Error ? err.message : err}`);
		} finally {
			if (activePreviewJobId === jobId) {
				activePreviewJobId = null;
				activePreviewAbort = null;
			}
		}
	})();

	return { ok: true, state };
}

export function cancelPreview(jobId: string): boolean {
	if (activePreviewJobId !== jobId || !activePreviewAbort) return false;
	Logger.info(`[preview] Cancelling preview for job ${jobId}`);
	activePreviewAbort.abort();
	return true;
}

export function clearPreviewFor(jobId: string): void {
	if (activePreviewJobId === jobId && activePreviewAbort) {
		activePreviewAbort.abort();
		activePreviewJobId = null;
		activePreviewAbort = null;
	}
	previews.delete(jobId);
	deletePreviewDir(appConfig, jobId);
}

/** Repoint any saved `fontGroup` reference (defaults + every job) after a group rename. */
export function renameFontGroupReferences(oldLabel: string, newLabel: string): number {
	let count = 0;
	if (appConfig.defaults.fontGroup === oldLabel) {
		appConfig.defaults.fontGroup = newLabel;
		count++;
	}
	for (const job of jobs.values()) {
		if (job.settings.fontGroup === oldLabel) {
			job.settings.fontGroup = newLabel;
			count++;
		}
	}
	if (count > 0) {
		saveSettings();
		saveQueue();
	}
	return count;
}
