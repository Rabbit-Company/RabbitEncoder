export type EncoderId = "svt-av1-essential" | "svt-av1-hdr" | "svt-av1-5fish";
export type EncoderQuality = "low" | "medium" | "high";
export type EncoderSpeed = "slower" | "slow" | "medium" | "fast" | "faster";
export type DenoiseLevel = "off" | "light" | "medium" | "heavy" | "auto";
export type DebandLevel = "off" | "light" | "medium" | "heavy";

export type EncodeMode = "full" | "preview";
export type VideoEncodeMode = "av1" | "off";
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
	manualCrf: number;
	manualPreset: number;
	customEncoderParams: string;
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
	/** Backend selection for nlmeans. "cpu" forces CPU; the others may fall back. */
	denoiseBackend: DenoiseBackend;
	/** Device id for vulkan/opencl backends (e.g. "0" / "0.0"); ignored for cpu. */
	gpuDevice: string;
	deband: DebandLevel;
	downscale: boolean;
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
	/** Max concurrent in-flight llm requests (all languages + chunks). Default 1. */
	translateConcurrency?: number;
	/** May translation overlap the video encode? "auto" overlaps only when llm is NOT on a loopback address. Default "auto". */
	translateDuringEncode?: "auto" | "always" | "never";
	/** Translate-only pipeline: source subtitle stream index, or "auto" = first full text track. */
	translateSourceTrack: number | "auto";
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

export interface Job {
	id: string;
	filename: string;
	inputPath: string;
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
	systemFontDirs: string[];
	languageDetector: LanguageDetector;
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
	/** ASS numpad alignment (2 = bottom-centre). */
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
	/** Classifier value for the scene: peak bitplane-noise reading, or bitrate ratio vs. file median — see AutoDenoiseMetric. */
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
}

export interface PreviewState {
	jobId: string;
	status: "idle" | "running" | "done" | "error" | "cancelled";
	progress: number;
	currentDetail: string;
	samples: PreviewSample[];
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
