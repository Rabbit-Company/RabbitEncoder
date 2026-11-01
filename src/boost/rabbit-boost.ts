import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { EncoderQuality, EncoderSpeed } from "../core/types";
import { readIvf } from "./ivf";
import { baseCrf, FAST_PRESET, planZones, type BitrateModel, sampleFrames, scenesFromKeyframes, SPEED_PRESETS, zonesConfig, type Zone } from "./plan";
import { scoreFrames } from "./score";
import { runSvt, svtCrfFromLog } from "./svt";

export type BoostStage = "fast" | "scenes" | "metrics" | "zones" | "final";

export interface RabbitBoostOptions {
	binary: string;
	/** The prepared video, which is also the reference the fast pass is scored against. */
	input: string;
	output: string;
	workDir: string;
	quality: EncoderQuality;
	/** A CRF and preset set by hand, in place of the quality preset and final speed. Required without `speedNames`. */
	manual?: { crf: number; preset: number };
	/** The encoder has --quality and --speed, as SVT-AV1-Essential does. Others get --crf and --preset. */
	speedNames: boolean;
	/** How the encoder's final bitrate follows from its fast pass, for the cap. */
	bitrateModel?: BitrateModel;
	finalSpeed: EncoderSpeed;
	/** Color flags for both passes. */
	colorParams: string[];
	/** Custom flags, for the final pass only as Auto-Boost-Essential does. */
	customParams: string[];
	dark: boolean;
	/** Highest bitrate in kb/s. 0 for none. */
	maxKbps: number;
	/** Encode once at the base quality, without the fast pass and zones. */
	skipBoosting: boolean;
	/** Frames expected, for progress of the fast pass. */
	expectedFrames: number;
	signal?: AbortSignal;
	onStage: (stage: BoostStage, status: "active" | "done", detail?: string) => void;
	onProgress: (stage: BoostStage, done: number, total: number) => void;
}

export interface RabbitBoostResult {
	zones: Zone[];
	summary: string;
}

function describe(zones: Zone[], maxKbps: number): string {
	if (!zones.length) return "No scenes";
	const crfs = zones.map((z) => z.crf);
	const capped = zones.filter((z) => z.capped).length;
	const parts = [`${zones.length} scenes`, `CRF ${Math.min(...crfs)}–${Math.max(...crfs)}`];
	if (maxKbps > 0) parts.push(`${capped} capped at ${(maxKbps / 1000).toFixed(1)} Mb/s`);
	return parts.join(", ");
}

/**
 * Auto-Boost-Essential's fast pass, scenes and zones, with scenes scored by
 * SSIMULACRA2 on sampled frames, optionally dark-aware, and the bitrate held
 * under a cap: scenes that would go over get a higher CRF, and --mbr keeps
 * peaks within a scene down.
 */
export async function runRabbitBoost(o: RabbitBoostOptions): Promise<RabbitBoostResult> {
	mkdirSync(o.workDir, { recursive: true });
	if (!o.speedNames && !o.manual) throw new Error("This encoder takes a CRF and preset, not a quality preset");
	const rate = o.manual ? ["--crf", String(o.manual.crf)] : ["--quality", o.quality];
	const finalPreset = o.manual ? o.manual.preset : SPEED_PRESETS[o.finalSpeed];
	const cap = o.maxKbps > 0 ? ["--mbr", String(Math.round(o.maxKbps))] : [];
	const finalArgs = (zonesFile?: string) => [
		...(o.manual ? ["--preset", String(o.manual.preset)] : ["--speed", o.finalSpeed]),
		...rate,
		...o.colorParams,
		...o.customParams,
		...(zonesFile ? ["--config", zonesFile] : []),
		...cap,
	];
	const final = async (zonesFile: string | undefined, total: number) => {
		o.onStage("final", "active");
		await runSvt({
			binary: o.binary,
			input: o.input,
			args: finalArgs(zonesFile),
			output: o.output,
			workDir: o.workDir,
			label: "Final pass",
			signal: o.signal,
			onFrame: (frame) => o.onProgress("final", frame, total),
		});
		o.onStage("final", "done");
	};

	if (o.skipBoosting) {
		await final(undefined, o.expectedFrames);
		return { zones: [], summary: "Boosting skipped" };
	}

	const fast = join(o.workDir, "fast.ivf");
	o.onStage("fast", "active");
	const fastLog = await runSvt({
		binary: o.binary,
		input: o.input,
		args: [...(o.speedNames ? ["--speed", "faster"] : ["--preset", String(FAST_PRESET)]), ...rate, ...o.colorParams],
		output: fast,
		workDir: o.workDir,
		label: "Fast pass",
		signal: o.signal,
		onFrame: (frame) => o.onProgress("fast", frame, o.expectedFrames),
	});
	o.onStage("fast", "done");

	o.onStage("scenes", "active");
	const ivf = readIvf(fast);
	const scenes = scenesFromKeyframes(ivf.frames.map((f) => f.keyframe));
	o.onStage("scenes", "done", `${scenes.length} scenes in ${ivf.frames.length} frames`);

	o.onStage("metrics", "active");
	const frames = sampleFrames(scenes);
	const scores = await scoreFrames({
		reference: o.input,
		encode: fast,
		frames,
		dark: o.dark,
		workDir: o.workDir,
		signal: o.signal,
		onProgress: (done, total) => o.onProgress("metrics", done, total),
	});
	o.onStage("metrics", "done", `SSIMULACRA2${o.dark ? ", dark-aware" : ""}, ${frames.length} of ${ivf.frames.length} frames`);

	o.onStage("zones", "active");
	const byFrame = new Map(frames.map((f, i) => [f, scores[i]!]));
	const stats = scenes.map((scene) => {
		let bytes = 0;
		const sceneScores: number[] = [];
		for (let f = scene.start; f < scene.end; f++) {
			bytes += ivf.frames[f]!.size;
			const s = byFrame.get(f);
			if (s !== undefined) sceneScores.push(s);
		}
		return { ...scene, bytes, scores: sceneScores };
	});
	const base = o.manual ? o.manual.crf : baseCrf(o.quality, ivf.width, ivf.height);
	const zones = planZones(stats, {
		baseCrf: base,
		fastCrf: svtCrfFromLog(fastLog) ?? base,
		finalPreset,
		model: o.bitrateModel,
		fps: ivf.fpsNum / ivf.fpsDen,
		maxKbps: o.maxKbps,
	});
	const zonesFile = join(o.workDir, "zones.cfg");
	writeFileSync(zonesFile, zonesConfig(zones));
	writeFileSync(join(o.workDir, "zones.json"), JSON.stringify(zones, null, 1));
	const summary = describe(zones, o.maxKbps);
	o.onStage("zones", "done", summary);

	await final(zonesFile, ivf.frames.length);
	return { zones, summary };
}
