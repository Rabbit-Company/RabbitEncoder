import Blake2b from "@rabbit-company/blake2b";
import type {
	AutoDenoiseMetric,
	AutoDenoiseThresholds,
	BitrateAnalysisResult,
	FontAxis,
	GroupStyleConfig,
	Job,
	JobSettings,
	PreviewState,
	StyleAppearance,
	VsFilterEntry,
	VsPresetManifest,
} from "../types";
import type { BenchmarkState, FetchOptions, GpuDevice, SystemStats } from "../ui/models";
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

export async function fetchBenchmark(): Promise<BenchmarkState> {
	const res = await authFetch(`${API}/api/benchmark`);
	return res.json();
}

export async function startBenchmarkRun() {
	const res = await authFetch(`${API}/api/benchmark`, { method: "POST" });
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
	return res.json();
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

export async function startPreviewRequest(jobId: string, options?: { clipCount?: number; clipDuration?: number }): Promise<PreviewState> {
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

export async function testTranslateConnection(opts: {
	provider: "openai" | "anthropic";
	baseUrl?: string;
	model: string;
	apiKey?: string;
	target?: string;
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
