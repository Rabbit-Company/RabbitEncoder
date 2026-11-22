import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from "fs";
import { basename, dirname, join, relative } from "path";
import { Logger } from "../core/logger";
import { discOriginTagLines } from "../core/mkv-tags";
import { CancelledError, humanSize, readTimecodes, run } from "../core/process";
import type { AppConfig, DiscPlan, Job, JobStep } from "../core/types";
import { discLabel, parseDiscSource, type DiscOrigin } from "../bdmv/disc-source";
import { MPLS_CLOCK, parseMpls, playlistTimeline, type Mpls } from "../bdmv/mpls";
import { formatTransferDetail, jobOutputRoot, moveFileWithProgress, resolveUniqueOutputPath } from "./output";
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

export function buildDiscExtractArgs(plan: DiscExtract, outputPath: string, retime?: { track: number; rate: string }): string[] {
	const args = ["mkvmerge", "--gui-mode", "-o", outputPath];
	if (!wholePlaylist(plan)) args.push("--split", `parts:${splitTimestamp(plan.start)}-${splitTimestamp(plan.end)}`);
	if (retime) args.push("--default-duration", `${retime.track}:${retime.rate}`);
	args.push(playlistPath(plan));
	return args;
}

/** The video track to retime and its rate, or nothing when the range mixes rates or the playlist cannot be read. */
async function retimeOf(plan: DiscExtract, signal?: AbortSignal): Promise<{ track: number; rate: string } | undefined> {
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
function estimatedBytes(plan: DiscExtract): number {
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

/** What a remux needs to know about the range. */
export type DiscExtract = Pick<DiscPlan, "discPath" | "playlist" | "start" | "end" | "duration">;

export const discOriginOf = (plan: DiscExtract): DiscOrigin => ({
	label: discLabel(plan.discPath),
	playlist: plan.playlist,
	start: plan.start,
	end: plan.end,
	length: plan.duration,
});

/** Throws when the folder lacks the room for the range, with a gigabyte to spare. Returns the bytes it needs, 0 when unknown. */
function checkSpace(plan: DiscExtract, dir: string): number {
	const needed = estimatedBytes(plan);
	const stats = statfsSync(dir);
	const free = stats.bavail * stats.bsize;
	if (needed && free < needed + 1024 ** 3)
		throw new Error(`The temp folder has ${humanSize(free)} free, and this ${wholePlaylist(plan) ? "playlist" : "episode"} needs about ${humanSize(needed)}`);
	return needed;
}

/**
 * Remuxes a range of a playlist into an MKV with its chapters and the track
 * languages the disc gives, retimed to a constant frame rate where clips join.
 * Every remux of the same range holds the same frames, which film grain
 * measurement relies on when it remuxes an original again.
 */
export async function remuxDiscRange(
	plan: DiscExtract,
	outputPath: string,
	signal: AbortSignal | undefined,
	report: (percent: number | null, detail?: string) => void,
): Promise<void> {
	if (!existsSync(playlistPath(plan))) throw new Error(`The disc no longer has playlist ${plan.playlist}`);
	try {
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
				if (percent !== null) report(Math.min(99, Math.round(percent / share)));
			},
		});
		if (signal?.aborted) throw new CancelledError();
		if (merged.code !== 0 && merged.code !== 1) throw new Error(`mkvmerge failed (exit ${merged.code}): ${(merged.stderr || merged.stdout).slice(-800)}`);
		if (merged.code === 1) Logger.warn(`[disc] mkvmerge completed with warnings: ${(merged.stderr || merged.stdout).slice(-500)}`);
		if (!existsSync(outputPath)) throw new Error("mkvmerge wrote no file");

		await fixRemuxTiming(outputPath, retime?.rate, dirname(outputPath), (detail) => report(null, detail), signal);

		const got = durationSeconds(await identifyMatroska(outputPath, signal));
		const wanted = plan.end - plan.start;
		if (got > 0 && Math.abs(got - wanted) > Math.max(5, wanted * 0.02))
			throw new Error(`The remux is ${Math.round(got)} s long, but the range is ${Math.round(wanted)} s`);
	} catch (error) {
		rmSync(outputPath, { force: true });
		throw error;
	}
}

/**
 * Remuxes an original given as a range of a disc to `outputPath`, after
 * checking its folder has the room. `report` gets what it is doing.
 */
