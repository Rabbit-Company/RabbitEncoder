import { randomUUID } from "crypto";
import { existsSync, mkdirSync, rmSync, statSync } from "fs";
import { basename, dirname, extname, join } from "path";
import { CancelledError, humanSize } from "../core/process";
import { Logger } from "../core/logger";
import {
	FILM_GRAIN_RANGES,
	FILM_GRAIN_SAMPLINGS,
	FILM_GRAIN_SIZES,
	type AppConfig,
	type FilmGrainRange,
	type FilmGrainSampling,
	type FilmGrainSize,
	type GrainAction,
	type GrainInspection,
	type GrainInspectProgress,
	type GrainPlan,
	type HdrFinding,
	type Job,
	type JobStep,
} from "../core/types";
import { formatFilmGrainProgress, type FilmGrainProgress, type RegrainEntryProgress } from "../video/film-grain-progress";
import { generateSyntheticFilmGrainTable, measureFilmGrain, regrainErrorText, runRegrain, streamRegrain } from "../video/film-grain-generator";
import { detectFilmGrainGeometry } from "../video/film-grain-crop";
import { writeEncoderFilmGrainTable } from "../video/film-grain-table";
import { grainIso, isoResolution, MAX_GRAIN_ISO, MIN_GRAIN_ISO } from "../core/film-grain-iso";
import { extractAv1Track, identify, replaceVideoTrack, videoTrackOf as av1TrackOf, type MkvJson } from "./av1-mkv";
import { probeFile } from "./probe";

const ACTIONS: GrainAction[] = ["remove", "synthetic", "table", "measure"];
/** The largest synthetic grain the encode settings allow, on the 0 to 255 scale. */
export const MAX_SYNTHETIC_GRAIN = 64;

const videoTrackOf = (identified: MkvJson) => av1TrackOf(identified, "film grain");

/** All events of a regrain run with `--progress json`, except progress, which goes to `onProgress`. */
async function regrainEvents(
	args: string[],
	signal?: AbortSignal,
	onProgress?: (event: RegrainEntryProgress) => void,
	onFrames?: (frames: number) => void,
): Promise<{ code: number; events: Record<string, any>[]; stderr: string }> {
	const events: Record<string, any>[] = [];
	const result = await streamRegrain(["regrain", "--progress", "json", ...args], signal, (event) => {
		if (event.event === "progress") {
			if (event.frames === undefined) onProgress?.(event);
			else onFrames?.(event.frames);
		} else events.push(event);
	});
	if (signal?.aborted) throw new CancelledError();
	return { code: result.code, events, stderr: result.stderr };
}

function eventError(events: Record<string, any>[], stderr: string, code: number): string {
	const error = events.find((event) => event.event === "error");
	return regrainErrorText(error as any, stderr, code);
}

/** The film grain table of a video, written to `tablePath`. Returns the video's frame count and the table's entry count. */
export async function exportFilmGrainTable(
	videoPath: string,
	tablePath: string,
	signal?: AbortSignal,
	onFrames?: (frames: number) => void,
): Promise<{ frames: number; entries: number }> {
	const result = await regrainEvents(["export", videoPath, "-o", tablePath, "-y"], signal, undefined, onFrames);
	const summary = result.events.find((event) => event.event === "summary");
	if (result.code !== 0 || !summary || !existsSync(tablePath))
		throw new Error(`regrain could not read the film grain of ${basename(videoPath)}: ${eventError(result.events, result.stderr, result.code)}`);
	return { frames: Number(summary.frames ?? 0), entries: Number(summary.entries ?? 0) };
}

export interface FilmGrainTableCheck {
	/** At most 50 problems. */
	findings: HdrFinding[];
	errors: number;
	/** Problems `--fix` corrects. */
	fixable: number;
	/** Warnings left in the table after `--fix`, or all warnings without it. */
	warnings: number;
	/** `fixPath` was written, because every error can be corrected. */
	fixed: boolean;
}

