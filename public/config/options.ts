import type {
	AudioChannelBitrates,
	AudioCodecPriority,
	AudioEncodeMode,
	AutoDenoiseMetric,
	AvdEngine,
	AvdParams,
	RabbitDenoiseParams,
	RabbitDevice,
	AvdPreset,
	Booster,
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
	{
		label: string;
		usesAutoBoost: boolean;
		rabbitBoost: boolean;
		crfMin: number;
		crfMax: number;
		presetMin: number;
		presetMax: number;
		defaultCrf: number;
		defaultPreset: number;
	}
> = {
	"svt-av1-essential": {
		label: "SVT-AV1-Essential",
		usesAutoBoost: true,
		rabbitBoost: true,
		crfMin: 1,
		crfMax: 70,
		presetMin: -1,
		presetMax: 13,
		defaultCrf: 28,
		defaultPreset: 4,
	},
	"svt-av1-hdr": {
		label: "SVT-AV1-HDR",
		usesAutoBoost: false,
		rabbitBoost: false,
		crfMin: 1,
		crfMax: 70,
		presetMin: -1,
		presetMax: 13,
		defaultCrf: 24,
		defaultPreset: 4,
	},
	"svt-av1-5fish": {
		label: "SVT-AV1-5FISH",
		usesAutoBoost: false,
		rabbitBoost: false,
		crfMin: 1,
		crfMax: 70,
		presetMin: -1,
		presetMax: 13,
		defaultCrf: 24,
		defaultPreset: 4,
	},
	"svt-av1-tritium": {
		label: "SVT-AV1-Tritium",
		usesAutoBoost: false,
		rabbitBoost: true,
		crfMin: 1,
		crfMax: 70,
		presetMin: -1,
		presetMax: 13,
		defaultCrf: 24,
		defaultPreset: 4,
	},
};
export const ENCODER_IDS = Object.keys(ENCODERS) as EncoderId[];
export const ENCODER_HELP: Record<EncoderId, string> = {
	"svt-av1-essential": "Easiest to use (automatic per-scene CRF optimization)",
	"svt-av1-hdr": "Recommended for live-action content.",
	"svt-av1-5fish": "Recommended for anime and animation.",
	"svt-av1-tritium": "SVT-AV1-HDR with scene detection and auto tiling from Essential.",
};

export const QUALITIES: readonly EncoderQuality[] = ["lower", "low", "medium", "high", "higher"];
export const SPEEDS: readonly EncoderSpeed[] = ["slower", "slow", "medium", "fast", "faster"];
export const DENOISE_LEVELS: readonly DenoiseLevel[] = ["off", "auto", "light", "medium", "heavy"];
export const DEBAND_LEVELS: readonly DebandLevel[] = ["off", "light", "medium", "heavy"];
export const PARAM_LEVELS = ["light", "medium", "heavy"] as const;
export const CROP_OPTIONS: readonly CropMode[] = ["off", "auto"];
export const BOOSTERS: readonly Booster[] = ["auto-boost-essential", "rabbit-boost"];

export const DENOISE_BACKENDS: readonly DenoiseBackend[] = ["cpu", "auto", "vulkan", "opencl"];

export const DEFAULT_DENOISE_ENGINE: DenoiseEngine = "avd-nl4d";
/** Ordered from best to worst quality. */
export const DENOISE_ENGINES: readonly DenoiseEngine[] = ["rabbit-denoise", "avd-nl4d", "avd-nlmeans-hq", "avd-nlmeans", "nlmeans"];
export const AVD_ENGINES: readonly AvdEngine[] = ["rabbit-denoise", "avd-nlmeans", "avd-nlmeans-hq", "avd-nl4d"];
/** rabbit-denoise refuses a strength scale outside this range. */
export const RABBIT_SCALE_RANGE = { min: 0.25, max: 4 } as const;

/** rabbit-denoise's own defaults, the best quality measured. */
export const DEFAULT_RABBIT_PARAMS: RabbitDenoiseParams = {
	device: "auto",
	chromaScale: 1.0,
	lambda: 2.7,
	basic: false,
	step: 3,
	temporalRadius: 3,
	searchRadius: 5,
	matchesPerFrame: 2,
	minShift: 4,
	groupSize: 16,
	matchLimit: 2.0,
	wienerMatchLimit: 0.5,
	followRadius: null,
	wienerFollowRadius: null,
	motionRange: 16,
	motion: true,
	singleFrameCap: true,
	lumaGuidedChroma: true,
};
export const RABBIT_DEVICES: readonly RabbitDevice[] = ["auto", "gpu", "cpu"];
export const RABBIT_DEVICE_HELP =
	"auto uses the GPU when one works and the CPU otherwise, about 20 times slower. gpu fails the job without a GPU instead. cpu is for testing.";

/** A rabbit-denoise number setting, with the range rabbit-denoise accepts. */
export interface RabbitNumberField {
	key:
		| "chromaScale"
		| "lambda"
		| "step"
		| "temporalRadius"
		| "searchRadius"
		| "matchesPerFrame"
		| "minShift"
		| "groupSize"
		| "matchLimit"
		| "wienerMatchLimit"
		| "motionRange";
	label: string;
	min: number;
	max: number;
	step: number;
	help: string;
}
export const RABBIT_STRENGTH_FIELDS: readonly RabbitNumberField[] = [
	{
		key: "chromaScale",
		label: "Chroma scale",
		min: 0.25,
		max: 4,
		step: 0.05,
		help: "Multiplies the colour grain on top of the strength scale. Above 1 removes more colour grain.",
	},
	{
		key: "lambda",
		label: "Threshold",
		min: 1,
		max: 6,
		step: 0.1,
		help: "Grain deviations a coefficient must clear to survive the first stage. Higher removes more.",
	},
];
export const RABBIT_MATCHING_HELP =
	"Every patch on a grid is filtered together with the patches most like it, from its own frame and the frames around it. These trade speed against quality.";
export const RABBIT_MATCHING_FIELDS: readonly RabbitNumberField[] = [
	{
		key: "step",
		label: "Step",
		min: 1,
		max: 6,
		step: 1,
		help: "Distance between reference patches. 3 is the best quality. 4 is about 30 per cent faster for about 0.3 dB less.",
	},
	{
		key: "temporalRadius",
		label: "Temporal radius",
		min: 0,
		max: 16,
		step: 1,
		help: "Frames on each side that matches come from. 2 is about 20 per cent faster for about 0.4 dB less, 5 gains about 0.1 dB over 3. 0 matches within the frame only.",
	},
	{
		key: "searchRadius",
		label: "Search radius",
		min: 0,
		max: 7,
		step: 1,
		help: "How far matches are searched for in a patch's own frame. 5 scores within 0.1 dB of 7 and is faster.",
	},
	{ key: "matchesPerFrame", label: "Matches per frame", min: 1, max: 8, step: 1, help: "Matches taken into a group from each frame, besides the reference." },
	{
		key: "minShift",
		label: "Minimum shift",
		min: 1,
		max: 8,
		step: 1,
		help: "How far apart two matches from one frame must be. Closer patches share most of their grain.",
	},
	{ key: "groupSize", label: "Group size", min: 2, max: 16, step: 1, help: "Most patches in a group, the reference included." },
	{
		key: "matchLimit",
		label: "Match limit",
		min: 0.5,
		max: 8,
		step: 0.1,
		help: "How much a first stage match may differ from its reference, in multiples of what grain alone makes. Higher blurs, lower removes less grain.",
	},
	{
		key: "wienerMatchLimit",
		label: "Second stage match limit",
		min: 0.1,
		max: 4,
		step: 0.05,
		help: "The same for the second stage, which matches on the first stage's result.",
	},
];
export const RABBIT_MOTION_FIELDS: readonly RabbitNumberField[] = [
	{
		key: "motionRange",
		label: "Motion range",
		min: 0,
		max: 32,
		step: 2,
		help: "How far the motion fields look for a block's move between two frames. Raise it for very fast motion.",
	},
];
export const RABBIT_FOLLOW_RADII = ["auto", "0", "1", "2", "3", "4", "5", "6", "7"] as const;
export const RABBIT_HELP = {
	basic: "Return the first stage's result and skip the second: about twice as fast and about 2 dB worse.",
	motion: "Follow patches into neighbouring frames with motion fields. Without them it is 0.15 to 0.25 dB worse and 16 to 20 per cent slower.",
	followRadius: "Search radius in neighbouring frames, around a patch's track and where the motion field moves it. auto is 1 with motion fields and 3 without.",
	wienerFollowRadius: "The follow radius for the second stage alone. auto uses the one above.",
	singleFrameCap:
		"Cap the grain measured between frames by the grain measured in single frames. Motion reads high between frames and texture in single frames, so the smaller is used.",
	lumaGuidedChroma: "Match chroma blocks on luma when measuring chroma grain. Matching on chroma reads its grain 10 to 20 per cent low.",
} as const;
export const FILM_GRAIN_SAMPLINGS = ["all", "half", "quarter", "eighth"] as const;
export const FILM_GRAIN_RANGES = ["representative", "full"] as const;
export const FILM_GRAIN_SIZES = ["fine", "medium", "coarse"] as const;
export const AVD_PRESETS: readonly AvdPreset[] = ["veryfast", "fast", "base", "slow", "veryslow"];
export const DEFAULT_AVD_PARAMS: AvdParams = {
	preset: "base",
	nlmeansStrength: { light: 1.0, medium: 1.5, heavy: 2.0 },
	scales: { "avd-nlmeans-hq": 1.0, "avd-nl4d": 1.0, "rabbit-denoise": 1.0 },
	rabbit: DEFAULT_RABBIT_PARAMS,
};
export const DENOISE_ENGINE_HELP: Record<DenoiseEngine, string> = {
	nlmeans: "FFmpeg nlmeans. Runs on CPU, OpenCL or Vulkan.",
	"avd-nlmeans": "av-denoise fast NLMeans. GPU only. Hand-set strength per level, only suited to light denoising.",
	"avd-nlmeans-hq": "av-denoise NLMeans-HQ. GPU only. Measures the noise in each scene and sets its own strength, so light, medium and heavy denoise the same.",
	"avd-nl4d":
		"av-denoise NL4D. GPU only. Best noise removal and detail retention, and the slowest. Models the noise in each scene and sets its own strength, so light, medium and heavy denoise the same.",
	"rabbit-denoise":
		"rabbit-denoise. Runs on the GPU, or on the CPU about 20 times slower when no GPU works. Film grain denoiser: measures the grain of each scene at every frequency and brightness and removes it while keeping detail, made to pair with film grain restore. Sets its own strength, so light, medium and heavy denoise the same.",
};
/** What the strength number means for each av-denoise engine. */
export const AVD_STRENGTH_HELP: Record<AvdEngine, string> = {
	"avd-nlmeans":
		"Filter strength, same scale as FFmpeg nlmeans. Move in steps of about 0.1. Auto denoise uses the value of the level it assigns to each scene.",
	"avd-nlmeans-hq":
		"Sigma scale: one multiplier on the noise level the engine measures itself, used at every denoise level. 1.0 trusts the measurement, which is almost always right. Change it only in steps of 0.1 and judge by eye.",
	"avd-nl4d":
		"Threshold scale: one multiplier on the engine's own noise model, used at every denoise level. 1.0 trusts it, which is almost always right. Higher removes more noise and more fine detail. Change it only in steps of 0.05 to 0.1.",
	"rabbit-denoise":
		"Sigma scale: one multiplier on the grain the denoiser measures, used at every denoise level. 1.0 removes the grain as measured, which is almost always right. Higher removes more grain and more fine detail, lower leaves some grain in. 0.25 to 4.",
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
export const DEFAULT_GRAIN_THRESHOLDS = { light: 2, medium: 3, heavy: 5 };
export const AUTO_DENOISE_METRICS: readonly AutoDenoiseMetric[] = ["noise", "bitrate", "grain"];

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
