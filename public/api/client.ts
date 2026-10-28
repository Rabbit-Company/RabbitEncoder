import Blake2b from "@rabbit-company/blake2b";
import type {
	AutoDenoiseMetric,
	AutoDenoiseThresholds,
	BitrateAnalysisResult,
	FilmGrainSampling,
	FilmGrainRun,
	FontAxis,
	GroupStyleConfig,
	HdrInspection,
	GrainInspectRun,
	GrainPlan,
	HdrPlan,
	VersionsReport,
	Job,
	JobSettings,
	PreviewState,
	RepairFolderAudit,
	RepairAuditGroupEdit,
	RepairBatchPairing,
	RepairInspection,
	RepairPlan,
	StyleAppearance,
	SubtitleSearchIdentity,
	SubtitleSearchResult,
	VsFilterEntry,
	VsPresetManifest,
} from "../types";
import type { AvdDevice, BenchmarkMode, BenchmarkState, FetchOptions, GpuDevice, LibraryEntry, SystemStats } from "../ui/models";
import { API } from "../config/api-base";
import { startPolling, stopPolling } from "../features/polling";
import { buttonById, byId, inputById } from "../shared/dom";
import { appState } from "../state";

export function hashPassword(password: string): string {
	return Blake2b.hash(`rabbitencoder-${password}`);
}

export function showLogin(message: string): void {
	const modal = byId("login-modal");
	const error = byId("login-error");
	const input = inputById("login-password");
	error.textContent = message || "";
	input.value = "";
	modal.style.display = "";
	input.focus();
}

export function hideLogin() {
	byId("login-modal").style.display = "none";
}

export async function handleLogin() {
	const input = inputById("login-password");
	const password = input.value.trim();
	if (!password) return;

	const btn = buttonById("login-submit-btn");
	btn.disabled = true;
	btn.textContent = "Verifying...";

	appState.authToken = hashPassword(password);

	try {
		const res = await fetch(`${API}/api/config`, {
			headers: { Authorization: `Bearer ${appState.authToken}` },
		});

		if (res.status === 401 || res.status === 403) {
			byId("login-error").textContent = "Invalid password";
			input.value = "";
			input.focus();
			return;
		}

		if (!res.ok) {
			byId("login-error").textContent = `Server error (${res.status})`;
			return;
		}

		localStorage.setItem("authToken", appState.authToken);
		hideLogin();
		appState.defaults = await res.json();
		startPolling();
	} catch (e) {
		byId("login-error").textContent = "Cannot reach server";
	} finally {
		btn.disabled = false;
		btn.textContent = "Login";
	}
}

export function logout() {
	appState.authToken = "";
	localStorage.removeItem("authToken");
	appState.defaults = null;
	appState.lastJobsJson = "";
	stopPolling();
	byId("jobs-list").style.display = "none";
	byId("empty-state").style.display = "";
	showLogin("");
}

export async function authFetch(url: string, opts: FetchOptions = {}): Promise<Response> {
	const headers = new Headers(opts.headers);
	if (appState.authToken) {
		headers.set("Authorization", `Bearer ${appState.authToken}`);
	}
	const res = await fetch(url, { ...opts, headers });

	if (res.status === 401 || res.status === 403) {
		appState.authToken = "";
		localStorage.removeItem("authToken");
		stopPolling();
		showLogin("Session expired, please log in again");
		throw new Error("Unauthorized");
	}

	return res;
}

export async function fetchOpenClDevices(): Promise<GpuDevice[]> {
	if (appState.openClDevices !== null) return appState.openClDevices;
	try {
		const res = await authFetch(`${API}/api/opencl-devices`);
		const data = await res.json();
		appState.openClDevices = data.devices || [];
	} catch {
		appState.openClDevices = [];
	}
	return appState.openClDevices ?? [];
}

