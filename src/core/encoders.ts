import type { EncoderId } from "../core/types";
import { ESSENTIAL_BITRATE_MODEL, type BitrateModel } from "../boost/plan";

export interface EncoderDef {
	id: EncoderId;
	label: string;
	binary: string;
	usesAutoBoost: boolean;
	/** Applies a CRF per scene from a Zones config, so Rabbit Boost can drive it. */
	rabbitBoost: boolean;
	/** Has --quality and --speed. Others take --crf and --preset only. */
	speedNames: boolean;
	/** How Rabbit Boost estimates the final bitrate of a scene from its fast pass. */
	bitrateModel?: BitrateModel;
	defaultCrf: number;
	defaultPreset: number;
	crfMin: number;
	crfMax: number;
	presetMin: number;
	presetMax: number;
}

export const ENCODERS: Record<EncoderId, EncoderDef> = {
	"svt-av1-essential": {
		id: "svt-av1-essential",
		label: "SVT-AV1-Essential",
		binary: "SVT-AV1-Essential",
		usesAutoBoost: true,
		rabbitBoost: true,
		speedNames: true,
		bitrateModel: ESSENTIAL_BITRATE_MODEL,
		defaultCrf: 28,
		defaultPreset: 4,
		crfMin: 1,
		crfMax: 70,
		presetMin: -1,
		presetMax: 13,
	},
	"svt-av1-hdr": {
		id: "svt-av1-hdr",
		label: "SVT-AV1-HDR",
		binary: "SVT-AV1-HDR",
		usesAutoBoost: false,
		rabbitBoost: false,
		speedNames: false,
		defaultCrf: 24,
		defaultPreset: 4,
		crfMin: 1,
		crfMax: 70,
		presetMin: -1,
		presetMax: 13,
	},
	"svt-av1-5fish": {
		id: "svt-av1-5fish",
		label: "SVT-AV1-5FISH",
		binary: "SVT-AV1-5FISH",
		usesAutoBoost: false,
		rabbitBoost: false,
		speedNames: false,
		defaultCrf: 24,
		defaultPreset: 4,
		crfMin: 1,
		crfMax: 70,
		presetMin: -1,
		presetMax: 13,
	},
	"svt-av1-tritium": {
		id: "svt-av1-tritium",
		label: "SVT-AV1-Tritium",
		binary: "SVT-AV1-Tritium",
		usesAutoBoost: false,
		rabbitBoost: true,
		speedNames: false,
		// Fitted on the same 69 scenes as Essential's, at preset 4. Its bitrate falls more slowly with CRF.
		bitrateModel: { crfPerHalving: 16, efficiency: 0.85 },
		defaultCrf: 24,
		defaultPreset: 4,
		crfMin: 1,
		crfMax: 70,
		presetMin: -1,
		presetMax: 13,
	},
};

export const ENCODER_IDS = Object.keys(ENCODERS) as EncoderId[];
export const DEFAULT_ENCODER: EncoderId = "svt-av1-essential";

export function getEncoder(id: string | undefined): EncoderDef {
	return ENCODERS[(id ?? "") as EncoderId] ?? ENCODERS[DEFAULT_ENCODER];
}

export function isValidEncoder(id: unknown): id is EncoderId {
	return typeof id === "string" && id in ENCODERS;
}
