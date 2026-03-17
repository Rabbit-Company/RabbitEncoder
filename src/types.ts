export type EncoderQuality = "low" | "medium" | "high";
export type EncoderSpeed = "slower" | "slow" | "medium" | "fast" | "faster";

export type JobStatus = "queued" | "probing" | "encoding_video" | "encoding_audio" | "muxing" | "done" | "error";

export interface AudioChannelBitrates {
	mono: number;
	stereo: number;
	"2.1": number;
	"5.1": number;
	"6.1": number;
	"7.1": number;
	"7.1.4": number;
}

export interface JobSettings {
	quality: EncoderQuality;
	finalSpeed: EncoderSpeed;
	audioBitrates: AudioChannelBitrates;
}

export interface AudioStreamInfo {
	index: number;
	channels: number;
	channelLayout: string;
	language?: string;
	title?: string;
}

export interface ProbeResult {
	filename: string;
	width: number;
	height: number;
	duration: number;
	audioLayout: string;
	audioChannels: number;
	audioStreams: AudioStreamInfo[];
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
}

export interface JobStep {
	label: string;
	status: "pending" | "active" | "done" | "error";
	progress: number;
	detail?: string;
}

export interface Job {
	id: string;
	filename: string;
	inputPath: string;
	status: JobStatus;
	progress: number;
	currentStage: string;
	steps: JobStep[];
	settings: JobSettings;
	probe?: ProbeResult;
	outputFilename?: string;
	error?: string;
	startedAt?: number;
	finishedAt?: number;
	encodedVideoSize?: string;
	encodedFileSize?: string;
}

export interface AppConfig {
	inputDir: string;
	outputDir: string;
	tempDir: string;
	port: number;
	defaults: JobSettings;
	organization: string;
	contact: string;
}