export async function fetchVulkanDevices(): Promise<GpuDevice[]> {
	if (appState.vulkanDevices !== null) return appState.vulkanDevices;
	try {
		const res = await authFetch(`${API}/api/vulkan-devices`);
		const data = await res.json();
		appState.vulkanDevices = data.devices || [];
	} catch {
		appState.vulkanDevices = [];
	}
	return appState.vulkanDevices ?? [];
}

export async function fetchJobs(): Promise<Job[]> {
	const res = await authFetch(`${API}/api/jobs`);
	return res.json();
}

/** Extract one subtitle track from an MKV and save it through the browser. */
/** Save a file response through the browser, named by its Content-Disposition header. */
export async function saveResponse(res: Response, fallbackName: string): Promise<void> {
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(data?.error || "Download failed");
	}
	const encoded = /filename\*=UTF-8''([^;]+)/i.exec(res.headers.get("Content-Disposition") || "")?.[1];
	const url = URL.createObjectURL(await res.blob());
	const link = document.createElement("a");
	link.href = url;
	link.download = encoded ? decodeURIComponent(encoded) : fallbackName;
	document.body.appendChild(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Extract one subtitle track from an MKV and save it through the browser. */
export async function downloadSubtitleTrack(path: string, trackId: number): Promise<void> {
	const res = await authFetch(`${API}/api/repair/subtitle-download`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ path, trackId }),
	});
	await saveResponse(res, `track-${trackId}.txt`);
}

export async function fetchRepairInspection(options: { jobId?: string; targetPath?: string; sourcePath?: string }): Promise<RepairInspection> {
	const query = new URLSearchParams();
	if (options.jobId) query.set("jobId", options.jobId);
	if (options.targetPath) query.set("targetPath", options.targetPath);
	if (options.sourcePath) query.set("sourcePath", options.sourcePath);
	const response = await authFetch(`${API}/api/repair/inspect?${query}`);
	const data = await response.json();
	if (!response.ok) throw new Error(data?.error || "Could not inspect repair files");
	return data;
}

export async function fetchRepairReplacePlan(options: { targetPath: string; sourcePath: string; replaceTarget: boolean }): Promise<RepairPlan> {
	const response = await authFetch(`${API}/api/repair/replace-plan`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(options),
	});
	const data = await response.json();
	if (!response.ok) throw new Error(data?.error || "Could not build a replacement plan");
	return data;
}

export async function fetchRepairBatchPairing(options: { targetDir: string; sourceDir: string }): Promise<RepairBatchPairing> {
	const response = await authFetch(`${API}/api/repair/batch/pair`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(options),
	});
	const data = await response.json();
	if (!response.ok) throw new Error(data?.error || "Could not pair the two folders");
	return data;
}

export async function createRepairBatchJobs(options: {
	pairs: { targetPath: string; sourcePath: string }[];
	replaceTarget: boolean;
}): Promise<{ jobIds: string[] }> {
	const response = await authFetch(`${API}/api/repair/batch/jobs`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(options),
	});
	const data = await response.json();
	if (!response.ok) throw new Error(data?.error || "Could not queue the replacements");
	return data;
}

export async function fetchRepairFolderAudit(options: { path?: string; jobIds?: string[] }): Promise<RepairFolderAudit> {
	const response = await authFetch(`${API}/api/repair/audit`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(options),
	});
	const data = await response.json();
	if (!response.ok) throw new Error(data?.error || "Could not audit MKV folder");
	return data;
}

export async function createRepairAuditGroupJobs(edit: RepairAuditGroupEdit): Promise<{ jobIds: string[] }> {
	const response = await authFetch(`${API}/api/repair/audit/group`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(edit),
	});
	const data = await response.json();
	if (!response.ok) throw new Error(data?.error || "Could not queue group edits");
	return data;
}

export async function fetchRepairRoots(): Promise<{ path: string; name: string }[]> {
	const response = await authFetch(`${API}/api/repair/roots`);
	const data = await response.json();
	if (!response.ok) throw new Error(data?.error || "Could not load media folders");
	return data.roots || [];
}

