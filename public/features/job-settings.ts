import type { SettingsCodePanelElement } from "../ui/models";
import { decodeSettingsCodeRequest, deleteJob, fetchJobs, patchJob, retryJob } from "../api/client";
import { update } from "./polling";
import { mountSettingsCodePanel } from "./settings-controls";
import { cloneSettingsForEditing, renderSettingsForm } from "./settings-form";
import { byId } from "../shared/dom";
import { appState } from "../state";

export async function openJobSettings(jobId: string): Promise<void> {
	const jobs = await fetchJobs();
	const job = jobs.find((j) => j.id === jobId);
	if (!job || job.status !== "queued") return;

	appState.currentEditJobId = jobId;
	byId("job-modal-title").textContent = job.filename;

	const base = window._tempJobSettings ?? job.settings;
	const tempSettings = cloneSettingsForEditing(base, job.settings.audioBitrates);
	window._tempJobSettings = tempSettings;

	renderSettingsForm("job", tempSettings);

	mountSettingsCodePanel(byId("settings-code-panel-job"), {
		getSettings: () => window._tempJobSettings,
		onImport: (code) => decodeSettingsCodeRequest(code),
		onApplied: (settings) => {
			if (window._tempJobSettings) Object.assign(window._tempJobSettings, settings);
			if (appState.currentEditJobId) openJobSettings(appState.currentEditJobId);
		},
	});

	byId("job-modal").style.display = "";
}

export async function saveJobSettings() {
	if (!appState.currentEditJobId || !window._tempJobSettings) return;
	await patchJob(appState.currentEditJobId, window._tempJobSettings);
	closeJobModal();
	update();
}

export function closeJobModal() {
	window._tempJobSettings = null;
	const panel = byId<SettingsCodePanelElement>("settings-code-panel-job");
	if (panel._codeTimer) {
		clearInterval(panel._codeTimer);
		panel._codeTimer = null;
	}
	byId("job-modal").style.display = "none";
	appState.currentEditJobId = null;
}

export function closeJobModalIfOutside(e: MouseEvent): void {
	if (e.target === e.currentTarget) closeJobModal();
}

export async function removeJob(id: string): Promise<void> {
	await deleteJob(id);
	update();
}

export async function removeJobs(ids: string[]): Promise<void> {
	await Promise.all(ids.map((id) => deleteJob(id)));
	update();
}

export async function doRetry(id: string): Promise<void> {
	await retryJob(id);
	update();
}
