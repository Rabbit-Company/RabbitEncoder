import { readdirSync, statSync } from "fs";
import { resolve, dirname, join, extname, relative, basename } from "path";
import { type Job, type JobSettings, type AppConfig, MEDIA_EXTENSIONS } from "./types";
import { encodeJob } from "./encoder";
import { isAlreadyEncoded } from "./library";
import { Logger } from "./logger";

const jobs = new Map<string, Job>();
let processing = false;
let orderCounter = 0;
let appConfig: AppConfig;

export function initStore(config: AppConfig) {
	appConfig = config;
}

export function getAppConfig(): AppConfig {
	return appConfig;
}

export function updateDefaults(settings: Partial<JobSettings>): JobSettings {
	if (settings.quality) appConfig.defaults.quality = settings.quality;
	if (settings.finalSpeed) appConfig.defaults.finalSpeed = settings.finalSpeed;
	if (settings.audioBitrates) {
		appConfig.defaults.audioBitrates = {
			...appConfig.defaults.audioBitrates,
			...settings.audioBitrates,
		};
	}
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
		},
		replaceSource,
	};

	jobs.set(id, job);
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

				if (isAlreadyEncoded(entry.name, appConfig.organization)) {
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

/**
 * Encode a single path. Either a folder (recursive) or an individual file.
 */
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

	if (isAlreadyEncoded(filename, appConfig.organization)) {
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

export function updateJobSettings(id: string, settings: Partial<JobSettings>): Job | null {
	const job = jobs.get(id);
	if (!job || job.status !== "queued") return null;

	if (settings.quality) job.settings.quality = settings.quality;
	if (settings.finalSpeed) job.settings.finalSpeed = settings.finalSpeed;
	if (settings.audioBitrates) {
		job.settings.audioBitrates = {
			...job.settings.audioBitrates,
			...settings.audioBitrates,
		};
	}

	return job;
}

export function removeJob(id: string): boolean {
	const job = jobs.get(id);
	if (!job) return false;
	if (job.status !== "queued" && job.status !== "done" && job.status !== "error") return false;
	jobs.delete(id);
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

	processQueue();
	return job;
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
	return true;
}

async function processQueue() {
	if (processing) return;

	const next = Array.from(jobs.values())
		.filter((j) => j.status === "queued")
		.sort((a, b) => a.queueOrder - b.queueOrder)[0];
	if (!next) return;

	processing = true;
	next.startedAt = Date.now();

	const updateFn = (partial: Partial<Job>) => {
		Object.assign(next, partial);
	};

	try {
		await encodeJob(next, appConfig, updateFn);
	} catch (err: any) {
		next.status = "error";
		next.error = err?.message || String(err);
	}

	processing = false;

	processQueue();
}
