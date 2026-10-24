export type EncoderId = "svt-av1-essential" | "svt-av1-hdr" | "svt-av1-5fish" | "svt-av1-tritium";
export type EncoderQuality = "lower" | "low" | "medium" | "high" | "higher";
export type EncoderSpeed = "slower" | "slow" | "medium" | "fast" | "faster";
export type DenoiseLevel = "off" | "light" | "medium" | "heavy" | "auto";
export type DebandLevel = "off" | "light" | "medium" | "heavy";

export type EncodeMode = "full" | "preview";
export type VideoEncodeMode = "av1" | "off";
/** How much of the video regrain measures: every frame, or the first frames of every 48 frame period. */
export const FILM_GRAIN_SAMPLINGS = ["all", "half", "quarter", "eighth"] as const;
export type FilmGrainSampling = (typeof FILM_GRAIN_SAMPLINGS)[number];
export const FILM_GRAIN_RANGES = ["representative", "full"] as const;
/** Kind of subtitle track a batch translation reads from. "any" takes the best text track in the language. */
export const TRANSLATE_SOURCE_TYPES = ["full", "honorifics", "sdh", "any"] as const;
export type TranslateSourceType = (typeof TRANSLATE_SOURCE_TYPES)[number];
export interface TranslateSourceMatch {
	language: string;
	type: TranslateSourceType;
}
export type FilmGrainRange = (typeof FILM_GRAIN_RANGES)[number];
/** How large synthetic grain is: single pixels, film grain, or clumps a few pixels wide. */
export const FILM_GRAIN_SIZES = ["fine", "medium", "coarse"] as const;
export type FilmGrainSize = (typeof FILM_GRAIN_SIZES)[number];
/** How the strength of synthetic grain is given: as a deviation, or as the sensor noise of a camera at an ISO. */
export const FILM_GRAIN_SYNTHETIC_MODES = ["strength", "iso"] as const;
export type FilmGrainSyntheticMode = (typeof FILM_GRAIN_SYNTHETIC_MODES)[number];
export type AudioEncodeMode = "opus" | "copy";
export type SubtitleProcessingMode = "full" | "copy" | "translate";

export type CropMode = "off" | "auto";

export type AudioTrackType = "main" | "commentary" | "descriptive" | "karaoke";
export type AudioCodecPriority = "lossless-first" | "smallest-first";

export type SubtitleBurnMode = "text" | "bitmap" | "none";

export type SubtitleLangDetectMode = "enabled" | "und-only" | "disabled";
export type SubtitleSourcePriority = "official-first" | "fansub-first";
export type SubtitleFansubTiebreak = "alphabetical" | "source-order";
export type SubtitleFormatPriority = "text-first" | "picture-first";

export interface SourceTrackPlan {
	subtitleStreams: SubtitleStreamInfo[];
	audioStreams: AudioStreamInfo[];
}

export interface PreviewFrameSink {
	/** Absolute dir for this sample's artifacts (source.png, encode.png, vs_*.png, prepare.png, encoded.mkv, source_clip.mkv). */
	dir: string;
	/** Seconds into the clip to grab stills (usually window/2). */
	frameOffsetSec: number;
	/** Color-aware still extractor (closure supplied by the preview driver). Non-fatal on failure. */
	capture(inputPath: string, outName: string, burnSubs: SubtitleBurnMode): Promise<void>;
}

export interface EncodeJobOptions {
	mode?: EncodeMode;
	/** Skip whole-source detection; use these decisions instead. */
	precomputed?: SourceTrackPlan;
	/** Preview-only artifact sink. Presence implies preview mode. */
	preview?: PreviewFrameSink;
	/** Where a preview clip starts in its source video, in seconds. */
	clipStartSeconds?: number;
}

/**
 * Backend used for the nlmeans denoise filter.
 *
 *   - "cpu"    : never use GPU; run nlmeans on CPU.
 *   - "auto"   : probe Vulkan first, then OpenCL; fall back to CPU.
 *   - "vulkan" : use nlmeans_vulkan (falls back to CPU if probe fails).
 *   - "opencl" : use nlmeans_opencl (falls back to CPU if probe fails).
 */
export type DenoiseBackend = "cpu" | "auto" | "vulkan" | "opencl";

export type GpuBackend = "auto" | "vulkan" | "opencl";

/**
 * Which denoiser runs when denoise is enabled.
 *
 *   - "nlmeans"        : FFmpeg nlmeans (CPU / OpenCL / Vulkan, see DenoiseBackend).
 *   - "avd-nlmeans"    : av-denoise fast NLMeans. GPU only.
 *   - "avd-nlmeans-hq" : av-denoise NLMeans-HQ, measures the noise level itself. GPU only.
 *   - "avd-nl4d"       : av-denoise NL4D spatio-temporal denoiser. GPU only.
 */