export async function fetchRepairBrowse(path: string, allMedia = false): Promise<LibraryEntry[]> {
	const query = new URLSearchParams({ path });
	if (allMedia) query.set("allMedia", "1");
	const response = await authFetch(`${API}/api/repair/browse?${query}`);
	const data = await response.json();
	if (!response.ok) throw new Error(data?.error || "Could not browse media folder");
	return data.entries || [];
}

export async function createRepairJob(plan: RepairPlan): Promise<Job> {
	const response = await authFetch(`${API}/api/repair/jobs`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(plan),
	});
	const data = await response.json();
	if (!response.ok) throw new Error(data?.error || "Could not create repair job");
	return data;
}

export async function fetchVersions(): Promise<VersionsReport> {
	const response = await authFetch(`${API}/api/versions`);
	const data = await response.json();
	if (!response.ok) throw new Error(data?.error || "Could not read the versions");
	return data;
}

export async function fetchHdrInspection(path: string): Promise<HdrInspection> {
	const response = await authFetch(`${API}/api/hdr/inspect?${new URLSearchParams({ path })}`);
	const data = await response.json();
	if (!response.ok) throw new Error(data?.error || "Could not read the video");
	return data;
}

/** Stores an HDR10+ JSON file on the server for a job to use. */
export async function uploadHdrMetadata(file: File): Promise<{ path: string; frames: number }> {
	const response = await authFetch(`${API}/api/hdr/upload`, { method: "POST", headers: { "Content-Type": "application/json" }, body: file });
	const data = await response.json();
	if (!response.ok) throw new Error(data?.error || "Could not upload the metadata");
	return data;
}

export async function createHdrJob(plan: HdrPlan): Promise<Job> {
	const response = await authFetch(`${API}/api/hdr/jobs`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(plan),
	});
	const data = await response.json();
	if (!response.ok) throw new Error(data?.error || "Could not queue the change");
	return data;
}

export async function createHdrBatch(options: {
	folder: string;
	recursive: boolean;
	plan: Partial<HdrPlan>;
}): Promise<{ jobIds: string[]; skipped: string[] }> {
	const response = await authFetch(`${API}/api/hdr/batch`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(options),
	});
	const data = await response.json();
	if (!response.ok) throw new Error(data?.error || "Could not queue the folder");
	return data;
}

/** Starts reading the film grain of a video on the server. */
export async function startGrainInspection(path: string): Promise<GrainInspectRun> {
	const response = await authFetch(`${API}/api/grain/inspect`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ path }),
	});
	const data = await response.json();
	if (!response.ok) throw new Error(data?.error || "Could not read the video");
	return data;
}

export async function fetchGrainInspectRun(id: string): Promise<GrainInspectRun> {
	const response = await authFetch(`${API}/api/grain/inspect/${encodeURIComponent(id)}`);
	const data = await response.json();
	if (!response.ok) throw new Error(data?.error || "Could not read the video");
	return data;
}

