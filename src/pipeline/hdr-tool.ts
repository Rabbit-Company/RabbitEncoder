import { existsSync, mkdirSync, rmSync, statSync } from "fs";
import { basename, dirname, extname, join } from "path";
import { CancelledError, humanSize, run } from "../core/process";
import { Logger } from "../core/logger";
import type { AppConfig, HdrFinding, HdrInspection, HdrPlan, HdrPlusAction, HdrStaticAction, Job, JobStep, ProbeResult } from "../core/types";
import { formatFilmGrainProgress, type FilmGrainProgress } from "../video/film-grain-progress";
import { retoneErrorText, runRetone, type RetoneRun } from "../video/hdr10plus";
import { probeFile } from "./probe";
import { extractAv1Track, identify, replaceVideoTrack, videoTrackOf as av1TrackOf, type MkvJson } from "./av1-mkv";

const HDR_PLUS_ACTIONS: HdrPlusAction[] = ["keep", "remove", "measure", "dolby-vision", "file"];
const STATIC_ACTIONS: HdrStaticAction[] = ["keep", "remove", "set"];

/** The values of the chromaticities retone reports, to name the primaries of a mastering display. */
const MASTERING_PRIMARIES: { name: string; red: [number, number] }[] = [
	{ name: "Display P3", red: [0.68, 0.32] },
	{ name: "BT.2020", red: [0.708, 0.292] },
];

const TRANSFER_NAMES: Record<number, string> = { 1: "BT.709", 2: "Unspecified", 6: "BT.601", 13: "sRGB", 14: "BT.2020", 15: "BT.2020", 16: "PQ", 18: "HLG" };
const PRIMARIES_NAMES: Record<number, string> = { 1: "BT.709", 2: "Unspecified", 9: "BT.2020", 11: "DCI-P3", 12: "Display P3" };
const MATRIX_NAMES: Record<number, string> = { 0: "Identity", 1: "BT.709", 2: "Unspecified", 9: "BT.2020 NCL", 10: "BT.2020 CL", 14: "ICtCp" };

/** All events of a retone run with `--progress json`. */
async function retoneEvents(args: string[], signal?: AbortSignal): Promise<{ code: number; events: Record<string, any>[]; stderr: string }> {
	const result = await run(["retone", "--progress", "json", ...args], { signal });
	if (signal?.aborted) throw new CancelledError();
	const events = result.stdout
		.split("\n")
		.filter((line) => line.trim().startsWith("{"))
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as Record<string, any>];
			} catch {
				return [];
			}
		});
	return { code: result.code, events, stderr: result.stderr };
}

function eventError(events: Record<string, any>[], stderr: string, code: number): string {
	const error = events.find((event) => event.event === "error");
	if (error?.message) return String(error.message).charAt(0).toUpperCase() + String(error.message).slice(1);
	return stderr.trim().split("\n").slice(-3).join("\n") || `retone exited with code ${code}`;
}

function nameOf(names: Record<number, string>, value: number | null): string {
	return value === null ? "Unknown" : (names[value] ?? `Code ${value}`);
}

function masteringName(red: unknown): string {
	if (!Array.isArray(red)) return "Custom";
	const match = MASTERING_PRIMARIES.find((entry) => Math.abs(entry.red[0] - Number(red[0])) < 0.002 && Math.abs(entry.red[1] - Number(red[1])) < 0.002);
	return match?.name ?? "Custom";
}

const videoTrackOf = (identified: MkvJson) => av1TrackOf(identified, "HDR metadata");

