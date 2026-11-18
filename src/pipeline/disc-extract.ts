import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync } from "fs";
import { basename, join } from "path";
import { Logger } from "../core/logger";
import { CancelledError, humanSize, readTimecodes, run } from "../core/process";
import type { AppConfig, DiscPlan, Job, JobStep } from "../core/types";
import { MPLS_CLOCK, parseMpls, type Mpls } from "../bdmv/mpls";
import { resolveUniqueOutputPath } from "./output";
import { mkvtoolnixProgress } from "./prepare-progress";
import { durationSeconds, identifyMatroska } from "./repair";

export const playlistPath = (plan: Pick<DiscPlan, "discPath" | "playlist">): string => join(plan.discPath, "BDMV", "PLAYLIST", `${plan.playlist}.mpls`);

export const discStagingDir = (config: AppConfig): string => join(config.tempDir, "discs");

/** mkvmerge's HH:MM:SS.nnnnnnnnn. */
export function splitTimestamp(seconds: number): string {
	const ns = Math.max(0, Math.round(seconds * 1e9));
	const s = Math.floor(ns / 1e9);
	const frac = String(ns % 1e9).padStart(9, "0");
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}.${frac}`;
}

/** Whether the range is the whole playlist, so nothing needs cutting. */
export const wholePlaylist = (plan: Pick<DiscPlan, "start" | "end" | "duration">): boolean => plan.start <= 0.5 && plan.end >= plan.duration - 0.5;

/** mkvmerge's rates for the Blu-ray frame rate codes. */
const FRAME_RATES: Record<number, string> = { 1: "24000/1001p", 2: "24p", 3: "25p", 4: "30000/1001p", 6: "50p", 7: "60000/1001p" };
/** 480p, 720p, 1080p, 576p and 2160p. Interlaced video keeps its own timing. */
const PROGRESSIVE = [3, 5, 6, 7, 8];

/**
 * The frame rate every clip of the range shares, when its video is
 * progressive. mkvmerge leaves a few milliseconds of gap where one clip joins
 * the next, as where an episode meets its credits, which makes the remux
 * variable frame rate, so the range is retimed to this rate.
 */
export function constantFrameRate(mpls: Mpls, start: number, end: number): string | null {
	const rates = new Set<string>();
	let at = 0;
	for (const item of mpls.items) {
		const length = (item.outTime - item.inTime) / MPLS_CLOCK;
		const overlaps = at < end && at + length > start;
		at += length;
		if (!overlaps) continue;
		const video = item.video[0];
		const rate = video?.frameRate !== undefined ? FRAME_RATES[video.frameRate] : undefined;
		if (!video || !rate || !PROGRESSIVE.includes(video.videoFormat ?? 0)) return null;
		rates.add(rate);
	}
	return rates.size === 1 ? [...rates][0]! : null;
}

/** Milliseconds per frame of an mkvmerge rate such as 24000/1001p. */
const frameMsOf = (rate: string): number => {
	const [num, den = "1"] = rate.replace(/p$/, "").split("/");
	return (1000 * Number(den)) / Number(num);
};

/**
 * Whether the timestamps step one frame at a time but jump by a few
 * milliseconds somewhere, as where two clips join. Dropped or doubled frames
 * are left for the encode, which fills gaps.
 */
export function onlyJoinJitter(timecodesMs: number[], frameMs: number): boolean {
	const sorted = [...timecodesMs].sort((a, b) => a - b);
	let jitter = false;
	for (let i = 1; i < sorted.length; i++) {
		const off = Math.abs(sorted[i]! - sorted[i - 1]! - frameMs);
		if (off >= frameMs / 2) return false;
		if (off > 2) jitter = true;
	}
	return jitter;
}

export function buildDiscExtractArgs(plan: DiscPlan, outputPath: string, retime?: { track: number; rate: string }): string[] {
	const args = ["mkvmerge", "--gui-mode", "-o", outputPath];
	if (!wholePlaylist(plan)) args.push("--split", `parts:${splitTimestamp(plan.start)}-${splitTimestamp(plan.end)}`);
	if (retime) args.push("--default-duration", `${retime.track}:${retime.rate}`);
	args.push(playlistPath(plan));
	return args;
}

/** The video track to retime and its rate, or nothing when the range mixes rates or the playlist cannot be read. */
async function retimeOf(plan: DiscPlan, signal?: AbortSignal): Promise<{ track: number; rate: string } | undefined> {
	try {
		const rate = constantFrameRate(parseMpls(readFileSync(playlistPath(plan))), plan.start, plan.end);
		if (!rate) return undefined;
		const video = (await identifyMatroska(playlistPath(plan), signal)).tracks?.filter((t) => t.type === "video") ?? [];
		return video.length === 1 ? { track: video[0]!.id, rate } : undefined;
	} catch (error) {
		if (error instanceof CancelledError) throw error;
		Logger.warn(`[disc] Could not read the frame rate of ${plan.playlist}, keeping the disc's timing: ${(error as Error)?.message || error}`);
		return undefined;
	}
}