export async function cancelGrainInspection(id: string): Promise<void> {
	await authFetch(`${API}/api/grain/inspect/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Save the film grain table of a video through the browser. */
export async function downloadGrainTable(path: string): Promise<void> {
	const res = await authFetch(`${API}/api/grain/table?${new URLSearchParams({ path })}`);
	await saveResponse(res, "film-grain.tbl");
}

/** Stores a film grain table on the server for a job to use. */
export async function uploadGrainTable(file: File): Promise<{ path: string; entries: number; fixed: number; warnings: number }> {
	const response = await authFetch(`${API}/api/grain/upload`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: file });
	const data = await response.json();
	if (!response.ok) throw new Error(data?.error || "Could not upload the table");
	return data;
}

export async function createGrainJob(plan: GrainPlan): Promise<Job> {
	const response = await authFetch(`${API}/api/grain/jobs`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(plan),
	});
	const data = await response.json();
	if (!response.ok) throw new Error(data?.error || "Could not queue the change");
	return data;
}

export async function createGrainBatch(options: {
	folder: string;
	recursive: boolean;
	plan: Partial<GrainPlan>;
}): Promise<{ jobIds: string[]; skipped: string[] }> {
	const response = await authFetch(`${API}/api/grain/batch`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(options),
	});
	const data = await response.json();
	if (!response.ok) throw new Error(data?.error || "Could not queue the folder");
	return data;
}

export async function fetchConfig(): Promise<JobSettings> {
	const res = await authFetch(`${API}/api/config`);
	return res.json();
}

export interface FontOption {
	label: string;
	faces?: { fileName: string; family: string; keys: string[]; axes: FontAxis[] }[];
}

export async function fetchFonts(): Promise<FontOption[]> {
	try {
		const res = await authFetch(`${API}/api/fonts`);
		return (await res.json()).fonts || [];
	} catch {
		return [];
	}
}

export async function resolveFontFace(family: string, text: string): Promise<{ fileName: string | null; family: string | null }> {
	try {
		const q = new URLSearchParams({ family, text: text.slice(0, 400) });
		const res = await authFetch(`${API}/api/fonts/resolve?${q}`);
		return await res.json();
	} catch {
		return { fileName: null, family: null };
	}
}

export async function fetchFontFace(family: string, fileName: string): Promise<Blob> {
	const res = await authFetch(`${API}/api/fonts/face/${encodeURIComponent(family)}/${encodeURIComponent(fileName)}`);
	if (!res.ok) throw new Error("Font fetch failed");
	return res.blob();
}

export interface GroupStyleResponse {
	style: Partial<StyleAppearance>;
	overrides: Record<string, Partial<StyleAppearance>>;
	keys: string[];
}

export async function fetchGroupStyle(label: string): Promise<GroupStyleResponse> {
	const res = await authFetch(`${API}/api/fonts/${encodeURIComponent(label)}/style`);
	if (!res.ok) return { style: {}, overrides: {}, keys: [] };
	return res.json();
}

export async function saveGroupStyle(label: string, cfg: GroupStyleConfig): Promise<boolean> {
	try {
		const res = await authFetch(`${API}/api/fonts/${encodeURIComponent(label)}/style`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(cfg),
		});
		return res.ok;
	} catch {
		return false;
	}
}

export interface SystemFont {
	path: string;
	fileName: string;
	family: string;
}
export interface SystemFontsResponse {
	roots: string[];
	fonts: SystemFont[];
	enabled: boolean;
}

export async function fetchSystemFonts(): Promise<SystemFontsResponse> {
	try {
		const res = await authFetch(`${API}/api/system-fonts`);
		return await res.json();
	} catch {
		return { roots: [], fonts: [], enabled: false };
	}
}

export async function createFontGroup(label: string): Promise<{ ok: boolean; error?: string }> {
	const res = await authFetch(`${API}/api/fonts/groups`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ label }),
	});
	const data = await res.json().catch(() => ({}));
	return res.ok ? { ok: true } : { ok: false, error: data?.error };
}

export async function renameFontGroup(oldLabel: string, label: string): Promise<{ ok: boolean; error?: string; updatedReferences?: number }> {
	const res = await authFetch(`${API}/api/fonts/groups/${encodeURIComponent(oldLabel)}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ label }),
	});
	const data = await res.json().catch(() => ({}));
	return res.ok ? { ok: true, updatedReferences: data?.updatedReferences } : { ok: false, error: data?.error };
}

export async function deleteFontGroup(label: string): Promise<{ ok: boolean; error?: string }> {
	const res = await authFetch(`${API}/api/fonts/groups/${encodeURIComponent(label)}`, { method: "DELETE" });
	const data = await res.json().catch(() => ({}));
	return res.ok ? { ok: true } : { ok: false, error: data?.error };
}

