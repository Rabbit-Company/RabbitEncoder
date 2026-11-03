import type { EncoderQuality, EncoderSpeed } from "../core/types";

export interface Scene {
	start: number;
	/** First frame after the scene. */
	end: number;
}

/** Scenes from the key frames of the fast pass, the way Auto-Boost-Essential splits them. */
export function scenesFromKeyframes(keyframes: boolean[]): Scene[] {
	const starts = keyframes.flatMap((k, i) => (k || i === 0 ? [i] : []));
	return starts.map((start, i) => ({ start, end: starts[i + 1] ?? keyframes.length }));
}

/** Every 6th frame keeps a scene's 15th percentile within 0.75 CRF of scoring every frame. */
export const SAMPLE_STEP = 6;
/** Short scenes would get too few samples at that step, so they get at least this many. */
export const MIN_SAMPLES_PER_SCENE = 8;

/** Frames to score: every `step`-th of each scene, or `minimum` spread over it when that gives fewer. */
export function sampleFrames(scenes: Scene[], step = SAMPLE_STEP, minimum = MIN_SAMPLES_PER_SCENE): number[] {
	const out: number[] = [];
	for (const { start, end } of scenes) {
		const length = end - start;
		const stepped = Math.ceil(length / step);
		const count = Math.min(length, Math.max(stepped, minimum));
		if (count === stepped) for (let i = start; i < end; i += step) out.push(i);
		else {
			const picked = new Set<number>();
			for (let i = 0; i < count; i++) picked.add(start + Math.round((i * (length - 1)) / Math.max(1, count - 1)));
			out.push(...[...picked].sort((a, b) => a - b));
		}
	}
	return out;
}

/** The 15th percentile as Python's statistics.quantiles(n=100)[14] gives it, which Auto-Boost-Essential uses. */
export function percentile15(values: number[]): number {
	const data = values.map((v) => Math.max(0, v)).sort((a, b) => a - b);
	if (data.length === 0) return 0;
	if (data.length === 1) return data[0]!;
	const n = 100;
	const m = data.length + 1;
	const i = 15;
	const j = Math.min(Math.max(Math.floor((i * m) / n), 1), data.length - 1);
	const delta = i * m - j * n;
	return (data[j - 1]! * (n - delta) + data[j]! * delta) / n;
}

const QUALITY_CRF: Record<EncoderQuality, number> = { lower: 40, low: 35, medium: 30, high: 25, higher: 20 };

/** The CRF a quality preset stands for, 5 higher above 1080p, as Auto-Boost-Essential reads it. */
export function baseCrf(quality: EncoderQuality, width: number, height: number): number {
	return QUALITY_CRF[quality] + (width * height > 1920 * 1080 ? 5 : 0);
}

/** Presets SVT-AV1-Essential's speed names stand for. */
export const SPEED_PRESETS: Record<EncoderSpeed, number> = { slower: 2, slow: 4, medium: 5, fast: 6, faster: 8 };
/** The fast pass, "faster" on Essential. */
export const FAST_PRESET = SPEED_PRESETS.faster;

/**
 * Bitrate a final preset needs at the same CRF, as a share of the fast
 * pass's preset 8. Measured on a minute of Solo Leveling at CRF 30: Essential
 * 0.93, 0.88, 0.85 and 0.76 at presets 6, 5, 4 and 2, Tritium a little less.
 * Essential's are used for both, so a cap errs on the low side.
 */
const PRESET_BITRATE_SHARE: Record<number, number> = { 8: 1, 7: 0.965, 6: 0.93, 5: 0.88, 4: 0.85, 3: 0.805, 2: 0.76, 1: 0.73, 0: 0.7, [-1]: 0.68 };

export function presetBitrateShare(preset: number): number {
	const p = Math.round(preset);
	return p >= FAST_PRESET ? 1 : (PRESET_BITRATE_SHARE[Math.max(-1, p)] ?? 1);
}

/** How an encoder's final pass bitrate follows from its fast pass. */
export interface BitrateModel {
	/** CRF steps that halve the bitrate. */
	crfPerHalving: number;
	/** Final pass bitrate at the fast pass's CRF, as a share of the fast pass's after the preset's own share. */
	efficiency: number;
}

/** Fitted on 69 scenes of Solo Leveling capped at 3 Mb/s, Essential at speed slow, scenes within ±10%. */
export const ESSENTIAL_BITRATE_MODEL: BitrateModel = { crfPerHalving: 12, efficiency: 0.73 };

