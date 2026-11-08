import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import type { EncodeMeasurement, EncodeMetric, PreviewCrop } from "../core/types";
import { Logger } from "../core/logger";
import { measureBlocker, measureStarts, probeVideo, vsColour } from "../compare/compare";
import { measureVideoPair, summarize } from "../compare/metrics";

/** Where finished jobs keep their measurement and the ffms2 indexes of both videos. */
let storeDir = "";
const measurements = new Map<string, EncodeMeasurement>();
const running = new Map<string, AbortController>();

export function initEncodeMeasure(tempDir: string, jobIds: Set<string>): void {
	storeDir = join(tempDir, "encode-measure");
	mkdirSync(storeDir, { recursive: true });
	for (const name of readdirSync(storeDir)) {
		if (!jobIds.has(name.replace(/\.json$/, ""))) rmSync(join(storeDir, name), { recursive: true, force: true });
	}
}

const resultPath = (jobId: string) => join(storeDir, `${jobId}.json`);
const workDir = (jobId: string) => join(storeDir, jobId);

function save(jobId: string, m: EncodeMeasurement): void {
	if (!storeDir) return;
	try {
		writeFileSync(resultPath(jobId), JSON.stringify(m));
	} catch (error) {
		Logger.warn(`[measure] Could not save the measurement of ${jobId}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function getEncodeMeasurement(jobId: string): EncodeMeasurement | null {
	const current = measurements.get(jobId);
	if (current) return current;
	if (!storeDir || !existsSync(resultPath(jobId))) return null;
	try {
		const saved = JSON.parse(readFileSync(resultPath(jobId), "utf8")) as EncodeMeasurement;
		// A measurement the server was stopped in the middle of cannot go on.
		if (saved.status === "running") Object.assign(saved, { status: "cancelled", detail: undefined });
		measurements.set(jobId, saved);
		return saved;
	} catch {
		return null;
	}
}

/** Stops a running measurement and forgets the job's result, for a job that is removed or encoded again. */
export function deleteEncodeMeasurement(jobId: string): void {
	running.get(jobId)?.abort();
	measurements.delete(jobId);
	if (storeDir) {
		rmSync(resultPath(jobId), { force: true });
		rmSync(workDir(jobId), { recursive: true, force: true });
	}
}

export function cancelEncodeMeasurement(jobId: string): boolean {
	const ctrl = running.get(jobId);
	if (!ctrl) return false;
	ctrl.abort();
	return true;
}

export interface EncodeMeasureRequest {
	jobId: string;
	sourcePath: string;
	encodedPath: string;
	crop?: PreviewCrop;
	interval: "frame" | number;
	metrics: EncodeMetric[];
	withGrain: boolean;
}

/** Scores the encode against its source over the whole video, in the background. */
export function startEncodeMeasurement(req: EncodeMeasureRequest): EncodeMeasurement {
	if (running.has(req.jobId)) throw new Error("This encode is already being measured");
	const m: EncodeMeasurement = {
		status: "running",
		progress: 0,
		detail: "Reading the videos",
		interval: req.interval,
		metrics: req.metrics,
		withGrain: req.withGrain,
		step: 1,
		firstFrame: 0,
		fps: 0,
		values: {},
		summary: {},
		startedAt: Date.now(),
	};
	measurements.set(req.jobId, m);
	save(req.jobId, m);
	const ctrl = new AbortController();
	running.set(req.jobId, ctrl);
	void runMeasurement(req, m, ctrl.signal).finally(() => {
		running.delete(req.jobId);
		// A job removed while it was measured has no result to keep.
		if (measurements.get(req.jobId) === m) save(req.jobId, m);
	});
	return m;
}

async function runMeasurement(req: EncodeMeasureRequest, m: EncodeMeasurement, signal: AbortSignal): Promise<void> {
	const dir = workDir(req.jobId);
	try {
		mkdirSync(dir, { recursive: true });
		const [source, encoded] = await Promise.all([probeVideo(req.sourcePath, signal), probeVideo(req.encodedPath, signal)]);
		const reference = req.crop ? { ...source, width: req.crop.w, height: req.crop.h } : source;
		const blocker = measureBlocker(reference, encoded);
		if (blocker) throw new Error(blocker.replace("the first video", "the source"));
		const step = req.interval === "frame" ? 1 : Math.max(1, Math.round(req.interval * source.fps));
		const delta = Math.round((source.videoStart - encoded.videoStart) * source.fps);
		const { refStart, distStart } = measureStarts(delta, step);
		const noGrain = (codec: string) => !req.withGrain && codec === "av1";
		Object.assign(m, { step, fps: source.fps, firstFrame: refStart });
		const scores = await measureVideoPair({
			ref: { path: req.sourcePath, start: refStart, index: join(dir, "source.ffindex"), noGrain: noGrain(source.codec), crop: req.crop, ...vsColour(source) },
			dist: { path: req.encodedPath, start: distStart, index: join(dir, "encoded.ffindex"), noGrain: noGrain(encoded.codec), ...vsColour(encoded) },
			step,
			width: reference.width,
			height: reference.height,
			metrics: req.metrics,
			vmafLog: join(dir, "vmaf.json"),
			signal,
			onProgress: (done, total) =>
				Object.assign(m, {
					progress: Math.min(99, Math.round((total ? done / total : 0) * 100)),
					detail: `Measuring ${done.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} frames`,
				}),
		});
		for (const metric of req.metrics) {
			m.values[metric] = scores.map((score) => score[metric] ?? null);
			const summary = summarize(m.values[metric]!, refStart, step);
			if (summary) m.summary[metric] = summary;
		}
		Object.assign(m, { status: "done", progress: 100, detail: undefined, finishedAt: Date.now() });
	} catch (err) {
		if (signal.aborted) Object.assign(m, { status: "cancelled", detail: undefined });
		else {
			Logger.error(`[measure] Measuring the encode of ${req.jobId} failed: ${(err as Error).message}`);
			Object.assign(m, { status: "error", error: (err as Error).message, detail: undefined });
		}
	}
}