export type DenoiseEngine = "nlmeans" | "avd-nlmeans" | "avd-nlmeans-hq" | "avd-nl4d";
export type AvdEngine = Exclude<DenoiseEngine, "nlmeans">;
export type AvdPreset = "veryfast" | "fast" | "base" | "slow" | "veryslow";

/** One strength value per denoise level. */
export interface AvdLevelStrengths {
	light: number;
	medium: number;
	heavy: number;
}

/** The av-denoise engines that measure the source's noise and set their own strength. */
export type AvdSelfTuningEngine = "avd-nlmeans-hq" | "avd-nl4d";

/** Parameters for the av-denoise engines. */
export interface AvdParams {
	/** av-denoise --preset, the speed/quality ladder (mainly the temporal window). Not used by avd-nl4d. */
	preset: AvdPreset;
	/** avd-nlmeans --strength per denoise level (same scale as FFmpeg nlmeans). */
	nlmeansStrength: AvdLevelStrengths;
	/**
	 * Multiplier on what the self-tuning engines measure: --hq-sigma-scale for avd-nlmeans-hq,
	 * --lambda-ht-scale for avd-nl4d. One value for every denoise level, because the engine already
	 * adapts its strength to each scene. 1.0 trusts the measurement.
	 */
	scales: Record<AvdSelfTuningEngine, number>;
}

export type JobStatus = "queued" | "probing" | "encoding_video" | "encoding_audio" | "muxing" | "done" | "error" | "cancelled";

export const MEDIA_EXTENSIONS = new Set([".mp4", ".mkv", ".avi", ".webm", ".flv", ".ts", ".mov"]);

export interface AudioChannelBitrates {
	mono: number;
	stereo: number;
	"2.1": number;
	"3.0": number;
	"3.1": number;
	"4.0": number;
	"4.1": number;
	"5.0": number;
	"5.1": number;
	"6.0": number;
	"6.1": number;
	"7.0": number;
	"7.1": number;
	"7.1.4": number;
}

export interface AutoDenoiseThresholds {
	light: number;
	medium: number;
	heavy: number;
}

/**
 * Which signal auto-denoise uses to classify scenes into light/medium/heavy:
 *   - "noise"   : bit-plane noise reading (bitplanenoise=bitplane=4). Good for
 *                 classic sensor/film grain; can under-score structured VFX
 *                 texture overlays that are expensive but not "random".
 *   - "bitrate" : each scene's source bitrate relative to the file's own
 *                 median. Directly targets "this costs a lot of bits" instead
 *                 of a noise proxy, at the cost of not knowing WHY a scene is
 *                 expensive (grain vs. legitimate motion/detail).
 */
export type AutoDenoiseMetric = "noise" | "bitrate";

/** One range of the denoise plan actually applied to a job's encode. */
export interface AutoDenoiseAppliedRange {
	start: number;
	end: number;
	level: "light" | "medium" | "heavy";
}

/**
 * Parameters for FFmpeg's nlmeans / nlmeans_opencl / nlmeans_vulkan filter.
 *
 *   s : denoising strength    [1.0 – 30.0]
 *   p : patch size (odd)      [0 – 99]
 *   r : research size (odd)   [0 – 99]
 */
export interface NlmeansParams {
	s: number;
	p: number;
	r: number;
}

export interface NlmeansLevelParams {
	light: NlmeansParams;
	medium: NlmeansParams;
	heavy: NlmeansParams;
}

/**
 * Parameters for FFmpeg's gradfun deband filter.
 *
 *   strength : max change per pixel / flatness threshold [0.51 – 64]
 *   radius   : neighbourhood size                        [8 – 32]
 */
export interface GradfunParams {
	strength: number;
	radius: number;
}

export interface GradfunLevelParams {
	light: GradfunParams;
	medium: GradfunParams;
	heavy: GradfunParams;
}