/**
 * Capped scenes are aimed this far under the cap, as a scene's final
 * bitrate can land 10 to 16% off its estimate.
 */
export const CAP_AIM = 0.9;

/** The final pass's bitrate at `crf` as a share of the fast pass's, which ran at `fastCrf` and preset 8. */
export function finalBitrateShare(crf: number, fastCrf: number, finalPreset: number, model: BitrateModel = ESSENTIAL_BITRATE_MODEL): number {
	return presetBitrateShare(finalPreset) * model.efficiency * 2 ** (-(crf - fastCrf) / model.crfPerHalving);
}

export interface ZonePlanOptions {
	baseCrf: number;
	/** The CRF the fast pass ran at, which its bitrates belong to. */
	fastCrf: number;
	/** Preset of the final pass. */
	finalPreset: number;
	/** The encoder's own model. SVT-AV1-Essential's when absent. */
	model?: BitrateModel;
	/** Largest CRF change the scores may make either way. Auto-Boost-Essential uses 5. */
	maxChange?: number;
	/** Scene average the final encode should stay under, in kb/s. 0 for none. */
	maxKbps?: number;
	fps: number;
}

export interface SceneStats extends Scene {
	/** Scores of the scene's sampled frames. */
	scores: number[];
	/** Bytes of the scene in the fast pass. */
	bytes: number;
}

export interface Zone extends Scene {
	crf: number;
	/** The scene's 15th percentile score. */
	score: number;
	/** Bitrate of the scene in the fast pass. */
	fastKbps: number;
	/** Bitrate the final pass is expected to give the scene at its CRF. */
	predictedKbps: number;
	/** The CRF was raised to keep the scene under the bitrate cap. */
	capped: boolean;
}

const quarter = (v: number) => Math.round(v * 4) / 4;

/**
 * A CRF per scene. Scenes scoring below the episode's average get a lower
 * CRF and better ones a higher, by Auto-Boost-Essential's rule, within
 * `maxChange`. A scene whose bitrate would then go over the cap gets the
 * CRF that brings it under, so a noisy scene no one looks at closely cannot
 * take 20 Mb/s.
 */
export function planZones(scenes: SceneStats[], options: ZonePlanOptions): Zone[] {
	const maxChange = options.maxChange ?? 5;
	const all = scenes.flatMap((s) => s.scores.map((v) => Math.max(0, v)));
	const mean = all.length ? all.reduce((a, b) => a + b, 0) / all.length : 0;
	return scenes.map((scene) => {
		const score = percentile15(scene.scores);
		const seconds = (scene.end - scene.start) / options.fps;
		const fastKbps = seconds > 0 ? (scene.bytes * 8) / seconds / 1000 : 0;
		let crf = options.baseCrf;
		if (mean > 0 && scene.scores.length) {
			const adjustment = Math.ceil((1 - score / mean) * 20 * 4) / 4;
			crf = options.baseCrf - Math.max(-maxChange, Math.min(maxChange, adjustment));
		}
		let capped = false;
		const model = options.model ?? ESSENTIAL_BITRATE_MODEL;
		// What the final pass would need at the fast pass's CRF, then moved to the scene's CRF.
		const atFastCrf = fastKbps * finalBitrateShare(options.fastCrf, options.fastCrf, options.finalPreset, model);
		const expectedAt = (at: number) => fastKbps * finalBitrateShare(at, options.fastCrf, options.finalPreset, model);
		if (options.maxKbps && options.maxKbps > 0 && fastKbps > 0) {
			const aim = options.maxKbps * CAP_AIM;
			if (expectedAt(crf) > aim) {
				// Rounded up to a quarter, ignoring the rounding noise of whole bytes.
				crf = Math.ceil((options.fastCrf + model.crfPerHalving * Math.log2(atFastCrf / aim)) * 4 - 1e-3) / 4;
				capped = true;
			}
		}
		crf = Math.min(70, Math.max(1, quarter(crf)));
		return { start: scene.start, end: scene.end, crf, score, fastKbps, predictedKbps: expectedAt(crf), capped };
	});
}

/** The Zones line SVT-AV1-Essential reads from a --config file. */
export function zonesConfig(zones: Zone[]): string {
	return `Zones : ${zones.map((z) => `${z.start},${z.end - 1},${z.crf}`).join(";")};\n`;
}
