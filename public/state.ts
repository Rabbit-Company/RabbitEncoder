import type { JobSettings, VsPresetManifest } from "./types";
import type { AdvancedTarget, AvdDevice, GpuDevice, LibraryDir, LibraryNode, PreviewSampleCard } from "./ui/models";

export const appState = {
	queuePaused: false,
	defaults: null as JobSettings | null,
	currentEditJobId: null as string | null,
	currentAdvancedTarget: null as AdvancedTarget | null,
	authToken: localStorage.getItem("authToken") || "",
	pollTimer: null as ReturnType<typeof setInterval> | null,
	systemPollTimer: null as ReturnType<typeof setInterval> | null,
	benchmarkPollTimer: null as ReturnType<typeof setInterval> | null,
	vsPresets: null as VsPresetManifest[] | null,

	librarySearchScope: null as string | null,
	librarySearchQuery: "",
	expandedFolders: new Set<string>(),
	libraryDirs: [] as LibraryDir[],
	libraryNodes: new Map<string, LibraryNode>(),
	libraryQueuedPaths: new Set<string>(),

	previewPollTimer: null as ReturnType<typeof setInterval> | null,
	currentPreviewJobId: null as string | null,
	currentPreviewSettingsFingerprint: "",
	previewBlobCache: new Map<string, string>(),
	currentPreviewFullscreenCard: null as PreviewSampleCard | null,

	openClDevices: null as GpuDevice[] | null,
	vulkanDevices: null as GpuDevice[] | null,
	avdDevices: null as AvdDevice[] | null,
	lastJobsJson: "",
};
