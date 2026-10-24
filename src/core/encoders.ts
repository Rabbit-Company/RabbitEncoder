import type { EncoderId } from "../core/types";

export interface EncoderDef {
	id: EncoderId;
	label: string;
	binary: string;
	usesAutoBoost: boolean;
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