export async function remuxDiscSource(
	sourcePath: string,
	outputPath: string,
	signal: AbortSignal | undefined,
	report: (detail: string) => void,
): Promise<void> {
	const range = parseDiscSource(sourcePath);
	if (!range) throw new Error("The original is not a range of a disc");
	const mpls = playlistPath(range);
	if (!existsSync(mpls)) throw new Error(`The disc of the original no longer has playlist ${range.playlist}`);
	const plan: DiscExtract = { ...range, duration: playlistTimeline(parseMpls(readFileSync(mpls))).duration };
	mkdirSync(dirname(outputPath), { recursive: true });
	checkSpace(plan, dirname(outputPath));
	const name = `${discLabel(range.discPath)} playlist ${range.playlist}`;
	report(`Remuxing ${name} from the disc`);
	await remuxDiscRange(plan, outputPath, signal, (percent, detail) =>
		report(detail ?? `Remuxing ${name} from the disc${percent === null ? "" : `: ${percent}%`}`),
	);
	Logger.info(`[disc] Remuxed ${name} from ${range.discPath}`);
}

/**
 * Runs `use` with an original as a file. An original that is a range of a
 * disc is remuxed into the temp folder first and removed when `use` is done.
 */
export async function withOriginalFile<T>(
	sourcePath: string,
	config: AppConfig,
	signal: AbortSignal | undefined,
	report: (detail: string) => void,
	use: (path: string) => Promise<T>,
): Promise<T> {
	if (!parseDiscSource(sourcePath)) return use(sourcePath);
	const outputPath = join(config.tempDir, "disc-originals", `${randomUUID()}.mkv`);
	try {
		await remuxDiscSource(sourcePath, outputPath, signal, report);
		return await use(outputPath);
	} finally {
		rmSync(outputPath, { force: true });
	}
}

/** Writes the SOURCE and BDMV tags into a remux, so it names the disc range it holds. */
async function tagRemux(path: string, plan: DiscExtract, dir: string, signal?: AbortSignal): Promise<void> {
	const xmlPath = join(dir, `${basename(path)}.tags.xml`);
	try {
		writeFileSync(
			xmlPath,
			[
				'<?xml version="1.0" encoding="UTF-8"?>',
				"<Tags><Tag>",
				"<Targets><TargetTypeValue>50</TargetTypeValue></Targets>",
				"<Simple><Name>SOURCE</Name><String>BDMV</String></Simple>",
				...discOriginTagLines(discOriginOf(plan)),
				"</Tag></Tags>",
			].join("\n"),
		);
		const res = await run(["mkvpropedit", path, "--tags", `global:${xmlPath}`], { signal });
		if (signal?.aborted) throw new CancelledError();
		if (res.code !== 0 && res.code !== 1) throw new Error(`mkvpropedit could not tag the remux (exit ${res.code}): ${(res.stderr || res.stdout).slice(-500)}`);
	} finally {
		rmSync(xmlPath, { force: true });
	}
}

/**
 * Remuxes one episode or extra of a disc into an MKV in the temp folder.
 * Returns its path for the encode that follows, or null for a remux only
 * job, whose remux goes straight into the output.
 */
