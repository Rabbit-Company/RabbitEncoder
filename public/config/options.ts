import type {
	AudioChannelBitrates,
	AudioCodecPriority,
	AudioEncodeMode,
	CropMode,
	DebandLevel,
	DenoiseBackend,
	DenoiseLevel,
	EncoderId,
	EncoderQuality,
	EncoderSpeed,
	StyleAppearance,
	SubtitleProcessingMode,
	VideoEncodeMode,
} from "../types";
import type { PipelinePreset } from "../ui/models";

export const ENCODERS: Record<
	EncoderId,
	{ label: string; usesAutoBoost: boolean; crfMin: number; crfMax: number; presetMin: number; presetMax: number; defaultCrf: number; defaultPreset: number }
> = {
	"svt-av1-essential": {
		label: "SVT-AV1-Essential",
		usesAutoBoost: true,
		crfMin: 1,
		crfMax: 70,
		presetMin: -1,
		presetMax: 13,
		defaultCrf: 28,
		defaultPreset: 4,
	},
	"svt-av1-hdr": { label: "SVT-AV1-HDR", usesAutoBoost: false, crfMin: 1, crfMax: 70, presetMin: -1, presetMax: 13, defaultCrf: 24, defaultPreset: 4 },
	"svt-av1-5fish": { label: "SVT-AV1-5FISH", usesAutoBoost: false, crfMin: 1, crfMax: 70, presetMin: -1, presetMax: 13, defaultCrf: 24, defaultPreset: 4 },
};
export const ENCODER_IDS = Object.keys(ENCODERS) as EncoderId[];
export const ENCODER_HELP: Record<EncoderId, string> = {
	"svt-av1-essential": "Easiest to use (automatic per-scene CRF optimization)",
	"svt-av1-hdr": "Recommended for live-action content.",
	"svt-av1-5fish": "Recommended for anime and animation.",
};

export const QUALITIES: readonly EncoderQuality[] = ["low", "medium", "high"];
export const SPEEDS: readonly EncoderSpeed[] = ["slower", "slow", "medium", "fast", "faster"];
export const DENOISE_LEVELS: readonly DenoiseLevel[] = ["off", "auto", "light", "medium", "heavy"];
export const DEBAND_LEVELS: readonly DebandLevel[] = ["off", "light", "medium", "heavy"];
export const PARAM_LEVELS = ["light", "medium", "heavy"] as const;
export const CROP_OPTIONS: readonly CropMode[] = ["off", "auto"];

export const DENOISE_BACKENDS: readonly DenoiseBackend[] = ["cpu", "auto", "vulkan", "opencl"];

export const DEFAULT_NLMEANS_PARAMS = {
	light: { s: 1.0, p: 3, r: 7 },
	medium: { s: 1.5, p: 3, r: 9 },
	heavy: { s: 2.0, p: 3, r: 11 },
};
export const DEFAULT_GRADFUN_PARAMS = {
	light: { strength: 0.8, radius: 8 },
	medium: { strength: 1.4, radius: 16 },
	heavy: { strength: 2.8, radius: 24 },
};
export const DEFAULT_AUTO_THRESHOLDS = { light: 0.5, medium: 0.7, heavy: 0.9 };

export const AUDIO_CODEC_PRIORITY_OPTIONS: AudioCodecPriority[] = ["lossless-first", "smallest-first"];

export const CHANNELS: readonly { key: keyof AudioChannelBitrates; label: string }[] = [
	{ key: "mono", label: "Mono" },
	{ key: "stereo", label: "Stereo" },
	{ key: "2.1", label: "2.1" },
	{ key: "3.0", label: "3.0" },
	{ key: "3.1", label: "3.1" },
	{ key: "4.0", label: "4.0" },
	{ key: "4.1", label: "4.1" },
	{ key: "5.0", label: "5.0" },
	{ key: "5.1", label: "5.1" },
	{ key: "6.0", label: "6.0" },
	{ key: "6.1", label: "6.1" },
	{ key: "7.0", label: "7.0" },
	{ key: "7.1", label: "7.1" },
	{ key: "7.1.4", label: "7.1.4" },
];

export const PIPELINE_PRESETS: readonly PipelinePreset[] = ["full", "prepare", "translate", "custom"];
export const VIDEO_ENCODE_OPTIONS: readonly VideoEncodeMode[] = ["av1", "off"];
export const AUDIO_ENCODE_OPTIONS: readonly AudioEncodeMode[] = ["opus", "copy"];
export const SUBTITLE_PROCESSING_OPTIONS: readonly SubtitleProcessingMode[] = ["full", "copy"];
export const SUBTITLE_SOURCE_PRIORITY_OPTIONS = ["official-first", "fansub-first"] as const;
export const SUBTITLE_FANSUB_TIEBREAK_OPTIONS = ["alphabetical", "source-order"] as const;
export const SUBTITLE_FORMAT_PRIORITY_OPTIONS = ["text-first", "picture-first"] as const;

export const PIPELINE_PRESET_HELP: Record<PipelinePreset, string> = {
	full: "Denoise, AV1, Opus, full subtitle pipeline.",
	prepare: "Run denoise & VS only; pass audio/subs/video through (FFV1). For GPU-only servers.",
	translate:
		"Only add missing subtitle languages via AI translation. Video, audio, existing subtitles, chapters and fonts are copied 1:1; the output keeps its original filename.",
	custom: "Configure each pipeline stage individually below.",
};

export const TRANSLATE_PROVIDERS = ["openai", "anthropic"] as const;
export type TranslateProviderOption = (typeof TRANSLATE_PROVIDERS)[number];

export const TRANSLATE_PROVIDER_LABELS: Record<TranslateProviderOption, string> = {
	openai: "OpenAI API format",
	anthropic: "Anthropic API format",
};

export const TRANSLATE_PROVIDER_URL_PLACEHOLDERS: Record<TranslateProviderOption, string> = {
	openai: "http://localhost:11434/v1",
	anthropic: "https://api.anthropic.com",
};

export const TRANSLATE_PROVIDER_MODEL_PLACEHOLDERS: Record<TranslateProviderOption, string> = {
	openai: "gemma3:12b",
	anthropic: "claude-sonnet-4-6",
};

export const DEFAULT_STYLE_APPEARANCE: StyleAppearance = {
	fontSize: 80,
	primaryColour: "&H00FFFFFF",
	outlineColour: "&H00000000",
	backColour: "&H80000000",
	outline: 4,
	shadow: 1.5,
	alignment: 2,
	marginV: 50,
	marginL: 135,
	marginR: 135,
	bold: false,
	fontAxes: { wght: 700 },
};
