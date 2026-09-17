import type { RepairAuditFile, RepairAuditSubtitleMetadata, RepairAuditTrack, RepairFolderAudit } from "../types";
import { createRepairAuditGroupJobs, fetchRepairFolderAudit } from "../api/client";
import { buttonById, byId } from "../shared/dom";
import { errorMessage } from "../shared/errors";
import { openRepairFolderPicker, openRepairPaths } from "./repair";
import { update } from "./polling";

let audit: RepairFolderAudit | null = null;
let selectedPath = "";
let editingGroup: number | null = null;
let groupSubtitles: RepairAuditSubtitleMetadata[] = [];
let originalSubtitles = "";
let queueingGroup = false;
const queuedPaths = new Set<string>();

const subtitleFlags = [
	["isDefault", "Default"],
	["isForced", "Forced"],
	["isEnabled", "Enabled"],
	["isHearingImpaired", "HI"],
	["isOriginal", "Original"],
	["isCommentary", "Commentary"],
] as const;

function subtitleMetadata(track: RepairAuditTrack): RepairAuditSubtitleMetadata {
	return {
		title: track.title,
		language: track.language,
		isDefault: track.isDefault,
		isForced: track.isForced,
		isEnabled: track.isEnabled,
		isHearingImpaired: track.isHearingImpaired,
		isOriginal: track.isOriginal,
		isCommentary: track.isCommentary,
	};
}

function groupFiles(): RepairAuditFile[] {
	return audit?.files.filter((file) => file.group === editingGroup) || [];
}

const escapeHtml = (value: unknown): string =>
	String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");

function groupClass(group: number): string {
	return `repair-audit-group-${group === 0 ? 0 : ((group - 1) % 8) + 1}`;
}

function activeFlags(track: RepairAuditTrack): string[] {
	return [
		track.isDefault ? "Default" : "",
		track.isForced ? "Forced" : "",
		!track.isEnabled ? "Disabled" : "",
		track.isHearingImpaired ? "HI" : "",
		track.isVisualImpaired ? "VI" : "",
		track.isTextDescriptions ? "Descriptions" : "",
		track.isOriginal ? "Original" : "",
		track.isCommentary ? "Commentary" : "",
	].filter(Boolean);
}

function selectedFile(): RepairAuditFile | undefined {
	return audit?.files.find((file) => file.path === selectedPath);
}

function renderFileList(): void {
	if (!audit) return;
	byId("repair-audit-files").innerHTML = audit.files.length
		? audit.files
				.map((file) => {
					const selected = file.path === selectedPath ? " is-selected" : "";
					const summary = file.group === 0 ? "Matches majority layout" : file.differences[0] || "Different track layout";
					return `<button class="repair-audit-file${selected}" type="button" data-audit-select="${escapeHtml(file.path)}">
						<span class="repair-audit-group-badge ${groupClass(file.group)}">${escapeHtml(file.groupLabel)}</span>
						<span class="repair-audit-file-text">
							<strong title="${escapeHtml(file.path)}">${escapeHtml(file.filename)}</strong>
							<small>${escapeHtml(summary)}</small>
						</span>
						<span class="repair-audit-track-total">${file.tracks.length}</span>
					</button>`;
				})
				.join("")
		: '<div class="repair-empty">No MKV files were found directly inside this folder.</div>';
}

function renderTrack(track: RepairAuditTrack): string {
	const flags = activeFlags(track);
	return `<div class="repair-audit-track">
		<div class="repair-audit-track-main">
			<span class="sub-track-id">${track.type === "audio" ? "Audio" : "Subtitle"} #${track.id}</span>
			<strong>${escapeHtml(track.title || "Untitled")}</strong>
		</div>
		<div class="repair-audit-track-meta">
			<span>${escapeHtml(track.language)}</span>
			<span>${escapeHtml(track.codec)}</span>
			${track.type === "subtitles" ? `<span>${track.compression}</span>` : ""}
			${flags.map((flag) => `<span>${escapeHtml(flag)}</span>`).join("")}
		</div>
	</div>`;
}

function renderDetails(): void {
	if (editingGroup !== null) {
		renderGroupEditor();
		return;
	}
	const file = selectedFile();
	if (!file) {
		byId("repair-audit-details").innerHTML = '<div class="repair-empty">Select a file to inspect its tracks.</div>';
		buttonById("repair-audit-open-btn").disabled = true;
		return;
	}
	const differences =
		file.group === 0
			? '<div class="repair-audit-match">This file matches the majority audio/subtitle layout.</div>'
			: `<div class="repair-audit-differences"><strong>Different from group A</strong><ul>${file.differences.map((difference) => `<li>${escapeHtml(difference)}</li>`).join("")}</ul></div>`;
	byId("repair-audit-details").innerHTML = `<div class="repair-audit-detail-head">
		<div><span class="repair-audit-group-badge ${groupClass(file.group)}">${escapeHtml(file.groupLabel)}</span><strong>${escapeHtml(file.filename)}</strong></div>
		<small>${file.tracks.filter((track) => track.type === "audio").length} audio, ${file.tracks.filter((track) => track.type === "subtitles").length} subtitles</small>
	</div>${differences}<div class="repair-audit-tracks">${file.tracks.map(renderTrack).join("") || '<div class="repair-empty">No audio or subtitle tracks.</div>'}</div>`;
	buttonById("repair-audit-open-btn").disabled = false;
	buttonById("repair-audit-open-btn").textContent = file.sourcePath ? "Repair with original source" : "Open repair editor";
}