/** Bytes the range takes on the disc, from the share of its clips it plays. */
function estimatedBytes(plan: DiscPlan): number {
	try {
		const mpls = parseMpls(readFileSync(playlistPath(plan)));
		const clips = new Set(mpls.items.map((item) => item.clip));
		let total = 0;
		for (const clip of clips) total += statSync(join(plan.discPath, "BDMV", "STREAM", `${clip}.m2ts`)).size;
		return plan.duration > 0 ? (total * (plan.end - plan.start)) / plan.duration : total;
	} catch {
		return 0;
	}
}

/**
 * Remuxes one episode or extra of a disc into an MKV in the temp folder, with
 * its chapters and the track languages the disc gives. Returns its path for
 * the encode that follows.
 */
export async function runDiscJob(job: Job, config: AppConfig, updateJob: (partial: Partial<Job>) => void, signal?: AbortSignal): Promise<string> {
	const plan = job.discPlan;
	if (!plan) throw new Error("Disc job has no plan");
	const steps: JobStep[] = [
		{ label: "Read disc", status: "pending", progress: 0 },
		{ label: "Remux from disc", status: "pending", progress: 0 },
	];
	const setStep = (index: number, partial: Partial<JobStep>) => {
		const step = steps[index]!;
		if (partial.status === "active" && !step.startedAt) step.startedAt = Date.now();
		if ((partial.status === "done" || partial.status === "error") && !step.finishedAt) step.finishedAt = Date.now();
		Object.assign(step, partial);
		updateJob({
			steps: [...steps],
			progress: Math.round((steps.reduce((sum, item) => sum + item.progress, 0) / steps.length) * 100) / 100,
			currentStage: steps.find((item) => item.status === "active")?.label || job.currentStage,
		});
	};
	const checkCancelled = () => {
		if (signal?.aborted) throw new CancelledError();
	};

	const dir = discStagingDir(config);
	mkdirSync(dir, { recursive: true });
	const outputPath = resolveUniqueOutputPath(dir, plan.filename);
	try {
		setStep(0, { status: "active", progress: 10 });
		updateJob({ status: "probing" });
		if (!existsSync(playlistPath(plan))) throw new Error(`The disc no longer has playlist ${plan.playlist}`);
		const needed = estimatedBytes(plan);
		const stats = statfsSync(dir);
		const free = stats.bavail * stats.bsize;
		if (needed && free < needed + 1024 ** 3)
			throw new Error(`The temp folder has ${humanSize(free)} free, and this ${wholePlaylist(plan) ? "playlist" : "episode"} needs about ${humanSize(needed)}`);
		setStep(0, { status: "done", progress: 100, detail: needed ? `About ${humanSize(needed)}` : undefined });

		checkCancelled();
		setStep(1, { status: "active", progress: 0, detail: "Copying streams" });
		updateJob({ status: "muxing" });
		// mkvmerge counts progress over the whole playlist and stops after the range.
		const share = wholePlaylist(plan) || plan.duration <= 0 ? 1 : Math.min(1, Math.max(0.01, plan.end / plan.duration));
		// It first counts from 0 to 100 while it scans the playlist's files.
		let scanning = false;
		const retime = await retimeOf(plan, signal);
		const merged = await run(buildDiscExtractArgs(plan, outputPath, retime), {
			signal,
			onStdoutLine: (line) => {
				if (line.startsWith("#GUI#begin_scanning_playlists")) scanning = true;
				if (line.startsWith("#GUI#end_scanning_playlists")) scanning = false;
				const percent = scanning ? null : mkvtoolnixProgress(line);
				if (percent !== null) setStep(1, { progress: Math.min(99, Math.round(percent / share)) });
			},
		});
		checkCancelled();
		if (merged.code !== 0 && merged.code !== 1) throw new Error(`mkvmerge failed (exit ${merged.code}): ${(merged.stderr || merged.stdout).slice(-800)}`);
		if (merged.code === 1) Logger.warn(`[disc] mkvmerge completed with warnings: ${(merged.stderr || merged.stdout).slice(-500)}`);
		if (!existsSync(outputPath)) throw new Error("mkvmerge wrote no file");

		if (retime) await makeConstantFrameRate(outputPath, retime.rate, dir, (detail) => setStep(1, { detail }), signal);

		const got = durationSeconds(await identifyMatroska(outputPath, signal));
		const wanted = plan.end - plan.start;
		if (got > 0 && Math.abs(got - wanted) > Math.max(5, wanted * 0.02))
			throw new Error(`The remux is ${Math.round(got)} s long, but the range is ${Math.round(wanted)} s`);
		setStep(1, { status: "done", progress: 100, detail: `${humanSize(statSync(outputPath).size)} in ${basename(dir)}` });
		updateJob({ status: "done", currentStage: "Queued for encode", progress: 100, finishedAt: Date.now(), outputFilename: plan.filename });
		return outputPath;
	} catch (error) {
		rmSync(outputPath, { force: true });
		const failed = steps.find((s) => s.status === "active");
		if (failed) failed.status = "error";
		if (error instanceof CancelledError) throw error;
		updateJob({ status: "error", currentStage: "Failed", steps: [...steps], error: (error as Error)?.message || String(error) });
		throw error;
	}
}

