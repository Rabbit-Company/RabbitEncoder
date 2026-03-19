import { readdirSync } from "fs";
import { join, extname, relative } from "path";
import { type Job, type JobSettings, type AppConfig, MEDIA_EXTENSIONS } from "./types";
import { encodeJob } from "./encoder";
import { isAlreadyEncoded } from "./library";
import { Logger } from "./logger";

const jobs = new Map<string, Job>();
let processing = false;
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

				const rel = relative(folderPath, dir);
				const relativePath = rel === "." ? "" : rel;
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
	job.currentStage = "Waiting in queue";
	job.steps = [];
	job.error = undefined;
	job.startedAt = undefined;
	job.finishedAt = undefined;

	processQueue();
	return job;
}

async function processQueue() {
	if (processing) return;

	const next = Array.from(jobs.values()).find((j) => j.status === "queued");
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