export interface JobSettings {
	encoder: EncoderId;
	/** Auto-Boost-Essential uses manualCrf and manualPreset instead of quality and finalSpeed. */
	manualQuality: boolean;
	manualCrf: number;
	manualPreset: number;
	customEncoderParams: string;
	filmGrainTablePath: string;
	filmGrainSampling: FilmGrainSampling;
	/** Missing on older saved settings, which measured the full video. */
	filmGrainRange?: FilmGrainRange;
	/** Measure the grain Rabbit's own denoiser removes and write it back into the encode. */
	filmGrainRestore?: boolean;
	/** Put back only enough of the measured grain to hide banding. */
	filmGrainJustEnough?: boolean;
	/** Keep each table entry's seed on every frame, so the grain pattern stands still. */
	filmGrainStatic?: boolean;
	/** Synthetic grain deviation on a 0 to 255 scale, used when no measured table applies. 0 turns it off. */
	filmGrainSyntheticStrength?: number;
	filmGrainSyntheticSize?: FilmGrainSize;
	/** Synthetic chroma grain deviation on a 0 to 255 scale. */
	filmGrainSyntheticChroma?: number;
	/** Missing on settings saved before ISO grain, which gave a strength. */
	filmGrainSyntheticMode?: FilmGrainSyntheticMode;
	/** Camera sensor noise at this ISO, for the video's frame size. 0 turns it off. */
	filmGrainSyntheticIso?: number;
	videoEncode: VideoEncodeMode;
	audioEncode: AudioEncodeMode;
	subtitleProcessing: SubtitleProcessingMode;
	quality: EncoderQuality;
	finalSpeed: EncoderSpeed;
	audioBitrates: AudioChannelBitrates;
	crop: CropMode;
	cropLimit: number;
	denoise: DenoiseLevel;
	/** Which signal auto-denoise uses to classify scenes. See AutoDenoiseMetric. */
	autoDenoiseMetric: AutoDenoiseMetric;
	autoDenoiseThresholds: AutoDenoiseThresholds;
	/** Thresholds used when autoDenoiseMetric is "bitrate" (ratio vs. the file's own median bitrate, not 0-1). */
	autoDenoiseBitrateThresholds: AutoDenoiseThresholds;
	/** Filter parameters used for nlmeans at each level. */
	nlmeansParams: NlmeansLevelParams;
	/** Filter parameters used for gradfun at each level. */
	gradfunParams: GradfunLevelParams;
	/** Which denoiser to use. The av-denoise engines ignore denoiseBackend / gpuDevice / nlmeansParams. */
	denoiseEngine: DenoiseEngine;
	/** Preset, strengths and scales for the av-denoise engines. */
	avdParams: AvdParams;
	/** av-denoise --device spec ("default", "discrete:0", "integrated:0", ...). */
	avdDevice: string;
	/** Backend selection for nlmeans. "cpu" forces CPU; the others may fall back. */
	denoiseBackend: DenoiseBackend;
	/** Device id for vulkan/opencl backends (e.g. "0" / "0.0"); ignored for cpu. */
	gpuDevice: string;
	deband: DebandLevel;
	downscale: boolean;
	/** Measure HDR10+ metadata and write it into AV1 encodes of PQ sources, with the scenes of a Dolby Vision source. */
	hdr10Plus?: boolean;
	skipBoosting: boolean;
	noPhaseInv: boolean;
	dedupeSubtitles: boolean;
	keepBestAudioChannelsOnly: boolean;
	removeCommentaryAudio: boolean;
	/** Drop audio-description / visually-impaired tracks. */
	removeDescriptiveAudio: boolean;
	/** Drop karaoke / off-vocal / instrumental tracks. */
	removeKaraokeAudio: boolean;
	/** Drop "compatibility" downmix tracks. Default true (current behavior). */
	dropCompatibilityAudio: boolean;
	/** Dedupe winner preference: keep lossless+highest-bitrate, or smallest. */
	audioCodecPriority: AudioCodecPriority;
	/** Prefer uncensored audio when deduping/sorting. */
	preferUncensoredAudio: boolean;
	/** Enable audio dedupe at all. When false, every selected track is kept. */
	dedupeAudio: boolean;
	/** Ordered language priority for audio. "*" = the rest, alphabetically. */
	audioLanguagePriority: string[];
	/** Rewrite audio track names to the clean format. When false, names are blanked. */
	renameAudioTracks: boolean;
	/** Title-regex classification toggles. */
	detectCommentaryAudio: boolean;
	detectDescriptiveAudio: boolean;
	detectKaraokeAudio: boolean;
	audioLanguages: string[];
	subtitleLanguages: string[];
	/** Language detector mode for subtitle tracks. */
	subtitleLangDetect: SubtitleLangDetectMode;
	/** Minimum language-detector confidence (0–1) required to relabel a track. */
	subtitleLangDetectConfidence: number;
	/** Reclassify low-dialogue / sign-styled "full" tracks as Signs & Songs. */
	detectSignsSongs: boolean;
	/** Reclassify tracks with many SDH markers as SDH. */
	detectSDH: boolean;
	/** Reclassify the most honorific-dense English full track as Honorifics. */
	detectHonorifics: boolean;
	/** Official (BD/streaming) tracks above fansubs, or fansubs first. */
	subtitleSourcePriority: SubtitleSourcePriority;
	/** Within fansubs: alphabetical, or keep original source track order. */
	subtitleFansubTiebreak: SubtitleFansubTiebreak;
	/** Prefer text-based (SRT/ASS) or picture-based (PGS/VOBSUB) tracks. */
	subtitleFormatPriority: SubtitleFormatPriority;
	/** Drop all bitmap (PGS/VOBSUB) subtitle tracks. */
	dropPictureSubtitles: boolean;
	/** Dedupe ignores codec (1 per lang+type). When false, keep 1 text + 1 picture. */
	dedupeAcrossFormat: boolean;
	/** Rewrite subtitle track names to the clean format. When false, keep originals. */
	renameSubtitleTracks: boolean;
	/** Compress subtitle tracks with zlib in the final mux. Default off. */
	compressSubtitles: boolean;
	/** Only compress a track if zlib shrinks it by at least this percent (0 = "never larger"). */
	compressSubtitlesMinSavings: number;
	/** Ordered language priority for subtitles. "*" = the rest, alphabetically. */
	subtitleLanguagePriority: string[];
	/** Drop SDH subtitle tracks. */
	removeSDHSubtitles: boolean;
	/** Drop commentary subtitle tracks. */
	removeCommentarySubtitles: boolean;
	/** Drop forced / Signs & Songs subtitle tracks. */
	removeForcedSignsSongs: boolean;
	/** Drop storyboard subtitle tracks. */
	removeStoryboardSubtitles: boolean;
	/** Drop honorifics subtitle tracks. */
	removeHonorificsSubtitles: boolean;
	/** ASS sign-style line ratio to reclassify a full track as Signs & Songs. */
	signsSongsStyleRatio: number;
	/** Low-dialogue ratio vs the largest full track to reclassify as Signs & Songs. */
	signsSongsLineRatio: number;
	/** SDH-marker ratio to reclassify a track as SDH. */
	sdhRatioThreshold: number;
	/** Minimum dialogue line count before SDH reclassification applies. */
	sdhMinLines: number;
	/** Minimum honorific suffix count to flag a track as Honorifics. */
	honorificsMinCount: number;
	/** Multiplier vs the leanest track required to flag Honorifics. */
	honorificsRatio: number;
	/** Relabel JP→EN / bitmap fallback when no English full track is found. */
	assumeMislabeledTracks: boolean;
	/** Convert every SRT subtitle track to ASS styled per `subtitleStyle`. Default off. */
	convertSrtToAss: boolean;
	/** Replace the dialogue-style font of existing ASS tracks with `subtitleStyle.fontName`. Default off. */
	restyleAssFont: boolean;
	/** Detected track types `restyleAssFont` applies to. */
	assRestyleTargets: string[];
	/** Drop attachment fonts not referenced by any surviving ASS subtitle. Default off. */
	removeUnusedFonts: boolean;
	/** Selected font group (folder label under the user fonts dir). */
	fontGroup: string;
	// Subtitle translation
	/** Master switch: translate missing target languages via an LLM API. */
	translateSubtitles: boolean;
	/** API wire format. "openai" = any OpenAI-compatible endpoint (incl. local servers). Default "openai". */
	translateProvider: "openai" | "anthropic";
	/** API base URL, e.g. "http://localhost:11434/v1", "https://api.openai.com/v1", "https://api.anthropic.com". */
	translateBaseUrl: string;
	/** Model id, free text, e.g. "gpt-4o-mini", "qwen2.5:14b", "claude-sonnet-4-6". Must be an instruct/chat model. */
	translateModel: string;
	/** API key. Empty for local servers that don't require one. */
	translateApiKey: string;
	/** Languages to ensure exist (ISO-639-2 or -1, e.g. ["eng","deu","fra","slv"]). */
	translateTargetLanguages: string[];
	/** Dialogs sent to the model per request. Lower = better context, slower. */
	translateBatchSize: number;
	/** Also translate sign/song lines (keeps signs consistent in the target track). */
	translateSignsSongs: boolean;
	/** Per-request timeout, ms. */
	translateTimeoutMs: number;
	/** Max output tokens per request (cloud providers). Default 8192. */
	translateMaxTokens?: number;
	/** Model reasoning: "auto" turns it off for api.deepseek.com, "off" always sends thinking disabled, "on" leaves the provider default. */
	translateThinking?: "auto" | "off" | "on";
	/** Max concurrent in-flight llm requests (all languages + chunks). Default 1. */
	translateConcurrency?: number;
	/** Already translated lines sent with each request for continuity. 0 turns it off. Default 10. */
	translateContextLines?: number;
	/** Build and reuse per-series notes (characters, genders, forms of address, terms). Default true. */
	translateSeriesNotes?: boolean;
	/** Other subtitle languages in the same file sent as hints for gender and formality, matched by timing (e.g. ["rus"]). */
	translateReferenceLanguages?: string[];
	/** May translation overlap the video encode? "auto" overlaps only when llm is NOT on a loopback address. Default "auto". */
	translateDuringEncode?: "auto" | "always" | "never";
	/** Translate-only pipeline: source subtitle stream index, or "auto" = first full text track. */
	translateSourceTrack: number | "auto";
	/** Translate-only pipeline: pick the source by language and kind instead of index, so one choice fits a whole season. */
	translateSourceMatch?: TranslateSourceMatch;
	/**
	 * Ordered list of VapourSynth filter passes to apply during the prepare
	 * stage, before the FFmpeg -vf chain. Each entry references a preset by
	 * namespaced id ("stock:finedehalo" or "user:my_dehalo"), selects an
	 * active level, and stores per-level param values.
	 */
	vsFilters: VsFilterEntry[];
}