export async function runDiscJob(job: Job, config: AppConfig, updateJob: (partial: Partial<Job>) => void, signal?: AbortSignal): Promise<string | null> {
	const plan = job.discPlan;
	if (!plan) throw new Error("Disc job has no plan");
	const steps: JobStep[] = [
		{ label: "Read disc", status: "pending", progress: 0 },
		{ label: "Remux from disc", status: "pending", progress: 0 },
		...(plan.remuxOnly ? [{ label: "Write output", status: "pending" as const, progress: 0 }] : []),
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
		const needed = checkSpace(plan, dir);
		setStep(0, { status: "done", progress: 100, detail: needed ? `About ${humanSize(needed)}` : undefined });

		checkCancelled();
		setStep(1, { status: "active", progress: 0, detail: "Copying streams" });
		updateJob({ status: "muxing" });
		await remuxDiscRange(plan, outputPath, signal, (percent, detail) =>
			setStep(1, { ...(percent === null ? {} : { progress: percent }), ...(detail ? { detail } : {}) }),
		);
		checkCancelled();
		const size = humanSize(statSync(outputPath).size);
		setStep(1, { status: "done", progress: 100, detail: `${size} in ${basename(dir)}` });

		if (!plan.remuxOnly) {
			updateJob({ status: "done", currentStage: "Queued for encode", progress: 100, finishedAt: Date.now(), outputFilename: plan.filename });
			return outputPath;
		}

		setStep(2, { status: "active", progress: 0, detail: "Tagging the remux" });
		updateJob({ status: "writing_output" });
		await tagRemux(outputPath, plan, dir, signal);
		const root = jobOutputRoot({ outputRoot: plan.outputRoot }, config);
		const outputDir = join(root, plan.relativePath);
		mkdirSync(outputDir, { recursive: true });
		const finalPath = resolveUniqueOutputPath(outputDir, plan.filename);
		await moveFileWithProgress(outputPath, finalPath, signal, (copied, total, finished, rate) =>
			setStep(2, {
				progress: finished ? 100 : total > 0 ? Math.min(99, Math.round((copied / total) * 100)) : 0,
				detail: formatTransferDetail("Writing output", copied, total, rate),
			}),
		);
		setStep(2, { status: "done", progress: 100, detail: `${size} in ${relative(root, outputDir) || basename(root)}` });
		updateJob({ status: "done", currentStage: "Done", progress: 100, finishedAt: Date.now(), outputFilename: basename(finalPath) });
		Logger.info(`[disc] Remuxed ${basename(finalPath)} into ${outputDir}`);
		return null;
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
 * The mkvmerge pass that fixes the timing of a remux. Cut from the middle of
 * a playlist, every track starts some hundreds of milliseconds late, which the
 * encode would drop from the video only, so every track moves back by
 * `leadMs`. A rate puts every frame on its grid, which also starts the video
 * at 0.
 */
export function buildTimingFixArgs(inputPath: string, outputPath: string, tracks: { id: number; type: string }[], leadMs: number, rate?: string): string[] {
	const args = ["mkvmerge", "-o", outputPath];
	for (const track of tracks) {
		if (rate && track.type === "video") args.push("--default-duration", `${track.id}:${rate}`);
		else if (leadMs > 0) args.push("--sync", `${track.id}:${-leadMs}`);
	}
	args.push(inputPath);
	return args;
}

/**
 * mkvmerge keeps the jumps of a few milliseconds where clips join when it
 * reads a playlist, which the encode would take for variable frame rate. A
 * range cut after the first clip also starts late on every track. Read from
 * the remux, the video is put on the rate's grid and every track starts at 0.
 */
async function fixRemuxTiming(path: string, rate: string | undefined, dir: string, report: (detail: string) => void, signal?: AbortSignal): Promise<void> {
	const tracks = (await identifyMatroska(path, signal)).tracks ?? [];
	const video = tracks.find((t) => t.type === "video");
	if (!video) return;
	const timecodes = join(dir, `${basename(path)}.timestamps.txt`);
	const retimed = join(dir, `${basename(path)}.cfr.mkv`);
	try {
		report("Checking frame timing");
		const extracted = await run(["mkvextract", path, "timestamps_v2", `${video.id}:${timecodes}`], { signal });
		if (signal?.aborted) throw new CancelledError();
		if (extracted.code !== 0) return;
		const stamps = readTimecodes(timecodes);
		// Rounded down, so the first frame is not shifted below 0 and dropped.
		const first = stamps.reduce((min, t) => (t < min ? t : min), Infinity);
		const leadMs = Number.isFinite(first) ? Math.max(0, Math.floor(first)) : 0;
		const cfr = rate && onlyJoinJitter(stamps, frameMsOf(rate)) ? rate : undefined;
		if (!cfr && !leadMs) return;
		const stats = statfsSync(dir);
		if (stats.bavail * stats.bsize < statSync(path).size + 1024 ** 3) {
			if (leadMs) throw new Error(`The temp folder lacks the room to start ${basename(path)} at 0, and the audio would be ${leadMs} ms late`);
			Logger.warn(`[disc] Not enough temp space to make ${basename(path)} constant frame rate, keeping the disc's timing`);
			return;
		}
		report(cfr ? "Making the frame rate constant" : "Starting the tracks at 0");
		const merged = await run(buildTimingFixArgs(path, retimed, tracks, leadMs, cfr), { signal });
		if (signal?.aborted) throw new CancelledError();
		if (merged.code !== 0 && merged.code !== 1)
			throw new Error(`mkvmerge could not retime the remux (exit ${merged.code}): ${(merged.stderr || merged.stdout).slice(-500)}`);
		renameSync(retimed, path);
		if (cfr) Logger.info(`[disc] Retimed ${basename(path)} to a constant ${cfr.replace(/p$/, "")} fps`);
		if (leadMs) Logger.info(`[disc] Moved every track of ${basename(path)} back ${leadMs} ms, so the range starts at 0`);
	} finally {
		rmSync(timecodes, { force: true });
		rmSync(retimed, { force: true });
	}
}