/** What a video holds. Only AV1 in MKV can be read with retone, other videos are described from their probe. */
export async function inspectHdrFile(path: string, signal?: AbortSignal): Promise<HdrInspection> {
	const isMkv = extname(path).toLowerCase() === ".mkv";
	const identified = isMkv ? await identify(path, signal) : null;
	const video = identified ? videoTrackOf(identified) : { reason: "HDR metadata can only be changed in MKV files" };
	if (!video.track) {
		const probe = await probeFile(path);
		const formats = [probe.isHDR ? "HDR10" : probe.transferCharacteristics === "HLG" ? "HLG" : "SDR"];
		if (probe.hasHDR10Plus) formats.push("HDR10+");
		if (probe.hasDolbyVision) formats.push("Dolby Vision");
		return {
			path,
			codec: probe.videoCodec,
			editable: false,
			reason: video.reason,
			formats,
			width: probe.width,
			height: probe.height,
			frames: null,
			frameRate: probe.videoDisplayFps || probe.videoStreamFps || null,
			colorPrimaries: null,
			transferCharacteristics: null,
			matrixCoefficients: null,
			colorDescription: [probe.colorPrimaries, probe.transferCharacteristics, probe.matrixCoefficients].filter(Boolean).join(" / ") || "Unknown",
			isPq: probe.isHDR,
			untagged: false,
			masteringDisplay: null,
			contentLight: /^\d+$/.test(probe.maxCLL) && /^\d+$/.test(probe.maxFALL) ? { maxCll: Number(probe.maxCLL), maxFall: Number(probe.maxFALL) } : null,
			hdr10PlusFrames: 0,
			hdr10PlusScenes: null,
			hdr10PlusMaxCll: null,
			hdr10PlusMaxFall: null,
			dolbyVision: probe.hasDolbyVision,
			findings: [],
		};
	}

	const [info, check] = await Promise.all([retoneEvents(["info", path], signal), retoneEvents(["check", path], signal)]);
	const summary = info.events.find((event) => event.event === "summary");
	if (info.code !== 0 || !summary) throw new Error(`retone could not read ${basename(path)}: ${eventError(info.events, info.stderr, info.code)}`);
	const hdr10PlusFrames = Number(summary.hdr10plus_frames ?? 0);
	const stats = hdr10PlusFrames > 0 ? await retoneEvents(["stats", path], signal) : null;
	const statsSummary = stats?.events.find((event) => event.event === "summary");
	const transfer = typeof summary.transfer_characteristics === "number" ? summary.transfer_characteristics : null;
	const primaries = typeof summary.color_primaries === "number" ? summary.color_primaries : null;
	const matrix = typeof summary.matrix_coefficients === "number" ? summary.matrix_coefficients : null;
	const findings: HdrFinding[] = check.events
		.filter((event) => event.event === "finding")
		.slice(0, 50)
		.map((event) => ({ severity: event.severity === "error" ? "error" : "warning", code: String(event.code), message: String(event.message) }));
	const mastering = summary.mastering_display;
	const light = summary.content_light;
	return {
		path,
		codec: "AV1",
		editable: true,
		formats: Array.isArray(summary.formats) ? summary.formats.map(String) : [],
		width: Number(summary.width ?? 0),
		height: Number(summary.height ?? 0),
		frames: typeof summary.frames === "number" ? summary.frames : null,
		frameRate: typeof summary.frame_rate === "number" ? summary.frame_rate : null,
		colorPrimaries: primaries,
		transferCharacteristics: transfer,
		matrixCoefficients: matrix,
		colorDescription: `${nameOf(PRIMARIES_NAMES, primaries)} / ${nameOf(TRANSFER_NAMES, transfer)} / ${nameOf(MATRIX_NAMES, matrix)}`,
		isPq: transfer === 16,
		untagged: transfer === 2,
		masteringDisplay: mastering ? { primaries: masteringName(mastering.red), maxNits: Number(mastering.max_nits), minNits: Number(mastering.min_nits) } : null,
		contentLight: light ? { maxCll: Number(light.max_cll), maxFall: Number(light.max_fall) } : null,
		hdr10PlusFrames,
		hdr10PlusScenes: typeof statsSummary?.scenes === "number" ? statsSummary.scenes : null,
		hdr10PlusMaxCll: typeof statsSummary?.max_cll === "number" ? statsSummary.max_cll : null,
		hdr10PlusMaxFall: typeof statsSummary?.max_fall === "number" ? statsSummary.max_fall : null,
		dolbyVision: Number(summary.dolby_vision_obus ?? 0) > 0,
		findings,
	};
}

function numberIn(value: unknown, min: number, max: number): number | undefined {
	const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
}