export interface AudioStreamInfo {
	index: number;
	channels: number;
	channelLayout: string;
	language?: string;
	title?: string;
	codec?: string;
	bitrate?: number;
	delayMs: number;
	isOriginal?: boolean;
}

export interface SubtitleStreamInfo {
	index: number;
	codec: string;
	/** BCP47 or ISO 639-2 */
	language?: string;
	title?: string;
	isForced?: boolean;
	isDefault?: boolean;
	isHearingImpaired?: boolean;
	isOriginal?: boolean;
	/** Set only when Signs & Songs was inferred from content rather than source metadata. */
	signsSongsDetected?: boolean;
}

export interface ProbeResult {
	filename: string;
	width: number;
	height: number;
	videoCodec: string;
	displayAspectRatio: string;
	sampleAspectRatio: string;
	duration: number;
	audioLayout: string;
	audioChannels: number;
	audioStreams: AudioStreamInfo[];
	subtitleStreams: SubtitleStreamInfo[];
	isHDR: boolean;
	hasHDR10Plus: boolean;
	hasDolbyVision: boolean;
	transferCharacteristics: string;
	colorPrimaries: string;
	matrixCoefficients: string;
	colorRange: string;
	maxCLL: string;
	maxFALL: string;
	masteringDisplay: string;
	masteringLuminance: string;
	videoStreamIndex: number;
	videoFrameRate: string;
	videoStreamFps: number;
	videoDisplayFps: number;
	videoLanguage: string;
	videoOriginalFlag: boolean;
	isFrameRateMismatch: boolean;
	priorSource: string | null;
	priorRabbitSettings: string | null;
	priorRabbitVersion: string | null;
	priorEncodedBy: string | null;
}