function renderGroupEditor(): void {
	const files = groupFiles();
	const representative = files[0];
	if (!representative) return;
	const tracks = representative.tracks.filter((track) => track.type === "subtitles");
	byId("repair-audit-details").innerHTML = `<div class="repair-audit-detail-head">
		<div><span class="repair-audit-group-badge ${groupClass(representative.group)}">${escapeHtml(representative.groupLabel)}</span><strong>Edit group ${escapeHtml(representative.groupLabel)}</strong></div>
		<small>Changes apply to all ${files.length} file${files.length === 1 ? "" : "s"} in this group.</small>
	</div>
	<fieldset class="repair-audit-group-fields" ${queueingGroup ? "disabled" : ""}>
		<div class="repair-audit-tracks">${groupSubtitles
			.map(
				(track, index) => `<div class="repair-track">
			<div class="repair-track-head"><span class="sub-track-id">Subtitle ${index + 1}</span><span class="repair-codec">${escapeHtml(tracks[index]?.codec)}</span></div>
			<div class="repair-track-fields repair-audit-metadata-fields">
				<label>Subtitle name<input class="repair-input" data-audit-track="${index}" data-audit-field="title" value="${escapeHtml(track.title)}" maxlength="512"></label>
				<label>Language<input class="repair-input" data-audit-track="${index}" data-audit-field="language" value="${escapeHtml(track.language)}" maxlength="35"></label>
			</div>
			<div class="repair-flags">${subtitleFlags.map(([field, label]) => `<label class="repair-flag"><input type="checkbox" data-audit-track="${index}" data-audit-field="${field}" ${track[field] ? "checked" : ""}> ${label}</label>`).join("")}</div>
		</div>`,
			)
			.join("")}</div>
		<label class="repair-audit-save-mode">Save changes to
			<select class="select-input" id="repair-audit-group-save-mode">
				<option value="existing" selected>Existing MKV files</option>
				<option value="copies">New .repaired.mkv copies</option>
			</select>
		</label>
		<p class="repair-subtitle">Existing files are updated after verification. Track order and compression are preserved.</p>
		<div class="repair-audit-group-actions"><button class="btn btn-ghost" type="button" data-audit-cancel-group>Cancel</button><button class="btn btn-primary" id="repair-audit-group-queue" type="button" data-audit-queue-group disabled>Queue changes for ${files.length} file${files.length === 1 ? "" : "s"}</button></div>
	</fieldset>`;
	buttonById("repair-audit-open-btn").disabled = true;
}

function renderAudit(): void {
	if (!audit) return;
	const outliers = audit.files.filter((file) => file.group > 0).length;
	byId("repair-audit-summary").innerHTML = `<span>${audit.files.length} MKV file${audit.files.length === 1 ? "" : "s"}</span>
		<span>${audit.groups.length} layout group${audit.groups.length === 1 ? "" : "s"}</span>
		<span class="${outliers ? "has-outliers" : "all-matching"}">${outliers ? `${outliers} outlier${outliers === 1 ? "" : "s"}` : "All files match"}</span>`;
	byId("repair-audit-groups").innerHTML = audit.groups
		.map((group) => {
			const files = audit!.files.filter((file) => file.group === group.group);
			const canEdit = files[0]?.tracks.some((track) => track.type === "subtitles") && !files.some((file) => queuedPaths.has(file.path));
			return `<span class="repair-audit-group-summary"><span class="repair-audit-group-badge ${groupClass(group.group)}">${escapeHtml(group.label)}</span>${group.count} file${group.count === 1 ? "" : "s"}${group.group === 0 ? " (majority)" : ""}<button class="btn btn-ghost btn-sm" type="button" data-audit-edit-group="${group.group}" ${canEdit ? "" : "disabled"}>Edit group</button></span>`;
		})
		.join("");
	renderFileList();
	renderDetails();
}