/** Normalizes untrusted input and refuses plans that change nothing or cannot be carried out. Paths are checked by the caller. */
export function sanitizeHdrPlan(raw: Partial<HdrPlan>): HdrPlan {
	const hdr10Plus = HDR_PLUS_ACTIONS.includes(raw.hdr10Plus as HdrPlusAction) ? (raw.hdr10Plus as HdrPlusAction) : "keep";
	const staticMetadata = STATIC_ACTIONS.includes(raw.staticMetadata as HdrStaticAction) ? (raw.staticMetadata as HdrStaticAction) : "keep";
	const plan: HdrPlan = {
		targetPath: typeof raw.targetPath === "string" ? raw.targetPath : "",
		hdr10Plus,
		removeDolbyVision: raw.removeDolbyVision === true,
		staticMetadata,
		fixColor: raw.fixColor === true,
		...(raw.batch === true ? { batch: true, skipExisting: raw.skipExisting === true } : {}),
	};
	if (hdr10Plus === "dolby-vision" || hdr10Plus === "file") {
		if (typeof raw.sourcePath === "string" && raw.sourcePath) plan.sourcePath = raw.sourcePath;
		if (hdr10Plus === "file" && typeof raw.metadataPath === "string" && raw.metadataPath) plan.metadataPath = raw.metadataPath;
		if (hdr10Plus === "dolby-vision" && !plan.sourcePath) throw new Error("Choose the Dolby Vision original whose shots become the HDR10+ scenes");
		if (hdr10Plus === "file" && !plan.sourcePath && !plan.metadataPath) throw new Error("Choose an HDR10+ JSON file or an AV1 video with HDR10+ metadata");
		if (plan.batch) throw new Error("A folder can only keep, remove or measure HDR10+ metadata, each file needs its own original");
	}
	if (staticMetadata === "set") {
		plan.masteringPrimaries = raw.masteringPrimaries === "p3" ? "p3" : "bt2020";
		const maxNits = numberIn(raw.masteringMaxNits, 1, 10000);
		const minNits = numberIn(raw.masteringMinNits, 0, 50);
		if (maxNits === undefined || minNits === undefined || minNits >= maxNits)
			throw new Error("Enter the mastering display's maximum and minimum luminance in cd/m²");
		plan.masteringMaxNits = maxNits;
		plan.masteringMinNits = minNits;
		if (raw.lightFromHdr10Plus === true) {
			if (hdr10Plus === "remove") throw new Error("MaxCLL and MaxFALL cannot come from HDR10+ metadata that is removed");
			plan.lightFromHdr10Plus = true;
		} else if (raw.maxCll !== undefined || raw.maxFall !== undefined) {
			const maxCll = numberIn(raw.maxCll, 0, 65535);
			const maxFall = numberIn(raw.maxFall, 0, 65535);
			if (maxCll === undefined || maxFall === undefined) throw new Error("MaxCLL and MaxFALL must be whole numbers from 0 to 65535");
			plan.maxCll = Math.round(maxCll);
			plan.maxFall = Math.round(maxFall);
		}
	}
	if (hdr10Plus === "keep" && staticMetadata === "keep" && !plan.removeDolbyVision && !plan.fixColor) throw new Error("Choose at least one change");
	return plan;
}

/** "Measure HDR10+, set mastering display" for the job card. */
export function describeHdrPlan(plan: HdrPlan): string {
	const parts: string[] = [];
	if (plan.hdr10Plus === "measure") parts.push("Measure HDR10+");
	if (plan.hdr10Plus === "dolby-vision") parts.push("HDR10+ from Dolby Vision shots");
	if (plan.hdr10Plus === "file") parts.push("Import HDR10+");
	if (plan.hdr10Plus === "remove") parts.push("Remove HDR10+");
	if (plan.removeDolbyVision) parts.push("Remove Dolby Vision");
	if (plan.staticMetadata === "set") parts.push("Set HDR10 static metadata");
	if (plan.staticMetadata === "remove") parts.push("Remove HDR10 static metadata");
	if (plan.fixColor) parts.push("Tag as BT.2020 PQ");
	return parts.join(", ");
}

export function masteringArgument(plan: HdrPlan): string {
	return `${plan.masteringPrimaries === "p3" ? "p3" : "bt2020"},${plan.masteringMaxNits},${plan.masteringMinNits}`;
}

