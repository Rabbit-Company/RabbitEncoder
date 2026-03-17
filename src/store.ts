import type { Job, JobSettings, AppConfig } from "./types";
import { encodeJob } from "./encoder";

const jobs = new Map<string, Job>();
let processing = false;
let appConfig: AppConfig;

export function initStore(config: AppConfig) {
	appConfig = config;
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

export function addJob(filename: string, inputPath: string): Job {
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
		status: "queued",
		progress: 0,
		currentStage: "Waiting in queue",
		steps: [],
		settings: {
			...appConfig.defaults,
			audioBitrates: { ...appConfig.defaults.audioBitrates },
		},
	};

	jobs.set(id, job);
	processQueue();
	return job;
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