async function loadAudit(options: { path?: string; jobIds?: string[] }, label?: string): Promise<void> {
	if (queueingGroup) return;
	audit = null;
	selectedPath = "";
	editingGroup = null;
	groupSubtitles = [];
	queuedPaths.clear();
	byId("repair-audit-status").textContent = "";
	byId("repair-audit-modal").style.display = "";
	byId("repair-audit-title-note").textContent = label || options.path || "Completed encoding folder";
	byId("repair-audit-summary").innerHTML = '<span class="library-loading">Inspecting MKV metadata...</span>';
	byId("repair-audit-groups").innerHTML = "";
	byId("repair-audit-files").innerHTML = "";
	byId("repair-audit-details").innerHTML = "";
	buttonById("repair-audit-open-btn").disabled = true;
	try {
		audit = await fetchRepairFolderAudit(options);
		selectedPath = audit.files.find((file) => file.group > 0)?.path || audit.files[0]?.path || "";
		renderAudit();
	} catch (error) {
		byId("repair-audit-summary").innerHTML = `<span class="repair-audit-error">${escapeHtml(errorMessage(error))}</span>`;
	}
}

export function openRepairAuditFolder(path: string): Promise<void> {
	return loadAudit({ path });
}

export function openRepairAuditJobs(jobIds: string[], label?: string): Promise<void> {
	return loadAudit({ jobIds }, label);
}

export function openRepairAuditPicker(): void {
	openRepairFolderPicker(openRepairAuditFolder);
}

export function closeRepairAudit(): void {
	byId("repair-audit-modal").style.display = "none";
}

export function closeRepairAuditIfOutside(event: MouseEvent): void {
	if (event.target === event.currentTarget) closeRepairAudit();
}

export function handleRepairAuditClick(event: MouseEvent): void {
	if (queueingGroup) return;
	const element =
		event.target instanceof Element
			? event.target.closest<HTMLElement>("[data-audit-select], [data-audit-edit-group], [data-audit-cancel-group], [data-audit-queue-group]")
			: null;
	if (!element || (element instanceof HTMLButtonElement && element.disabled)) return;
	if (element.hasAttribute("data-audit-edit-group")) {
		editingGroup = Number(element.dataset.auditEditGroup);
		groupSubtitles = (groupFiles()[0]?.tracks || []).filter((track) => track.type === "subtitles").map(subtitleMetadata);
		originalSubtitles = JSON.stringify(groupSubtitles);
		byId("repair-audit-status").textContent = "";
		renderDetails();
		return;
	}
	if (element.hasAttribute("data-audit-queue-group")) {
		void queueAuditGroup();
		return;
	}
	editingGroup = null;
	if (element.hasAttribute("data-audit-cancel-group")) {
		renderDetails();
		return;
	}
	if (!element.dataset.auditSelect) return;
	selectedPath = element.dataset.auditSelect;
	renderFileList();
	renderDetails();
}

export function handleRepairAuditInput(event: Event): void {
	if (queueingGroup || !(event.target instanceof HTMLInputElement)) return;
	const { auditTrack, auditField } = event.target.dataset;
	if (auditTrack === undefined || !auditField) return;
	const track = groupSubtitles[Number(auditTrack)];
	if (!track) return;
	if (auditField === "title" || auditField === "language") track[auditField] = event.target.value;
	else {
		const flag = subtitleFlags.find(([field]) => field === auditField)?.[0];
		if (!flag) return;
		track[flag] = event.target.checked;
	}
	buttonById("repair-audit-group-queue").disabled = JSON.stringify(groupSubtitles) === originalSubtitles;
}

async function queueAuditGroup(): Promise<void> {
	const files = groupFiles();
	if (queueingGroup || !files.length || JSON.stringify(groupSubtitles) === originalSubtitles) return;
	const currentAudit = audit;
	const replaceTarget = (byId("repair-audit-group-save-mode") as HTMLSelectElement).value === "existing";
	queueingGroup = true;
	buttonById("repair-audit-pick-folder-btn").disabled = true;
	const fields = byId("repair-audit-details").querySelector("fieldset");
	if (fields) fields.disabled = true;
	byId("repair-audit-status").textContent = `Validating and queueing changes for ${files.length} files...`;
	try {
		const result = await createRepairAuditGroupJobs({
			paths: files.map((file) => file.path),
			expectedTracks: files[0]!.tracks,
			subtitles: groupSubtitles,
			replaceTarget,
		});
		if (audit === currentAudit) {
			files.forEach((file) => queuedPaths.add(file.path));
			editingGroup = null;
			byId("repair-audit-status").textContent =
				`Queued ${result.jobIds.length} repairs for group ${files[0]!.groupLabel}. Follow their progress in the job list. Audit again after completion to see the updated metadata.`;
			renderAudit();
		}
		void update().catch(() => {});
	} catch (error) {
		if (audit === currentAudit) byId("repair-audit-status").textContent = errorMessage(error);
	} finally {
		queueingGroup = false;
		buttonById("repair-audit-pick-folder-btn").disabled = false;
		if (fields?.isConnected) fields.disabled = false;
	}
}

export function openSelectedAuditRepair(): void {
	const file = selectedFile();
	if (!file || !audit) return;
	closeRepairAudit();
	void openRepairPaths(file.path, file.sourcePath);
}