/** Problems `regrain check` finds in a table. With `fixPath`, a corrected table is written there when every error can be corrected. */
export async function checkFilmGrainTable(
	tablePath: string,
	signal?: AbortSignal,
	fixPath?: string,
	onProgress?: (event: RegrainEntryProgress) => void,
): Promise<FilmGrainTableCheck> {
	const result = await regrainEvents(["check", tablePath, ...(fixPath ? ["--fix", fixPath, "-y"] : [])], signal, onProgress);
	const summary = result.events.find((event) => event.event === "summary");
	// A table with errors ends in an invalid_table error instead of a summary.
	const invalid = result.events.some((event) => event.event === "error" && event.code === "invalid_table");
	if (!summary && !invalid) throw new Error(`regrain could not check the table: ${eventError(result.events, result.stderr, result.code)}`);
	const all = result.events.filter((event) => event.event === "finding");
	const findings: HdrFinding[] = all.slice(0, 50).map((event) => ({
		severity: event.severity === "error" ? "error" : "warning",
		code: String(event.code),
		message: `${typeof event.start_seconds === "number" ? `At ${formatSeconds(event.start_seconds)}: ` : ""}${String(event.message)}`,
	}));
	const fixed = !!fixPath && typeof summary?.output === "string" && existsSync(fixPath);
	return {
		findings,
		errors: all.filter((event) => event.severity === "error").length,
		fixable: all.filter((event) => event.fixable === true).length,
		warnings: all.filter((event) => event.severity !== "error" && !(fixed && event.fixable === true)).length,
		fixed,
	};
}