/**
 * mkvmerge keeps the jumps of a few milliseconds where clips join when it
 * reads a playlist, which the encode would take for variable frame rate.
 * Read from the remux, it puts every frame on the rate's grid.
 */
async function makeConstantFrameRate(path: string, rate: string, dir: string, report: (detail: string) => void, signal?: AbortSignal): Promise<void> {
	const video = (await identifyMatroska(path, signal)).tracks?.find((t) => t.type === "video");
	if (!video) return;
	const timecodes = join(dir, `${basename(path)}.timestamps.txt`);
	const retimed = join(dir, `${basename(path)}.cfr.mkv`);
	try {
		report("Checking frame timing");
		const extracted = await run(["mkvextract", path, "timestamps_v2", `${video.id}:${timecodes}`], { signal });
		if (signal?.aborted) throw new CancelledError();
		if (extracted.code !== 0 || !onlyJoinJitter(readTimecodes(timecodes), frameMsOf(rate))) return;
		const stats = statfsSync(dir);
		if (stats.bavail * stats.bsize < statSync(path).size + 1024 ** 3) {
			Logger.warn(`[disc] Not enough temp space to make ${basename(path)} constant frame rate, keeping the disc's timing`);
			return;
		}
		report("Making the frame rate constant");
		const merged = await run(["mkvmerge", "-o", retimed, "--default-duration", `${video.id}:${rate}`, path], { signal });
		if (signal?.aborted) throw new CancelledError();
		if (merged.code !== 0 && merged.code !== 1)
			throw new Error(`mkvmerge could not retime the remux (exit ${merged.code}): ${(merged.stderr || merged.stdout).slice(-500)}`);
		renameSync(retimed, path);
		Logger.info(`[disc] Retimed ${basename(path)} to a constant ${rate.replace(/p$/, "")} fps`);
	} finally {
		rmSync(timecodes, { force: true });
		rmSync(retimed, { force: true });
	}
}
