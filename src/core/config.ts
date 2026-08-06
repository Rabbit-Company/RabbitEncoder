import { DEFAULT_AUTO_THRESHOLDS } from "../video/auto-denoise";
import { DEFAULT_NLMEANS_PARAMS, DEFAULT_GRADFUN_PARAMS } from "../video/filters";
import { Logger } from "./logger";
import { run } from "./process";
import type { AppConfig, AudioChannelBitrates, JobSettings } from "./types";

const DEFAULT_BITRATES: AudioChannelBitrates = {
	mono: 64,
	stereo: 128,
	"2.1": 160,
	"3.0": 160,
	"3.1": 192,
	"4.0": 192,
	"4.1": 224,
	"5.0": 224,
	"5.1": 256,
	"6.0": 256,
	"6.1": 320,
	"7.0": 320,
	"7.1": 384,
	"7.1.4": 512,
};

const DEFAULT_JOB_SETTINGS: JobSettings = {
	encoder: "svt-av1-essential",
	manualCrf: 24,
	manualPreset: 4,
	customEncoderParams: "",
	videoEncode: "av1",
	audioEncode: "opus",
	subtitleProcessing: "full",
	quality: "medium",
	finalSpeed: "slow",
	crop: "off",
	cropLimit: 0.1,
	denoise: "off",
	autoDenoiseThresholds: DEFAULT_AUTO_THRESHOLDS,
	nlmeansParams: DEFAULT_NLMEANS_PARAMS,
	gradfunParams: DEFAULT_GRADFUN_PARAMS,
	denoiseBackend: "auto",
	gpuDevice: "0.0",
	deband: "off",
	downscale: false,
	skipBoosting: false,
	noPhaseInv: false,
	dedupeSubtitles: false,
	keepBestAudioChannelsOnly: false,
	removeCommentaryAudio: false,
	audioLanguages: [],
	removeDescriptiveAudio: false,
	removeKaraokeAudio: false,
	dropCompatibilityAudio: true,
	audioCodecPriority: "lossless-first",
	preferUncensoredAudio: true,
	dedupeAudio: true,
	audioLanguagePriority: ["jpn", "eng", "*"],
	renameAudioTracks: false,
	detectCommentaryAudio: true,
	detectDescriptiveAudio: true,
	detectKaraokeAudio: true,
	subtitleLanguagePriority: ["eng", "jpn", "*"],
	subtitleLanguages: [],
	subtitleLangDetect: "enabled",
	subtitleLangDetectConfidence: 0.05,
	detectSignsSongs: true,
	detectSDH: true,
	detectHonorifics: true,
	subtitleSourcePriority: "official-first",
	subtitleFansubTiebreak: "alphabetical",
	subtitleFormatPriority: "text-first",
	dropPictureSubtitles: false,
	dedupeAcrossFormat: true,
	renameSubtitleTracks: true,
	compressSubtitles: false,
	compressSubtitlesMinSavings: 10,
	removeSDHSubtitles: false,
	removeCommentarySubtitles: false,
	removeForcedSignsSongs: false,
	removeStoryboardSubtitles: false,
	removeHonorificsSubtitles: false,
	signsSongsStyleRatio: 0.8,
	signsSongsLineRatio: 0.1,
	sdhRatioThreshold: 0.2,
	sdhMinLines: 10,
	honorificsMinCount: 5,
	honorificsRatio: 3,
	assumeMislabeledTracks: true,
	convertSrtToAss: false,
	restyleAssFont: false,
	assRestyleTargets: ["full", "honorifics", "forced", "sdh", "commentary"],
	removeUnusedFonts: false,
	fontGroup: "Noto Sans",
	audioBitrates: DEFAULT_BITRATES,
	translateSubtitles: false,
	translateProvider: "openai",
	translateBaseUrl: "http://localhost:11434/v1",
	translateModel: "gemma3:12b",
	translateApiKey: "",
	translateTargetLanguages: [],
	translateBatchSize: 40,
	translateSignsSongs: true,
	translateTimeoutMs: 300_000,
	translateMaxTokens: 8192,
	translateConcurrency: 1,
	translateSourceTrack: "auto",
	vsFilters: [],
};

export function getDefaultJobSettings(): JobSettings {
	return structuredClone(DEFAULT_JOB_SETTINGS);
}

export async function getLanguageDetectorVersion(): Promise<string | null> {
	const res = await run(["language-detector", "--version"]);
	if (res.code !== 0) {
		Logger.error(`[subtitle] language-detector error: ${res.stderr || res.stdout}`);
		return null;
	}
	return res.stdout.replace("Language Detector", "").trim();
}

export async function loadConfig(): Promise<AppConfig> {
	const libraryDirs = (process.env.LIBRARY_DIRS || "")
		.split(",")
		.map((d) => d.trim())
		.filter((d) => d.length > 0);

	const systemFontDirs = (process.env.SYSTEM_FONTS_DIRS || "/system-fonts")
		.split(",")
		.map((d) => d.trim())
		.filter((d) => d.length > 0);

	return {
		inputDir: process.env.INPUT_DIR || "/data/input",
		outputDir: process.env.OUTPUT_DIR || "/data/output",
		tempDir: process.env.TEMP_DIR || "/data/temp",
		fontsStockDir: process.env.FONTS_STOCK_DIR || "/app/fonts",
		fontsUserDir: process.env.FONTS_USER_DIR || "/config/fonts",
		port: parseInt(process.env.PORT || "3000"),
		organization: process.env.ORGANIZATION || "RabbitCompany",
		libraryDirs,
		systemFontDirs,
		languageDetector: { version: await getLanguageDetectorVersion() },
		defaults: getDefaultJobSettings(),
	};
}