function formatSeconds(seconds: number): string {
	const whole = Math.floor(seconds);
	const h = Math.floor(whole / 3600);
	const m = Math.floor((whole % 3600) / 60);
	const s = whole % 60;
	return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/** Average and strongest grain of a table, from `regrain stats`. */
async function grainStrength(
	tablePath: string,
	signal?: AbortSignal,
	onProgress?: (event: RegrainEntryProgress) => void,
): Promise<{ luma: number; lumaMax: number; chroma: number } | null> {
	const result = await regrainEvents(["stats", tablePath], signal, onProgress);
	const summary = result.events.find((event) => event.event === "summary");
	if (result.code !== 0 || !summary) throw new Error(`regrain could not read the table: ${eventError(result.events, result.stderr, result.code)}`);
	const list: Record<string, any>[] = Array.isArray(summary.list) ? summary.list : [];
	if (list.length === 0) return null;
	const round = (value: number) => Math.round(value * 100) / 100;
	const mean = (key: string) => list.reduce((sum, entry) => sum + Number(entry[key] ?? 0), 0) / list.length;
	return {
		luma: round(Number(summary.luma ?? mean("luma"))),
		// A table can have an entry for every frame of a film, too many to spread into Math.max.
		lumaMax: round(list.reduce((max, entry) => Math.max(max, Number(entry.luma ?? 0)), 0)),
		chroma: round((mean("cb") + mean("cr")) / 2),
	};
}

/** What a video's film grain is. Only AV1 in MKV can be changed, other videos are described from their probe. */
export async function inspectGrainFile(
	path: string,
	tempDir: string,
	signal?: AbortSignal,
	onProgress?: (progress: GrainInspectProgress) => void,
): Promise<GrainInspection> {
	onProgress?.({ stage: "video", percent: null, detail: "Reading the video" });
	const isMkv = extname(path).toLowerCase() === ".mkv";
	const identified = isMkv ? await identify(path, signal) : null;
	const video = identified ? videoTrackOf(identified) : { reason: "Film grain can only be changed in MKV files" };
	const probe = await probeFile(path);
	const base = {
		path,
		width: probe.width,
		height: probe.height,
		frameRate: probe.videoDisplayFps || probe.videoStreamFps || null,
	};
	if (!video.track) {
		return {
			...base,
			codec: probe.videoCodec,
			editable: false,
			reason: video.reason,
			frames: null,
			entries: 0,
			luma: null,
			lumaMax: null,
			chroma: null,
			findings: [],
		};
	}
	const reason = probe.hasDolbyVision
		? "The video has Dolby Vision, whose configuration a rebuilt video track loses. Remove it with HDR Metadata first"
		: undefined;
	const dir = join(tempDir, "grain-inspect");
	mkdirSync(dir, { recursive: true });
	const table = join(dir, `${randomUUID()}.tbl`);
	try {
		onProgress?.({ stage: "table", percent: null, detail: "" });
		// regrain reports the frames it has read, but cannot tell how many there are.
		const exported = await exportFilmGrainTable(path, table, signal, (frames) =>
			onProgress?.({ stage: "table", percent: null, detail: `${frames.toLocaleString()} frames read` }),
		);
		let strength: Awaited<ReturnType<typeof grainStrength>> = null;
		let check: FilmGrainTableCheck | null = null;
		if (exported.entries > 0) {
			// stats and check each work through every entry, so together they are done when both are.
			const done = { stats: 0, check: 0 };
			const report = (key: keyof typeof done) => (event: RegrainEntryProgress) => {
				done[key] = event.entries;
				const total = exported.entries * 2;
				onProgress?.({
					stage: "measure",
					percent: Math.min(100, Math.round(((done.stats + done.check) / total) * 1000) / 10),
					detail: `${Math.round((done.stats + done.check) / 2).toLocaleString()} of ${exported.entries.toLocaleString()} grain entries`,
				});
			};
			onProgress?.({ stage: "measure", percent: 0, detail: `0 of ${exported.entries.toLocaleString()} grain entries` });
			[strength, check] = await Promise.all([grainStrength(table, signal, report("stats")), checkFilmGrainTable(table, signal, undefined, report("check"))]);
		}
		return {
			...base,
			codec: "AV1",
			editable: !reason,
			...(reason ? { reason } : {}),
			frames: exported.frames,
			entries: exported.entries,
			luma: strength?.luma ?? null,
			lumaMax: strength?.lumaMax ?? null,
			chroma: strength?.chroma ?? null,
			findings: check?.findings ?? [],
		};
	} finally {
		rmSync(table, { force: true });
	}
}

function numberIn(value: unknown, min: number, max: number): number | undefined {
	const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
	return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
}

/** Normalizes untrusted input and refuses plans that cannot be carried out. Paths are checked by the caller. */
export function sanitizeGrainPlan(raw: Partial<GrainPlan>): GrainPlan {
	if (!ACTIONS.includes(raw.action as GrainAction)) throw new Error("Choose what to do with the film grain");
	const plan: GrainPlan = {
		targetPath: typeof raw.targetPath === "string" ? raw.targetPath : "",
		action: raw.action as GrainAction,
		...(raw.batch === true ? { batch: true, skipExisting: raw.skipExisting === true } : {}),
	};
	if (plan.action === "synthetic") {
		if (raw.iso !== undefined) {
			const iso = grainIso(Number(raw.iso));
			if (!iso) throw new Error(`Enter an ISO from ${MIN_GRAIN_ISO} to ${MAX_GRAIN_ISO}, or remove the grain instead`);
			plan.iso = iso;
		} else {
			const strength = numberIn(raw.strength, 0, MAX_SYNTHETIC_GRAIN);
			if (!strength) throw new Error(`Enter a grain strength above 0 and at most ${MAX_SYNTHETIC_GRAIN}, or remove the grain instead`);
			plan.strength = Math.round(strength * 10) / 10;
		}
		plan.size = FILM_GRAIN_SIZES.includes(raw.size as FilmGrainSize) ? (raw.size as FilmGrainSize) : "medium";
		plan.chroma = Math.round((numberIn(raw.chroma, 0, MAX_SYNTHETIC_GRAIN) ?? 0) * 10) / 10;
	}
	if (plan.action === "table") {
		if (typeof raw.tablePath !== "string" || !raw.tablePath) throw new Error("Upload a film grain table first");
		plan.tablePath = raw.tablePath;
	}
	if (plan.action === "measure") {
		if (plan.batch) throw new Error("A folder cannot measure grain, every file needs its own original");
		if (typeof raw.sourcePath !== "string" || !raw.sourcePath) throw new Error("Choose the original the video was encoded from");
		plan.sourcePath = raw.sourcePath;
		plan.sampling = FILM_GRAIN_SAMPLINGS.includes(raw.sampling as FilmGrainSampling) ? (raw.sampling as FilmGrainSampling) : "all";
		plan.range = FILM_GRAIN_RANGES.includes(raw.range as FilmGrainRange) ? (raw.range as FilmGrainRange) : "representative";
		if (raw.justEnough === true) plan.justEnough = true;
		if (raw.measureChroma === true) plan.measureChroma = true;
	}
	if (plan.action !== "remove" && raw.staticGrain === true) plan.staticGrain = true;
	return plan;
}

/** "Synthetic grain 4, medium" for the job card. */
export function describeGrainPlan(plan: GrainPlan): string {
	if (plan.action === "remove") return "Remove film grain";
	const parts =
		plan.action === "synthetic"
			? [plan.iso ? `ISO ${plan.iso} grain` : `Synthetic grain ${plan.strength}`, plan.size ?? "medium", ...(plan.chroma ? [`chroma ${plan.chroma}`] : [])]
			: plan.action === "measure"
				? [
						"Grain measured from the original",
						...(plan.justEnough ? ["just enough"] : []),
						...(plan.measureChroma ? ["with chroma"] : []),
						plan.range === "full" ? "full video" : "quick",
					]
				: ["Apply film grain table"];
	if (plan.staticGrain) parts.push("static");
	return parts.join(", ");
}

/** The regrain run that writes the plan from `input` to `output`, with a generated or uploaded `table`. */
export function grainWriteArgs(plan: GrainPlan, input: string, output: string, table: string | null): string[] {
	if (plan.action === "remove") return ["regrain", "remove", input, "-o", output, "-y", "--verify", "--progress", "json"];
	if (!table) throw new Error("No film grain table to apply");
	const args = ["regrain", "apply", input, "-o", output, "-t", table, "-y", "--verify", "--progress", "json"];
	if (plan.staticGrain) args.push("--static-grain");
	return args;
}

export async function runGrainJob(job: Job, config: AppConfig, updateJob: (partial: Partial<Job>) => void, signal?: AbortSignal): Promise<void> {
	if (!job.grainPlan) throw new Error("Film grain job has no plan");
	const plan = job.grainPlan;
	const tempDir = join(config.tempDir, job.id);
	mkdirSync(tempDir, { recursive: true });
	const stagePath = join(dirname(plan.targetPath), `.rabbit-grain-${job.id}.mkv`);
	const labels = plan.action === "measure" ? ["Analyze", "Measure", "Write", "Replace"] : ["Analyze", "Write", "Replace"];
	const steps: JobStep[] = labels.map((label) => ({ label, status: "pending", progress: 0 }));

	const setStep = (label: string, partial: Partial<JobStep>) => {
		const step = steps.find((item) => item.label === label)!;
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
	// A batch leaves files the plan does not fit as they are.
	const skip = (reason: string) => {
		for (const step of steps) if (step.status !== "done") Object.assign(step, { status: "done", progress: 100 });
		steps[0]!.detail = `Skipped: ${reason}`;
		updateJob({
			status: "done",
			steps: [...steps],
			progress: 100,
			currentStage: `Skipped: ${reason}`,
			outputFilename: plan.targetPath,
			finishedAt: Date.now(),
		});
		Logger.info(`[grain] Skipped ${basename(plan.targetPath)}: ${reason}`);
	};

	try {
		if (!existsSync(plan.targetPath)) throw new Error("The video no longer exists");
		if (extname(plan.targetPath).toLowerCase() !== ".mkv") throw new Error("Film grain can only be changed in MKV files");
		if (existsSync(stagePath)) throw new Error(`Staging file already exists: ${stagePath}`);
		if (plan.tablePath && !existsSync(plan.tablePath)) throw new Error("The uploaded film grain table no longer exists, upload it again");
		if (plan.sourcePath && !existsSync(plan.sourcePath)) throw new Error("The original no longer exists");

		// Analyze
		setStep("Analyze", { status: "active", progress: 10 });
		updateJob({ status: "probing" });
		const original = await identify(plan.targetPath, signal);
		const video = videoTrackOf(original);
		if (!video.track) throw new Error(video.reason);
		const probe = await probeFile(plan.targetPath);
		checkCancelled();
		updateJob({ probe });
		if (probe.hasDolbyVision) {
			if (plan.batch) return skip("has Dolby Vision");
			throw new Error("The video has Dolby Vision metadata, whose configuration a rebuilt video track loses. Remove it with HDR Metadata first");
		}
		setStep("Analyze", { progress: 30, detail: "Reading the film grain" });
		const before = await exportFilmGrainTable(plan.targetPath, join(tempDir, "before.tbl"), signal, (frames) =>
			setStep("Analyze", { detail: `Reading the film grain: ${frames.toLocaleString()} frames` }),
		);
		if (plan.action === "remove" && before.entries === 0) {
			if (plan.batch) return skip("has no film grain");
			throw new Error("The video has no film grain to remove");
		}
		if (plan.action !== "remove" && plan.batch && plan.skipExisting && before.entries > 0) return skip("already has film grain");
		setStep("Analyze", { progress: 60, detail: "Extracting the video" });
		const { ivf, timestamps } = await extractAv1Track(plan.targetPath, video.track, tempDir, signal);
		setStep("Analyze", {
			status: "done",
			progress: 100,
			detail: `${before.frames.toLocaleString()} frames, ${before.entries ? `${before.entries.toLocaleString()} grain ${before.entries === 1 ? "entry" : "entries"}` : "no film grain"}`,
		});

		// Measure
		let table = plan.tablePath ?? null;
		if (plan.action === "measure") {
			setStep("Measure", { status: "active", progress: 0, detail: "Finding the video in the original" });
			const original = await probeFile(plan.sourcePath!);
			checkCancelled();
			// Measured against the original as it was cut and scaled for the encode.
			const geometry = await detectFilmGrainGeometry(
				plan.sourcePath!,
				plan.targetPath,
				original,
				probe,
				Math.min(original.duration, probe.duration),
				tempDir,
				signal,
			);
			// The decoder in regrain diff adds the encode's own grain, which must not count as grain the encode lost.
			let reference = ivf;
			if (before.entries > 0) {
				setStep("Measure", { detail: "Taking out the video's grain for the measurement" });
				reference = join(tempDir, "without-grain.ivf");
				const removed = await runRegrain(["regrain", "remove", ivf, "-o", reference, "-y", "--progress", "json"], signal);
				checkCancelled();
				if (removed.code !== 0) throw new Error(`regrain failed: ${regrainErrorText(removed.error, removed.stderr, removed.code)}`);
			}
			setStep("Measure", { detail: "Measuring the grain" });
			const measured = join(tempDir, "measured.tbl");
			const segments = await measureFilmGrain({
				sourcePath: plan.sourcePath!,
				denoisedPath: reference,
				denoisedProbe: probe,
				tablePath: measured,
				sampling: plan.sampling ?? "all",
				range: plan.range ?? "representative",
				justEnough: plan.justEnough === true,
				lumaOnly: plan.measureChroma !== true,
				crop: geometry.crop,
				scale: geometry.scale,
				signal,
				onProgress: (progress) => setStep("Measure", { progress: progress.percent ?? 0, detail: formatFilmGrainProgress(progress) }),
			});
			checkCancelled();
			if (reference !== ivf) rmSync(reference, { force: true });
			table = join(tempDir, "measured-encode.tbl");
			if (segments === 0 || writeEncoderFilmGrainTable(measured, table) === 0)
				throw new Error("The video lost no measurable grain compared with the original, so there is no grain to add");
			const shape = [
				geometry.crop ? `cropped to ${geometry.crop.w}x${geometry.crop.h}` : "",
				geometry.scale ? `scaled to ${geometry.scale.w}x${geometry.scale.h}` : "",
			];
			setStep("Measure", {
				status: "done",
				progress: 100,
				detail: [`${segments} ${segments === 1 ? "scene" : "scenes"}`, ...shape.filter(Boolean)].join(", "),
			});
		}

		// Write
		setStep("Write", { status: "active", progress: 0, detail: describeGrainPlan(plan) });
		updateJob({ status: "muxing" });
		if (plan.action === "synthetic") {
			table = join(tempDir, "synthetic.tbl");
			const shape = { size: plan.size ?? "medium", chroma: plan.chroma ?? 0 };
			const segments = await generateSyntheticFilmGrainTable(
				table,
				plan.iso ? { ...shape, iso: plan.iso, resolution: isoResolution(probe.width, probe.height) } : { ...shape, strength: plan.strength! },
				signal,
			);
			if (segments === 0) throw new Error("This strength adds no grain, choose a higher one");
		}
		const written = join(tempDir, "grain.ivf");
		const result = await runRegrain(grainWriteArgs(plan, ivf, written, table), signal, (progress: FilmGrainProgress) =>
			setStep("Write", { progress: progress.percent ?? 0, detail: formatFilmGrainProgress(progress) }),
		);
		checkCancelled();
		if (result.error?.code === "cancelled") throw new CancelledError();
		if (result.code !== 0 || !existsSync(written)) throw new Error(`regrain failed: ${regrainErrorText(result.error, result.stderr, result.code)}`);
		const after = await exportFilmGrainTable(written, join(tempDir, "after.tbl"), signal);
		if (after.frames !== before.frames) throw new Error(`The new video has ${after.frames} frames instead of ${before.frames}`);
		if (plan.action === "remove" ? after.entries > 0 : after.entries === 0) throw new Error("The new video does not carry the expected film grain");
		setStep("Write", { status: "done", progress: 100, detail: `${describeGrainPlan(plan)}, verified with dav1d` });

		// Replace
		setStep("Replace", { status: "active", progress: 0 });
		await replaceVideoTrack({
			targetPath: plan.targetPath,
			stagePath,
			original,
			track: video.track,
			video: written,
			timestamps,
			probe,
			tempDir,
			signal,
			onProgress: (progress, detail) => setStep("Replace", { progress, detail }),
		});
		// A folder shares one uploaded table between its jobs.
		if (plan.tablePath && !plan.batch) rmSync(plan.tablePath, { force: true });
		setStep("Replace", { status: "done", progress: 100, detail: "Replaced after verification" });
		updateJob({
			status: "done",
			currentStage: "Complete",
			progress: 100,
			outputFilename: plan.targetPath,
			encodedFileSize: humanSize(statSync(plan.targetPath).size),
			finishedAt: Date.now(),
		});
		Logger.info(`[grain] ${describeGrainPlan(plan)}: ${plan.targetPath}`);
	} catch (error: any) {
		const active = steps.find((step) => step.status === "active");
		if (active) active.status = "error";
		if (error instanceof CancelledError) {
			updateJob({ status: "cancelled", currentStage: "Cancelled", steps: [...steps] });
			throw error;
		}
		Logger.error(`[grain] ${error?.message || error}`);
		updateJob({ status: "error", currentStage: "Failed", steps: [...steps], error: error?.message || String(error) });
	} finally {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {}
		try {
			rmSync(stagePath, { force: true });
		} catch {}
	}
}