export interface JobStep {
	label: string;
	status: "pending" | "active" | "done" | "error";
	progress: number;
	detail?: string;
	startedAt?: number;
	finishedAt?: number;
}

export type JobKind = "encode" | "repair" | "hdr" | "grain";

/** What an HDR job does with HDR10+ metadata: keep it, remove it, measure it from the video, measure it with
 * the scenes of a Dolby Vision original, or take it from a file. */
export type HdrPlusAction = "keep" | "remove" | "measure" | "dolby-vision" | "file";
export type HdrStaticAction = "keep" | "remove" | "set";
export type HdrMasteringPrimaries = "p3" | "bt2020";

/** Changes to the HDR metadata of an AV1 MKV, made without re-encoding and written over the file. */
export interface HdrPlan {
	targetPath: string;
	hdr10Plus: HdrPlusAction;
	/** "dolby-vision": the Dolby Vision original. "file": an AV1 video that carries HDR10+ metadata. */
	sourcePath?: string;
	/** "file": an uploaded HDR10+ JSON file. */
	metadataPath?: string;
	removeDolbyVision: boolean;
	staticMetadata: HdrStaticAction;
	masteringPrimaries?: HdrMasteringPrimaries;
	masteringMaxNits?: number;
	masteringMinNits?: number;
	/** MaxCLL and MaxFALL from the HDR10+ metadata the file ends up with. */
	lightFromHdr10Plus?: boolean;
	maxCll?: number;
	maxFall?: number;
	/** Tag the video as BT.2020 PQ. Only allowed when it has no transfer tag. */
	fixColor: boolean;
	/** Part of a folder batch: files the plan does not fit are skipped instead of failing. */
	batch?: boolean;
	/** Folder batches: leave files that already carry HDR10+ metadata unchanged. */
	skipExisting?: boolean;
}

export interface HdrFinding {
	severity: "error" | "warning";
	code: string;
	message: string;
}

/** What retone found in a video. Only AV1 in MKV with one video track can be changed. */
export interface HdrInspection {
	path: string;
	codec: string;
	editable: boolean;
	/** Why the file cannot be changed. */
	reason?: string;
	formats: string[];
	width: number;
	height: number;
	frames: number | null;
	frameRate: number | null;
	colorPrimaries: number | null;
	transferCharacteristics: number | null;
	matrixCoefficients: number | null;
	colorDescription: string;
	isPq: boolean;
	/** No transfer tag, so the video may be tagged as PQ. */
	untagged: boolean;
	masteringDisplay: { primaries: string; maxNits: number; minNits: number } | null;
	contentLight: { maxCll: number; maxFall: number } | null;
	hdr10PlusFrames: number;
	hdr10PlusScenes: number | null;
	hdr10PlusMaxCll: number | null;
	hdr10PlusMaxFall: number | null;
	dolbyVision: boolean;
	findings: HdrFinding[];
}

