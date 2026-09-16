import type { RepairAuditFile, RepairAuditTrack, RepairFolderAudit } from "../types";
import { fetchRepairFolderAudit } from "../api/client";
import { buttonById, byId } from "../shared/dom";
import { errorMessage } from "../shared/errors";
import { openRepairFolderPicker, openRepairPaths } from "./repair";

let audit: RepairFolderAudit | null = null;
let selectedPath = "";

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

function renderAudit(): void {
	if (!audit) return;
	const outliers = audit.files.filter((file) => file.group > 0).length;
	byId("repair-audit-summary").innerHTML = `<span>${audit.files.length} MKV file${audit.files.length === 1 ? "" : "s"}</span>
		<span>${audit.groups.length} layout group${audit.groups.length === 1 ? "" : "s"}</span>
		<span class="${outliers ? "has-outliers" : "all-matching"}">${outliers ? `${outliers} outlier${outliers === 1 ? "" : "s"}` : "All files match"}</span>`;
	byId("repair-audit-groups").innerHTML = audit.groups
		.map(
			(group) =>
				`<span class="repair-audit-group-summary"><span class="repair-audit-group-badge ${groupClass(group.group)}">${group.label}</span>${group.count} file${group.count === 1 ? "" : "s"}${group.group === 0 ? " (majority)" : ""}</span>`,
		)
		.join("");
	renderFileList();
	renderDetails();
}

async function loadAudit(options: { path?: string; jobIds?: string[] }, label?: string): Promise<void> {
	audit = null;
	selectedPath = "";
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
	const element = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-audit-select]") : null;
	if (!element?.dataset.auditSelect) return;
	selectedPath = element.dataset.auditSelect;
	renderFileList();
	renderDetails();
}

export function openSelectedAuditRepair(): void {
	const file = selectedFile();
	if (!file || !audit) return;
	closeRepairAudit();
	void openRepairPaths(file.path, file.sourcePath);
}