export async function importFontFace(label: string, source: string, keys: string[]): Promise<{ ok: boolean; error?: string; fileName?: string }> {
	const res = await authFetch(`${API}/api/fonts/groups/${encodeURIComponent(label)}/faces`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ source, keys }),
	});
	const data = await res.json().catch(() => ({}));
	return res.ok ? { ok: true, fileName: data?.fileName } : { ok: false, error: data?.error };
}

export async function updateFontFace(label: string, file: string, keys: string[], family?: string): Promise<{ ok: boolean; error?: string }> {
	const res = await authFetch(`${API}/api/fonts/groups/${encodeURIComponent(label)}/faces/${encodeURIComponent(file)}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ keys, family }),
	});
	const data = await res.json().catch(() => ({}));
	return res.ok ? { ok: true } : { ok: false, error: data?.error };
}

export async function deleteFontFace(label: string, file: string): Promise<{ ok: boolean; error?: string }> {
	const res = await authFetch(`${API}/api/fonts/groups/${encodeURIComponent(label)}/faces/${encodeURIComponent(file)}`, { method: "DELETE" });
	const data = await res.json().catch(() => ({}));
	return res.ok ? { ok: true } : { ok: false, error: data?.error };
}

export interface JobSubtitleTrack {
	index: number;
	codec: string;
	language: string;
	flag: string;
	title: string;
	trackType: string;
	isText: boolean;
}

export async function fetchJobSubtitleTracks(jobId: string): Promise<JobSubtitleTrack[]> {
	const res = await authFetch(`${API}/api/jobs/${jobId}/subtitle-tracks`);
	const data = await res.json();
	if (data.error) throw new Error(data.error);
	return data.tracks || [];
}

export async function fetchQueueState(): Promise<{ paused: boolean }> {
	const res = await authFetch(`${API}/api/queue`);
	return res.json();
}

export async function pauseQueueRequest() {
	const res = await authFetch(`${API}/api/queue/pause`, { method: "POST" });
	return res.json();
}

export async function resumeQueueRequest() {
	const res = await authFetch(`${API}/api/queue/resume`, { method: "POST" });
	return res.json();
}

export async function fetchSystemStats(): Promise<SystemStats> {
	const res = await authFetch(`${API}/api/system`);
	return res.json();
}

export async function fetchAvdDevices(): Promise<AvdDevice[]> {
	if (appState.avdDevices !== null) return appState.avdDevices;
	try {
		const res = await authFetch(`${API}/api/avd-devices`);
		const data = await res.json();
		appState.avdDevices = data.devices || [];
	} catch {
		appState.avdDevices = [];
	}
	return appState.avdDevices ?? [];
}

export async function fetchBenchmark(): Promise<BenchmarkState> {
	const res = await authFetch(`${API}/api/benchmark`);
	return res.json();
}

export async function startBenchmarkRun(modes: BenchmarkMode[]) {
	const res = await authFetch(`${API}/api/benchmark`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ modes }),
	});
	return res.json();
}

export async function cancelBenchmarkRun() {
	const res = await authFetch(`${API}/api/benchmark`, { method: "DELETE" });
	return res.json();
}

export async function patchConfig(settings: JobSettings): Promise<JobSettings> {
	const res = await authFetch(`${API}/api/config`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(settings),
	});
	return res.json();
}

export async function resetConfigRequest() {
	const res = await authFetch(`${API}/api/config/reset`, { method: "POST" });
	return res.json();
}

export async function encodeSettingsCodeRequest(settings: JobSettings): Promise<string> {
	try {
		const res = await authFetch(`${API}/api/settings/encode`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(settings),
		});
		if (!res.ok) return "";
		return (await res.json()).code || "";
	} catch {
		return "";
	}
}

export async function decodeSettingsCodeRequest(code: string): Promise<JobSettings> {
	const res = await authFetch(`${API}/api/settings/decode`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ code }),
	});
	const data = await res.json();
	if (!res.ok) throw new Error(data.error || "Invalid settings code");
	return data.settings;
}

export async function patchJob(id: string, settings: JobSettings): Promise<Job> {
	const res = await authFetch(`${API}/api/jobs/${id}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(settings),
	});
	const data = await res.json();
	if (!res.ok) throw new Error(data.error || "Could not save job settings");
	return data;
}