/** What a film grain job writes: no grain, grain of a chosen strength, an uploaded table, or the grain the encode lost compared with its original. */
export type GrainAction = "remove" | "synthetic" | "table" | "measure";

/** A change to the film grain synthesis of an AV1 MKV, made without re-encoding and written over the file. */
export interface GrainPlan {
	targetPath: string;
	action: GrainAction;
	/** "synthetic": deviation on the 0 to 255 scale, or the sensor noise at `iso`. */
	strength?: number;
	iso?: number;
	size?: FilmGrainSize;
	chroma?: number;
	/** "table": an uploaded film grain table. */
	tablePath?: string;
	/** "measure": the original with grain that the video was encoded from. */
	sourcePath?: string;
	/** "measure": put back only enough of the measured grain to hide banding. */
	justEnough?: boolean;
	/** "measure": also measure chroma grain. Off by default, since colour detail the encode lost counts as chroma grain. */
	measureChroma?: boolean;
	sampling?: FilmGrainSampling;
	range?: FilmGrainRange;
	/** Keep each table entry's seed on every frame, so the grain pattern stands still. */
	staticGrain?: boolean;
	/** Part of a folder batch: files the plan does not fit are skipped instead of failing. */
	batch?: boolean;
	/** Folder batches: leave files that already have film grain unchanged. */
	skipExisting?: boolean;
}

/** How far a film grain inspection is. `percent` is null while regrain reads the video, which it cannot measure. */
export interface GrainInspectProgress {
	stage: "video" | "table" | "measure";
	percent: number | null;
	detail: string;
}

/** A film grain inspection running on the server, which the Film Grain tool polls. */
export interface GrainInspectRun {
	id: string;
	path: string;
	status: "running" | "done" | "error" | "cancelled";
	startedAt: number;
	progress: GrainInspectProgress;
	result?: GrainInspection;
	error?: string;
}

/** What regrain found in a video. Only AV1 in MKV with one video track can be changed. */
export interface GrainInspection {
	path: string;
	codec: string;
	editable: boolean;
	/** Why the file cannot be changed. */
	reason?: string;
	width: number;
	height: number;
	frames: number | null;
	frameRate: number | null;
	/** Table entries, one for every run of frames with the same grain. 0 means no grain. */
	entries: number;
	/** Average and strongest luma grain deviation on the 0 to 255 scale, null without grain. */
	luma: number | null;
	lumaMax: number | null;
	/** Average chroma grain deviation of Cb and Cr. */
	chroma: number | null;
	findings: HdrFinding[];
}

export type RepairTrackSource = "target" | "source";
export type RepairTrackMode = "copy" | "rabbit";
export type RepairCompression = "preserve" | "none" | "zlib" | "auto";

/** One subtitle track selected for a stream-copy repair/remux job. */
export interface RepairSubtitleTrackPlan {
	source: RepairTrackSource;
	trackId: number;
	mode: RepairTrackMode;
	order: number;
	title: string;
	language: string;
	compression: RepairCompression;
	isDefault: boolean;
	isForced: boolean;
	isEnabled: boolean;
	isHearingImpaired: boolean;
	isOriginal: boolean;
	isCommentary: boolean;
}

export interface RepairPairSuggestion {
	targetPath: string;
	targetName: string;
	sourcePath: string;
	sourceName: string;
	method: "episode" | "order" | "none";
}

export interface RepairBatchPairing {
	targetDir: string;
	sourceDir: string;
	pairs: RepairPairSuggestion[];
	unmatchedSources: string[];
}

export interface RepairPlan {
	targetPath: string;
	sourcePath?: string;
	replaceTarget: boolean;
	replaceFromSource?: boolean;
	tracks: RepairSubtitleTrackPlan[];
}

export interface RepairSubtitleTrack {
	id: number;
	codec: string;
	codecId: string;
	language: string;
	title: string;
	isDefault: boolean;
	isForced: boolean;
	isEnabled: boolean;
	isHearingImpaired: boolean;
	isOriginal: boolean;
	isCommentary: boolean;
	canRabbitProcess: boolean;
	currentCompression: "none" | "zlib";
}

export interface RepairInspectionFile {
	path: string;
	filename: string;
	durationSeconds: number;
	subtitles: RepairSubtitleTrack[];
}

export interface RepairInspection {
	target: RepairInspectionFile;
	source?: RepairInspectionFile;
}

export interface RepairAuditTrack {
	id: number;
	type: "audio" | "subtitles";
	codec: string;
	language: string;
	title: string;
	isDefault: boolean;
	isForced: boolean;
	isEnabled: boolean;
	isHearingImpaired: boolean;
	isVisualImpaired: boolean;
	isTextDescriptions: boolean;
	isOriginal: boolean;
	isCommentary: boolean;
	compression: "none" | "zlib";
}

