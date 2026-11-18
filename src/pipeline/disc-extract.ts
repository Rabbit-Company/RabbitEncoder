import { existsSync, mkdirSync, readFileSync, rmSync, statfsSync, statSync } from "fs";
import { basename, join } from "path";
import { Logger } from "../core/logger";
import { CancelledError, humanSize, run } from "../core/process";
import type { AppConfig, DiscPlan, Job, JobStep } from "../core/types";
import { parseMpls } from "../bdmv/mpls";
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

export function buildDiscExtractArgs(plan: DiscPlan, outputPath: string): string[] {
	const args = ["mkvmerge", "--gui-mode", "-o", outputPath];
	if (!wholePlaylist(plan)) args.push("--split", `parts:${splitTimestamp(plan.start)}-${splitTimestamp(plan.end)}`);
	args.push(playlistPath(plan));
	return args;
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
		const merged = await run(buildDiscExtractArgs(plan, outputPath), {
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