/** The retone runs that write the plan into the video, from `input` to `output`, through numbered files in `dir`. */
export function hdrWriteSteps(plan: HdrPlan, input: string, dir: string, metadata: string | null, keptHdr10Plus: boolean): { label: string; args: string[] }[] {
	const steps: { label: string; args: string[] }[] = [];
	let current = input;
	const next = () => join(dir, `write-${steps.length + 1}.ivf`);
	const add = (label: string, args: string[]) => {
		const output = next();
		steps.push({ label, args: [...args.slice(0, 2), current, "-o", output, "-y", "--progress", "json", ...args.slice(2)] });
		current = output;
	};
	const removeHdr10Plus = plan.hdr10Plus === "remove";
	const removeStatic = plan.staticMetadata === "remove";
	if (removeHdr10Plus || plan.removeDolbyVision || removeStatic) {
		const flags: string[] = [];
		if (!removeHdr10Plus) flags.push("--keep-hdr10plus");
		if (plan.removeDolbyVision) flags.push("--dolby-vision");
		if (removeStatic) flags.push("--static");
		add("Removing metadata", ["retone", "remove", ...flags]);
	}
	// Colour tags are fixed by whichever step writes first, so later steps see PQ.
	let colorFixed = !plan.fixColor;
	if (plan.staticMetadata === "set" || (plan.fixColor && !metadata)) {
		const flags: string[] = [];
		if (plan.staticMetadata === "set") {
			flags.push("--mastering-display", masteringArgument(plan));
			if (plan.lightFromHdr10Plus) {
				const source = metadata ?? (keptHdr10Plus ? current : null);
				if (!source) throw new Error("The file has no HDR10+ metadata to take MaxCLL and MaxFALL from");
				flags.push("--cll-from", source);
			} else if (plan.maxCll !== undefined && plan.maxFall !== undefined) {
				flags.push("--max-cll", String(plan.maxCll), "--max-fall", String(plan.maxFall));
			}
		}
		if (!colorFixed) flags.push("--fix-color");
		colorFixed = true;
		add(plan.staticMetadata === "set" ? "Writing HDR10 static metadata" : "Tagging as BT.2020 PQ", ["retone", "static", ...flags]);
	}
	if (metadata) {
		const flags = ["-m", metadata, "--verify"];
		if (!colorFixed) flags.push("--fix-color");
		add("Writing HDR10+ metadata", ["retone", "apply", ...flags]);
	}
	return steps;
}

function makeSteps(measures: boolean): JobStep[] {
	return [
		{ label: "Analyze", status: "pending", progress: 0 },
		...(measures ? [{ label: "HDR10+", status: "pending" as const, progress: 0 }] : []),
		{ label: "Write", status: "pending", progress: 0 },
		{ label: "Replace", status: "pending", progress: 0 },
	];
}

/** The mastering display and content light level the MKV colour elements get after the job. */
function containerProbe(probe: ProbeResult, plan: HdrPlan, light: { maxCll: number; maxFall: number } | null): ProbeResult {
	const adjusted: ProbeResult = { ...probe };
	if (plan.fixColor) {
		adjusted.transferCharacteristics = "PQ";
		adjusted.colorPrimaries = "BT.2020";
		adjusted.matrixCoefficients = "BT.2020 non-constant";
		adjusted.isHDR = true;
	}
	if (plan.staticMetadata === "remove") {
		Object.assign(adjusted, { maxCLL: "", maxFALL: "", masteringDisplay: "", masteringLuminance: "" });
	}
	if (plan.staticMetadata === "set") {
		adjusted.masteringDisplay = plan.masteringPrimaries === "p3" ? "Display P3" : "BT.2020";
		adjusted.masteringLuminance = `min: ${plan.masteringMinNits} cd/m2, max: ${plan.masteringMaxNits} cd/m2`;
		if (light) Object.assign(adjusted, { maxCLL: String(light.maxCll), maxFALL: String(light.maxFall) });
	}
	return adjusted;
}