export interface RepairAuditFile {
	path: string;
	/** Original input for this encoded file when the audit came from completed jobs. */
	sourcePath?: string;
	filename: string;
	group: number;
	groupLabel: string;
	differences: string[];
	tracks: RepairAuditTrack[];
}

export interface RepairAuditGroup {
	group: number;
	label: string;
	count: number;
	representativePath: string;
}

export interface RepairFolderAudit {
	path?: string;
	files: RepairAuditFile[];
	groups: RepairAuditGroup[];
}

export type RepairAuditSubtitleMetadata = Pick<
	RepairSubtitleTrackPlan,
	"title" | "language" | "isDefault" | "isForced" | "isEnabled" | "isHearingImpaired" | "isOriginal" | "isCommentary"
>;

export interface RepairAuditGroupEdit {
	paths: string[];
	expectedTracks: RepairAuditTrack[];
	subtitles: RepairAuditSubtitleMetadata[];
	replaceTarget: boolean;
}

export interface Job {
	kind?: JobKind;
	id: string;
	filename: string;
	inputPath: string;
	/** Aligned grainy original for an externally denoised input. */
	originalSourcePath?: string;
	/** Generate a measured FGS table as a step of the encode for this mapped input. */
	autoFilmGrain?: boolean;
	relativePath: string;
	status: JobStatus;
	progress: number;
	queueOrder: number;
	currentStage: string;
	steps: JobStep[];
	settings: JobSettings;
	probe?: ProbeResult;
	outputFilename?: string;
	error?: string;
	startedAt?: number;
	finishedAt?: number;
	estimatedVideoSize?: string;
	estimatedFinalSize?: string;
	encodedVideoSize?: string;
	encodedFileSize?: string;
	replaceSource: boolean;
	repairPlan?: RepairPlan;
	hdrPlan?: HdrPlan;
	grainPlan?: GrainPlan;
	autoDenoisePlan?: AutoDenoiseAppliedRange[] | null;
}

export interface LanguageDetector {
	version: string | null;
}

export interface AppConfig {
	inputDir: string;
	outputDir: string;
	tempDir: string;
	fontsStockDir: string;
	fontsUserDir: string;
	port: number;
	defaults: JobSettings;
	organization: string;
	libraryDirs: string[];
	recycleBinDir: string;
	systemFontDirs: string[];
	languageDetector: LanguageDetector;
	regrain: { version: string | null };
	retone: { version: string | null };
}

export interface SubtitlePreviewTrack {
	index: number;
	codec: string;
	language: string;
	/** Country flag emoji derived from language */
	flag: string;
	title: string;
	trackName: string;
	trackType: string;
	isDefault: boolean;
	isForced: boolean;
	isHearingImpaired: boolean;
	isCommentary: boolean;
	isOriginal: boolean;
	isText: boolean;
	isTranslated: boolean;
}

export interface SubtitlePreviewResult {
	source: SubtitlePreviewTrack[];
	output: SubtitlePreviewTrack[];
}

/**
 * ASS V4+ "Default" style written when converting SRT->ASS, and the font used
 * when restyling existing ASS dialogue. Pixel values are in PlayResY=1080
 * space; libass rescales them to the real frame, so they hold "at 1080p"
 * regardless of the encoded resolution.
 */
export interface SubtitleStyle {
	/** Font family / face name (also the attachment injected into the MKV). */
	fontName: string;
	/** Font size in 1080p px. */
	fontSize: number;
	/** Primary fill colour, ASS &HAABBGGRR (AA: 00=opaque, FF=transparent). */
	primaryColour: string;
	/** Outline / border colour. */
	outlineColour: string;
	/** Shadow (back) colour - alpha controls how light the shadow reads. */
	backColour: string;
	/** Outline thickness in 1080p px. */
	outline: number;
	/** Shadow depth in 1080p px. */
	shadow: number;
	/**
	 * ASS numpad alignment (2 = bottom-centre). When restyling existing ASS only
	 * the horizontal column is applied (each style keeps its own top/bottom row).
	 */
	alignment: number;
	/** Vertical (bottom) margin in 1080p px. */
	marginV: number;
	/** Left margin in 1080p px. */
	marginL: number;
	/** Right margin in 1080p px. */
	marginR: number;
	/** Bold flag. Off by default - weight comes from the face name (e.g. SemiBold). */
	bold: boolean;
	fontAxes: Record<string, number>;
}

export interface AudioPreviewTrack {
	index: number;
	codec: string;
	language: string;
	flag: string;
	title: string;
	trackType: AudioTrackType; // "main" | "commentary" | "descriptive"
	channels: number;
	channelLayout: string;
	bitrate?: number; // source: input bitrate from probe (raw)
	outputBitrate?: number; // output: predicted Opus bitrate in kbps
	isDefault: boolean;
	isOriginal: boolean;
}

export interface AudioPreviewResult {
	source: AudioPreviewTrack[];
	output: AudioPreviewTrack[];
}

