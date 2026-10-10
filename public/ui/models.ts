import type { Job, JobSettings } from "../types";

export type AdvancedTarget = "default" | "job";
export type PipelinePreset = "full" | "prepare" | "translate" | "custom";
export type MoveDirection = "up" | "down";
export type PreviewArtifactKind = "source" | "encode" | "clip" | "source-clip" | `vs:${number}` | `pf:${string}`;
export type FetchOptions = RequestInit & { headers?: HeadersInit };

export interface LibraryDir {
	path: string;
	name: string;
}

export interface LibraryEntry {
	path: string;
	name: string;
	type: "directory" | "file";
	encoded?: boolean;
	queued?: boolean;
	videoCount?: number;
	encodedCount?: number;
	size?: number;
}

export interface LibraryNode extends LibraryEntry {
	depth: number;
	parentPath: string | null;
	expanded: boolean;
	checked: boolean;
	children?: string[] | null;
	loading: boolean;
	encoded: boolean;
	queued: boolean;
	videoCount: number;
	encodedCount: number;
	size: number;
}

export interface FolderTreeNode {
	name: string;
	fullPath: string;
	children: Map<string, FolderTreeNode>;
	jobs: Job[];
}

export interface FolderStats {
	total: number;
	done: number;
	encoding: number;
	queued: number;
	error: number;
}

export interface FolderTimeEstimate {
	totalElapsed: number;
	estimatedRemaining: number;
	estimatedTotal: number;
	avgPerEpisode: number | null;
	doneCount: number;
	remainingCount: number;
}

export interface GpuDevice {
	id: string;
	deviceName: string;
}

export interface AvdDevice {
	id: string;
	backends: string[];
}

export type BenchmarkMode = "cpu" | "opencl" | "vulkan" | "avd-nlmeans" | "avd-nlmeans-hq" | "avd-nl4d";

export interface BenchmarkResult {
	mode: BenchmarkMode;
	level: "light" | "medium" | "heavy";
	fps?: number;
	speed?: string;
	error?: string;
}

export interface BenchmarkState {
	status: "idle" | "running" | "completed" | "failed" | "cancelled";
	results: BenchmarkResult[];
	openclAvailable?: boolean;
	vulkanAvailable?: boolean;
	avdAvailable?: boolean | null;
	avdDevice?: string | null;
	/** Engines included in the current / last run. */
	modes?: BenchmarkMode[];
	cpuName?: string;
	gpuName?: string;
	gpuDevice?: string;
	currentLabel?: string;
	currentStep: number;
	totalSteps: number;
	startedAt?: number;
	completedAt?: number;
	size: string;
	duration: number;
	rate: number;
	error?: string;
}

export interface SystemStats {
	cpuName?: string;
	cpuCount: number;
	cpuUsagePercent?: number | null;
	loadAvg?: number[];
	mem?: { usedPercent: number; usedBytes: number; totalBytes: number };
	disk?: { usedPercent: number; availableBytes: number; totalBytes: number; path: string };
	gpu?: { utilizationPercent?: number | null; name?: string; memUsedBytes?: number; memTotalBytes?: number };
	net?: { rxBytesPerSec?: number | null; txBytesPerSec?: number | null };
}

export interface PreviewSampleView {
	id: PreviewArtifactKind;
	label: string;
	role: "source" | "vs" | "prepare" | "encode";
}

export type PreviewSampleCard = HTMLDivElement & {
	_views?: PreviewSampleView[];
	_viewIdx?: number;
};

export interface SettingsCodePanelElement extends HTMLElement {
	_codeTimer?: ReturnType<typeof setInterval> | null;
}

export interface SettingsCodePanelOptions {
	getSettings(): JobSettings | null | undefined;
	onImport(code: string): Promise<JobSettings>;
	onApplied(settings: JobSettings): void;
}

declare global {
	interface Window {
		_tempDefaults?: JobSettings | null;
		_tempJobSettings?: JobSettings | null;
	}
}

export {};