export async function startFilmGrainTable(
	id: string,
	sourcePath: string,
	sampling: FilmGrainSampling,
	range: "representative" | "full",
	justEnough: boolean,
): Promise<FilmGrainRun> {
	const res = await authFetch(`${API}/api/jobs/${id}/film-grain-table`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ sourcePath, noiseSampling: sampling, range, justEnough }),
	});
	const data = await res.json();
	if (!res.ok) throw new Error(data.error || "Could not generate film grain table");
	return data;
}

export async function fetchFilmGrainRun(id: string): Promise<FilmGrainRun> {
	const res = await authFetch(`${API}/api/jobs/${id}/film-grain-table`);
	const data = await res.json();
	if (!res.ok) throw new Error(data.error || "Could not read film grain table progress");
	return data;
}

export async function cancelFilmGrainTable(id: string): Promise<void> {
	await authFetch(`${API}/api/jobs/${id}/film-grain-table`, { method: "DELETE" });
}

export async function deleteJob(id: string): Promise<void> {
	await authFetch(`${API}/api/jobs/${id}`, { method: "DELETE" });
}

export async function retryJob(id: string): Promise<void> {
	await authFetch(`${API}/api/jobs/${id}/retry`, { method: "POST" });
}

export async function cancelJob(id: string): Promise<void> {
	await authFetch(`${API}/api/jobs/${id}/cancel`, { method: "POST" });
}

export async function reorderQueue(orderedIds: string[]): Promise<void> {
	await authFetch(`${API}/api/jobs/reorder`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ ids: orderedIds }),
	});
}

export async function fetchBitrateAnalysis(
	jobId: string,
	opts: { signal?: AbortSignal; refresh?: boolean } = {},
): Promise<BitrateAnalysisResult & { error?: string }> {
	const qs = opts.refresh ? "?refresh=1" : "";
	const res = await authFetch(`${API}/api/jobs/${jobId}/bitrate-analysis${qs}`, { signal: opts.signal });
	const data = await res.json();
	if (!res.ok) return { ...data, mode: "source", durationSec: 0, bitrate: [], noise: null, error: data?.error || `Request failed (${res.status})` };
	return data;
}