export interface BitrateSamplePoint {
	t: number;
	kbps: number;
}

export interface NoiseSamplePoint {
	t: number;
	y: number;
}

export interface NoiseScenePoint {
	start: number;
	end: number;
	/** Classifier value for the scene: peak bitplane-noise reading, or bitrate ratio vs. file median (see AutoDenoiseMetric). */
	value: number;
}

export interface BitrateNoiseData {
	samples: NoiseSamplePoint[];
	scenes: NoiseScenePoint[];
	cuts: number[];
}

/**
 * Response for GET /api/jobs/:id/bitrate-analysis.
 *   - "source"  : job's source file still exists. Includes noise samples for
 *                 auto-denoise threshold calibration.
 *   - "encoded" : job is done and its source was cleaned up; only the final
 *                 output's bitrate is available.
 */
export interface BitrateAnalysisResult {
	mode: "source" | "encoded";
	durationSec: number;
	bitrate: BitrateSamplePoint[];
	noise: BitrateNoiseData | null;
	/** Which classifier metric `noise`/`thresholds` reflect (mode "source" only). */
	metric?: AutoDenoiseMetric;
	thresholds?: AutoDenoiseThresholds;
	appliedPlan?: AutoDenoiseAppliedRange[] | null;
}

export interface PreviewSampleVsFrame {
	/** Zero-based index in the active VS chain. */
	index: number;
	/** Namespaced preset id (e.g. "stock:f3k_deband"). */
	presetId: string;
	/** Bare preset id, useful for filenames or download labels. */
	bareId: string;
	/** Human-readable label like "F3K Deband (heavy)". */
	label: string;
}

export interface PreviewSamplePrepareFrame {
	/** Which prepare-filter step this snapshot came from. */
	kind: "crop" | "downscale" | "deband" | "denoise";
	/** Human-readable label like "Debanding (medium)" or "Auto denoise (GPU/Vulkan)". */
	label: string;
}

/** Extra comparison video picked by the user (e.g. the original source of an already denoised input). */
export interface PreviewReference {
	index: number;
	path: string;
	/** File name, shown next to the label. */
	name: string;
	/** Short user-facing label like "Original". */
	label: string;
	/** Set when the file is unlikely to line up frame for frame with the job source. */
	warning?: string;
}

export interface PreviewSample {
	index: number;
	timestampSec: number;
	windowSeconds: number;
	encodedSizeBytes: number;
	encodedSizeHuman: string;
	projectedTotalBytes: number;
	projectedTotalHuman: string;
	encodedBitrateKbps: number;
	vsFrames: PreviewSampleVsFrame[];
	prepareFrames: PreviewSamplePrepareFrame[];
	/** Indices into PreviewState.references whose still was captured for this sample. */
	refFrames: number[];
}

export interface PreviewState {
	jobId: string;
	status: "idle" | "running" | "done" | "error" | "cancelled";
	progress: number;
	currentDetail: string;
	samples: PreviewSample[];
	references: PreviewReference[];
	error?: string;
	startedAt?: number;
	finishedAt?: number;
	settingsFingerprint: string;
	sampleCount: number;
	windowSeconds: number;
}

export type VsParamType = "float" | "int" | "bool" | "enum";
export type VsParamValue = number | boolean | string;
export type VsPresetSource = "stock" | "user";

export interface VsParamSpec {
	key: string;
	label: string;
	type: VsParamType;
	min?: number;
	max?: number;
	step?: number;
	enum?: string[];
	help?: string;
	/** Per-level default values. Keys must match the preset's `levels` array. */
	defaults: Record<string, VsParamValue>;
}

export interface VsPresetManifest {
	/** Namespaced id: "stock:finedehalo" or "user:my_dehalo". */
	id: string;
	/** Bare id from the manifest file (without source prefix). */
	bareId: string;
	name: string;
	description: string;
	category?: string;
	supports: { bitDepth: number[]; hdr: boolean };
	/** Ordered list of level names this preset offers (e.g. ["light","medium","heavy"]). */
	levels: string[];
	params: VsParamSpec[];
	source: VsPresetSource;
	/** Absolute path to the .vpy script. */
	scriptPath: string;
	/** Absolute path to the .json manifest. */
	manifestPath: string;
}

/**
 * One entry in a job's VapourSynth filter chain.
 *
 *   presetId : namespaced id of the preset to run.
 *   level    : "off" disables this entry without removing it; otherwise must
 *              be one of the preset's declared levels.
 *   params   : per-level override map. Pre-populated from manifest defaults
 *              when the entry is created; users can edit individual values
 *              in Advanced settings without losing other levels' tweaks.
 *              Shape: { [level]: { [paramKey]: value } }
 */
export interface VsFilterEntry {
	presetId: string;
	level: string;
	params: Record<string, Record<string, VsParamValue>>;
}