export async function runHdrJob(job: Job, config: AppConfig, updateJob: (partial: Partial<Job>) => void, signal?: AbortSignal): Promise<void> {
	if (!job.hdrPlan) throw new Error("HDR job has no plan");
	const plan = job.hdrPlan;
	const tempDir = join(config.tempDir, job.id);
	mkdirSync(tempDir, { recursive: true });
	const stagePath = join(dirname(plan.targetPath), `.rabbit-hdr-${job.id}.mkv`);
	const measures = plan.hdr10Plus === "measure" || plan.hdr10Plus === "dolby-vision";
	const steps = makeSteps(measures);
	const index = (label: string) => steps.findIndex((step) => step.label === label);

	const setStep = (label: string, partial: Partial<JobStep>) => {
		const step = steps[index(label)]!;
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
	const retone = async (args: string[], label: string, onProgress?: (progress: FilmGrainProgress) => void): Promise<RetoneRun> => {
		const result = await runRetone(args, signal, onProgress);
		checkCancelled();
		if (result.code !== 0) throw new Error(`${label} failed: ${retoneErrorText(result)}`);
		return result;
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
		Logger.info(`[hdr] Skipped ${basename(plan.targetPath)}: ${reason}`);
	};

	try {
		if (!existsSync(plan.targetPath)) throw new Error("The video no longer exists");
		if (extname(plan.targetPath).toLowerCase() !== ".mkv") throw new Error("HDR metadata can only be changed in MKV files");
		if (existsSync(stagePath)) throw new Error(`Staging file already exists: ${stagePath}`);

		// Analyze
		setStep("Analyze", { status: "active", progress: 10 });
		updateJob({ status: "probing" });
		const original = await identify(plan.targetPath, signal);
		const video = videoTrackOf(original);
		if (!video.track) throw new Error(video.reason);
		const [info, probe] = await Promise.all([retoneEvents(["info", plan.targetPath], signal), probeFile(plan.targetPath)]);
		checkCancelled();
		const summary = info.events.find((event) => event.event === "summary");
		if (info.code !== 0 || !summary) throw new Error(`retone could not read the video: ${eventError(info.events, info.stderr, info.code)}`);
		updateJob({ probe });
		const frames = Number(summary.frames ?? 0);
		const transfer = Number(summary.transfer_characteristics ?? 2);
		const hasHdr10Plus = Number(summary.hdr10plus_frames ?? 0) > 0;
		const hasDolbyVision = Number(summary.dolby_vision_obus ?? 0) > 0;
		const addsHdr10Plus = plan.hdr10Plus === "measure" || plan.hdr10Plus === "dolby-vision" || plan.hdr10Plus === "file";
		const pq = transfer === 16;
		// Tagging SDR as PQ makes it look washed out, so only video without a transfer tag is tagged.
		const fixColor = plan.fixColor && !pq;
		if (fixColor && transfer !== 2) {
			if (plan.batch) return skip(`tagged as ${nameOf(TRANSFER_NAMES, transfer)}, not PQ`);
			throw new Error(`The video is tagged as ${nameOf(TRANSFER_NAMES, transfer)}, not PQ. Only a video without a transfer tag can be tagged as PQ`);
		}
		if (addsHdr10Plus && !pq && !fixColor) {
			if (plan.batch) return skip("not PQ, HDR10+ needs PQ");
			throw new Error(`HDR10+ needs PQ video, and this video is tagged as ${nameOf(TRANSFER_NAMES, transfer)}`);
		}
		if (plan.batch && plan.skipExisting && addsHdr10Plus && hasHdr10Plus) return skip("already has HDR10+");
		if (hasDolbyVision && !plan.removeDolbyVision) {
			// The MKV keeps Dolby Vision's configuration on the video track, which a rebuilt track loses.
			throw new Error("The video has Dolby Vision metadata, whose configuration would be lost. Remove Dolby Vision as well, or leave this file as it is");
		}
		if (plan.batch && !addsHdr10Plus && !fixColor && plan.staticMetadata === "keep") {
			const removes = (plan.hdr10Plus === "remove" && hasHdr10Plus) || (plan.removeDolbyVision && hasDolbyVision);
			if (!removes) return skip("nothing to remove");
		}
		setStep("Analyze", { progress: 50, detail: "Extracting the video" });
		const { ivf: videoIvf, timestamps } = await extractAv1Track(plan.targetPath, video.track, tempDir, signal);
		setStep("Analyze", { status: "done", progress: 100, detail: `${frames.toLocaleString()} frames, ${(summary.formats ?? []).join(", ") || "SDR"}` });

		// HDR10+
		let metadata: string | null = null;
		if (plan.hdr10Plus === "measure" || plan.hdr10Plus === "dolby-vision") {
			setStep("HDR10+", { status: "active", progress: 0, detail: "Measuring HDR10+ metadata" });
			metadata = join(tempDir, "hdr10plus.json");
			const common = ["-o", metadata, "-y", "--transfer", "pq", "--progress", "json"];
			const args =
				plan.hdr10Plus === "dolby-vision"
					? ["retone", "convert", plan.sourcePath!, "--video", videoIvf, ...common]
					: ["retone", "measure", videoIvf, ...common];
			const result = await retone(args, "Measuring HDR10+", (progress) =>
				setStep("HDR10+", { progress: progress.percent ?? 0, detail: formatFilmGrainProgress(progress) }),
			);
			const scenes = result.summary?.scenes ?? 0;
			const source = result.summary?.scene_source === "dolby_vision_shots" ? " from Dolby Vision shots" : "";
			setStep("HDR10+", { status: "done", progress: 100, detail: `${scenes} ${scenes === 1 ? "scene" : "scenes"}${source}` });
		} else if (plan.hdr10Plus === "file") {
			metadata = plan.metadataPath ?? plan.sourcePath!;
			if (!existsSync(metadata)) throw new Error("The HDR10+ metadata file no longer exists");
		}

		// The MaxCLL and MaxFALL for the MKV colour elements, when they come from HDR10+ metadata.
		let light: { maxCll: number; maxFall: number } | null =
			plan.maxCll !== undefined && plan.maxFall !== undefined ? { maxCll: plan.maxCll, maxFall: plan.maxFall } : null;
		if (plan.staticMetadata === "set" && plan.lightFromHdr10Plus) {
			const statsSource = metadata ?? (hasHdr10Plus ? videoIvf : null);
			if (!statsSource) throw new Error("The video has no HDR10+ metadata to take MaxCLL and MaxFALL from");
			const stats = await retoneEvents(["stats", statsSource], signal);
			const statsSummary = stats.events.find((event) => event.event === "summary");
			if (stats.code !== 0 || !statsSummary) throw new Error(`Reading MaxCLL from HDR10+ failed: ${eventError(stats.events, stats.stderr, stats.code)}`);
			light = { maxCll: Number(statsSummary.max_cll), maxFall: Number(statsSummary.max_fall) };
		}

		// Write
		setStep("Write", { status: "active", progress: 0 });
		updateJob({ status: "muxing" });
		const writes = hdrWriteSteps({ ...plan, fixColor }, videoIvf, tempDir, metadata, hasHdr10Plus);
		let written = videoIvf;
		for (let i = 0; i < writes.length; i++) {
			checkCancelled();
			setStep("Write", { progress: Math.round((i / writes.length) * 100), detail: writes[i]!.label });
			// Each retone run is an equal part of the step, and reports how far it is.
			await retone(writes[i]!.args, writes[i]!.label, (progress) =>
				setStep("Write", {
					progress: Math.round(((i + (progress.percent ?? 0) / 100) / writes.length) * 100),
					detail: `${writes[i]!.label} | ${formatFilmGrainProgress(progress)}`,
				}),
			);
			written = writes[i]!.args[writes[i]!.args.indexOf("-o") + 1]!;
		}
		const after = await retoneEvents(["info", written], signal);
		const afterSummary = after.events.find((event) => event.event === "summary");
		if (after.code !== 0 || !afterSummary) throw new Error(`Reading the new video failed: ${eventError(after.events, after.stderr, after.code)}`);
		if (Number(afterSummary.frames) !== frames) throw new Error(`The new video has ${afterSummary.frames} frames instead of ${frames}`);
		const expectHdr10Plus = addsHdr10Plus || (plan.hdr10Plus === "keep" && hasHdr10Plus);
		if (Number(afterSummary.hdr10plus_frames ?? 0) > 0 !== expectHdr10Plus) throw new Error("The new video does not carry the expected HDR10+ metadata");
		if (plan.removeDolbyVision && Number(afterSummary.dolby_vision_obus ?? 0) > 0) throw new Error("The new video still carries Dolby Vision metadata");
		setStep("Write", { status: "done", progress: 100, detail: describeHdrPlan(plan) });

		// Replace
		setStep("Replace", { status: "active", progress: 0 });
		await replaceVideoTrack({
			targetPath: plan.targetPath,
			stagePath,
			original,
			track: video.track,
			video: written,
			timestamps,
			probe: containerProbe(probe, { ...plan, fixColor }, light),
			tempDir,
			signal,
			onProgress: (progress, detail) => setStep("Replace", { progress, detail }),
		});
		if (plan.metadataPath) rmSync(plan.metadataPath, { force: true });
		setStep("Replace", { status: "done", progress: 100, detail: "Replaced after verification" });
		updateJob({
			status: "done",
			currentStage: "Complete",
			progress: 100,
			outputFilename: plan.targetPath,
			encodedFileSize: humanSize(statSync(plan.targetPath).size),
			finishedAt: Date.now(),
		});
		Logger.info(`[hdr] ${describeHdrPlan(plan)}: ${plan.targetPath}`);
	} catch (error: any) {
		const active = steps.find((step) => step.status === "active");
		if (active) active.status = "error";
		if (error instanceof CancelledError) {
			updateJob({ status: "cancelled", currentStage: "Cancelled", steps: [...steps] });
			throw error;
		}
		Logger.error(`[hdr] ${error?.message || error}`);
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