export async function patchJobAutoThresholds(id: string, metric: AutoDenoiseMetric, thresholds: AutoDenoiseThresholds): Promise<Job> {
	const body = metric === "bitrate" ? { autoDenoiseBitrateThresholds: thresholds } : { autoDenoiseThresholds: thresholds };
	const res = await authFetch(`${API}/api/jobs/${id}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return res.json();
}

export async function fetchPreviewState(jobId: string): Promise<PreviewState> {
	const res = await authFetch(`${API}/api/jobs/${jobId}/preview`);
	return res.json();
}

export async function startPreviewRequest(
	jobId: string,
	options?: { clipCount?: number; clipDuration?: number; references?: { path: string; label: string }[] },
): Promise<PreviewState> {
	const res = await authFetch(`${API}/api/jobs/${jobId}/preview`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(options ?? {}),
	});
	return res.json();
}

export async function cancelPreviewRequest(jobId: string): Promise<PreviewState> {
	const res = await authFetch(`${API}/api/jobs/${jobId}/preview`, { method: "DELETE" });
	return res.json();
}

export async function fetchVsPresets(force = false): Promise<VsPresetManifest[]> {
	if (appState.vsPresets !== null && !force) return appState.vsPresets;
	const res = await authFetch(`${API}/api/vs-presets`);
	const data = await res.json();
	appState.vsPresets = data.presets || [];
	return appState.vsPresets ?? [];
}

export async function reloadVsPresets(): Promise<VsPresetManifest[]> {
	await authFetch(`${API}/api/vs-presets/reload`, { method: "POST" });
	return fetchVsPresets(true);
}

export async function fetchVsDefaultEntry(presetId: string): Promise<VsFilterEntry> {
	const res = await authFetch(`${API}/api/vs-presets/${encodeURIComponent(presetId)}/default-entry`);
	return res.json();
}

export interface SeriesNotes {
	key: string;
	title: string;
	notes: string;
	episodes: string[];
	updatedAt: number;
}

export async function fetchSeriesNotes(): Promise<SeriesNotes[]> {
	const res = await authFetch(`${API}/api/translate/notes`);
	const data = await res.json().catch(() => ({}));
	return Array.isArray(data?.series) ? data.series : [];
}

export async function saveSeriesNotes(key: string, notes: string): Promise<{ ok: boolean; error?: string }> {
	const res = await authFetch(`${API}/api/translate/notes/${encodeURIComponent(key)}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ notes }),
	});
	const data = await res.json().catch(() => ({}));
	return res.ok ? { ok: true } : { ok: false, error: data?.error };
}

export interface SelectionSeries {
	key: string;
	title: string;
	/** Selected files belonging to this series. */
	files: number;
	/** First episode by name, used by Prepare. */
	firstFile: string;
	/** Episodes the stored notes were built from, 0 when there are none. */
	episodes: number;
}

export async function fetchSelectionSeries(paths: string[]): Promise<{ enabled: boolean; series: SelectionSeries[]; unmatched: number }> {
	const res = await authFetch(`${API}/api/library/series-notes`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ paths }),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data?.error || "Failed to load series notes");
	return data;
}

export async function prepareSelectionSeriesNotes(
	path: string,
	sourceLanguage: string,
	sourceType: string,
	referenceLanguages: string[],
): Promise<{ ok: boolean; key?: string; error?: string }> {
	const res = await authFetch(`${API}/api/library/series-notes/prepare`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ path, sourceLanguage, sourceType, referenceLanguages }),
	});
	const data = await res.json().catch(() => ({}));
	return res.ok ? { ok: true, key: data?.key } : { ok: false, error: data?.error || "Failed to prepare series notes" };
}

export async function deleteSeriesNotes(key: string): Promise<{ ok: boolean; error?: string }> {
	const res = await authFetch(`${API}/api/translate/notes/${encodeURIComponent(key)}`, { method: "DELETE" });
	const data = await res.json().catch(() => ({}));
	return res.ok ? { ok: true } : { ok: false, error: data?.error };
}

export type SubtitleSearchState = Partial<SubtitleSearchResult> & { searchId: string; state: "running" | "done" | "error"; message: string; error?: string };

/** Starts searching, downloading, syncing and rating subtitles for one video. It runs on the server, poll it for the result. */
export async function startSubtitleSearch(
	path: string,
	languages: string[],
	identity: Partial<SubtitleSearchIdentity>,
	extraLanguages: number,
): Promise<SubtitleSearchState> {
	const response = await authFetch(`${API}/api/subsearch/search`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ path, languages, identity, extraLanguages }),
	});
	const data = await response.json();
	if (!response.ok) throw new Error(data?.error || "Subtitle search failed");
	return data;
}

export async function fetchSubtitleSearch(searchId: string): Promise<SubtitleSearchState> {
	const response = await authFetch(`${API}/api/subsearch/search/${encodeURIComponent(searchId)}`);
	const data = await response.json();
	if (!response.ok) throw new Error(data?.error || "Subtitle search failed");
	return data;
}

