import type {
	AudioChannelBitrates,
	AudioCodecPriority,
	AudioEncodeMode,
	AutoDenoiseMetric,
	AvdEngine,
	AvdParams,
	AvdPreset,
	CropMode,
	DebandLevel,
	DenoiseBackend,
	DenoiseEngine,
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

export const DEFAULT_DENOISE_ENGINE: DenoiseEngine = "avd-nl4d";
/** Ordered from best to worst quality. */
export const DENOISE_ENGINES: readonly DenoiseEngine[] = ["avd-nl4d", "avd-nlmeans-hq", "avd-nlmeans", "nlmeans"];
export const AVD_ENGINES: readonly AvdEngine[] = ["avd-nlmeans", "avd-nlmeans-hq", "avd-nl4d"];
export const AVD_PRESETS: readonly AvdPreset[] = ["veryfast", "fast", "base", "slow", "veryslow"];
export const DEFAULT_AVD_PARAMS: AvdParams = {
	preset: "base",
	nlmeansStrength: { light: 1.0, medium: 1.5, heavy: 2.0 },
	scales: { "avd-nlmeans-hq": 1.0, "avd-nl4d": 1.0 },
};
export const DENOISE_ENGINE_HELP: Record<DenoiseEngine, string> = {
	nlmeans: "FFmpeg nlmeans. Runs on CPU, OpenCL or Vulkan.",
	"avd-nlmeans": "av-denoise fast NLMeans. GPU only. Hand-set strength per level, only suited to light denoising.",
	"avd-nlmeans-hq": "av-denoise NLMeans-HQ. GPU only. Measures the noise in each scene and sets its own strength, so light, medium and heavy denoise the same.",
	"avd-nl4d":
		"av-denoise NL4D. GPU only. Best noise removal and detail retention, and the slowest. Models the noise in each scene and sets its own strength, so light, medium and heavy denoise the same.",
};
/** What the strength number means for each av-denoise engine. */
export const AVD_STRENGTH_HELP: Record<AvdEngine, string> = {
	"avd-nlmeans":
		"Filter strength, same scale as FFmpeg nlmeans. Move in steps of about 0.1. Auto denoise uses the value of the level it assigns to each scene.",
	"avd-nlmeans-hq":
		"Sigma scale: one multiplier on the noise level the engine measures itself, used at every denoise level. 1.0 trusts the measurement, which is almost always right. Change it only in steps of 0.1 and judge by eye.",
	"avd-nl4d":
		"Threshold scale: one multiplier on the engine's own noise model, used at every denoise level. 1.0 trusts it, which is almost always right. Higher removes more noise and more fine detail. Change it only in steps of 0.05 to 0.1.",
};

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
export const DEFAULT_BITRATE_THRESHOLDS = { light: 1.3, medium: 1.8, heavy: 2.5 };
export const AUTO_DENOISE_METRICS: readonly AutoDenoiseMetric[] = ["noise", "bitrate"];

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
	prepare: "Run denoise and VS only. Pass audio, subtitles, and video through (FFV1). For GPU-only servers.",
	translate:
		"Only add missing subtitle languages via AI translation. Video, audio, existing subtitles, chapters, and fonts are copied 1:1. The output keeps its original filename.",
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