export async function cancelSubtitleSearch(searchId: string): Promise<void> {
	await authFetch(`${API}/api/subsearch/search/${encodeURIComponent(searchId)}`, { method: "DELETE" }).catch(() => undefined);
}

/** Adds the chosen subtitles to the video as a queued job, or saves them next to it. */
export async function applyVideoSubtitles(
	searchId: string,
	choices: Array<{ language: string; key: string; credit?: string }>,
	mode: "mux" | "sidecar",
): Promise<{ jobId?: string; files?: string[] }> {
	const response = await authFetch(`${API}/api/subsearch/apply`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ searchId, choices, mode }),
	});
	const data = await response.json();
	if (!response.ok) throw new Error(data?.error || "Could not use the subtitles");
	return data;
}

export interface OcrTrackInfo {
	index: number;
	codec: string;
	language: string;
	languageName: string;
	title: string;
	type: string;
	forced: boolean;
	picture: boolean;
	/** A picture track whose language and kind already has a text track. */
	hasText: boolean;
}

export async function fetchOcrTracks(path: string, source?: string): Promise<{ configured: boolean; tracks: OcrTrackInfo[] }> {
	const response = await authFetch(`${API}/api/ocr/inspect?${new URLSearchParams(source ? { path, source } : { path })}`);
	const data = await response.json();
	if (!response.ok) throw new Error(data?.error || "Could not read the video");
	return data;
}

export async function queueOcrJob(path: string, streams: number[], removePictures: boolean, source?: string): Promise<{ jobId: string }> {
	const response = await authFetch(`${API}/api/ocr/jobs`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ path, streams, removePictures, source }),
	});
	const data = await response.json();
	if (!response.ok) throw new Error(data?.error || "Could not queue OCR");
	return data;
}

export interface OcrPair {
	targetPath: string;
	targetName: string;
	sourcePath: string;
	sourceName: string;
	method: "episode" | "order" | "none";
}

export async function fetchOcrPairs(folder: string, sourceFolder: string, recursive: boolean): Promise<{ pairs: OcrPair[]; unmatchedSources: string[] }> {
	const response = await authFetch(`${API}/api/ocr/pairs`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ folder, sourceFolder, recursive }),
	});
	const data = await response.json();
	if (!response.ok) throw new Error(data?.error || "Could not match the files");
	return data;
}

export async function queueOcrBatch(opts: {
	folder: string;
	recursive: boolean;
	languages: string[];
	removePictures: boolean;
	pairs?: Array<{ targetPath: string; sourcePath: string }>;
}): Promise<{ jobIds: string[]; skipped: string[] }> {
	const response = await authFetch(`${API}/api/ocr/batch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(opts) });
	const data = await response.json();
	if (!response.ok) throw new Error(data?.error || "Could not queue OCR");
	return data;
}

/** Reads a sample subtitle image with the OCR model. */
export async function testOcrModel(opts: {
	provider: string;
	baseUrl: string;
	model: string;
	apiKey: string;
}): Promise<{ ok: boolean; text?: string; error?: string }> {
	try {
		const res = await authFetch(`${API}/api/ocr/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(opts) });
		return await res.json();
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export async function testOpenSubtitlesAccount(opts: {
	username: string;
	password: string;
}): Promise<{ ok: boolean; error?: string; user?: string; remaining?: number | null; allowed?: number | null }> {
	try {
		const res = await authFetch(`${API}/api/subsearch/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(opts) });
		return await res.json();
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export async function testTranslateConnection(opts: {
	provider: "openai" | "anthropic";
	baseUrl?: string;
	model: string;
	apiKey?: string;
	target?: string;
	thinking?: string;
}): Promise<{ ok: boolean; error?: string; sample?: string; target?: string }> {
	try {
		const res = await authFetch(`${API}/api/translate/test`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(opts),
		});
		return await res.json();
	} catch (err: any) {
		return { ok: false, error: err?.message || "Request failed" };
	}
}
