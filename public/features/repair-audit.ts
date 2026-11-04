import type {
	RepairAuditAudioMetadata,
	RepairAuditFile,
	RepairAuditLanguage,
	RepairAuditSubtitleMetadata,
	RepairAuditTrack,
	RepairFolderAudit,
} from "../types";
import { createRepairAuditGroupJobs, fetchRepairFolderAudit, removeRepairAuditLanguages } from "../api/client";
import { buttonById, byId } from "../shared/dom";
import { errorMessage } from "../shared/errors";
import { openRepairFolderPicker, openRepairPaths } from "./repair";
import { update } from "./polling";

let audit: RepairFolderAudit | null = null;
let selectedPath = "";
let editingGroup: number | null = null;
let groupSubtitles: RepairAuditSubtitleMetadata[] = [];
let groupAudio: RepairAuditAudioMetadata[] = [];
let originalSubtitles = "";
let originalAudio = "";
let queueingGroup = false;
const queuedPaths = new Set<string>();
/** Subtitle languages ticked for removal. */
const removeLanguages = new Set<string>();
let languagesOpen: boolean | null = null;

const subtitleFlags = [
	["isDefault", "Default"],
	["isForced", "Forced"],
	["isEnabled", "Enabled"],
	["isHearingImpaired", "HI"],
	["isOriginal", "Original"],
	["isCommentary", "Commentary"],
] as const;

const audioFlags = [
	["isDefault", "Default"],
	["isEnabled", "Enabled"],
	["isVisualImpaired", "VI"],
	["isOriginal", "Original"],
	["isCommentary", "Commentary"],
] as const;

function audioMetadata(track: RepairAuditTrack): RepairAuditAudioMetadata {
	return {
		title: track.title,
		language: track.language,
		isDefault: track.isDefault,
		isForced: track.isForced,
		isEnabled: track.isEnabled,
		isHearingImpaired: track.isHearingImpaired,
		isVisualImpaired: track.isVisualImpaired,
		isOriginal: track.isOriginal,
		isCommentary: track.isCommentary,
	};
}

function groupEdited(): { audio: boolean; subtitles: boolean } {
	return { audio: JSON.stringify(groupAudio) !== originalAudio, subtitles: JSON.stringify(groupSubtitles) !== originalSubtitles };
}

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
					const more = file.differences.length > 1 ? ` (+${file.differences.length - 1} more)` : "";
					const summary = file.group === 0 ? "Matches majority layout" : file.differences[0] ? file.differences[0] + more : "Different track layout";
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

function languageField(kind: "audio" | "subtitle", index: number, language: string): string {
	return `<label>Language<input class="repair-input" data-audit-kind="${kind}" data-audit-track="${index}" data-audit-field="language" value="${escapeHtml(language)}" maxlength="35" data-language-picker="single" data-language-codes="tag"></label>`;
}

function renderGroupEditor(): void {
	const files = groupFiles();
	const representative = files[0];
	if (!representative) return;
	const tracks = representative.tracks.filter((track) => track.type === "subtitles");
	const audioTracks = representative.tracks.filter((track) => track.type === "audio");
	const audioRows = groupAudio
		.map(
			(track, index) => `<div class="repair-track">
			<div class="repair-track-head"><span class="sub-track-id">Audio ${index + 1}</span><span class="repair-codec">${escapeHtml(audioTracks[index]?.codec)}</span></div>
			<div class="repair-track-fields repair-audit-metadata-fields">
				<label>Track name<input class="repair-input" data-audit-kind="audio" data-audit-track="${index}" data-audit-field="title" value="${escapeHtml(track.title)}" maxlength="512"></label>
				${languageField("audio", index, track.language)}
			</div>
			<div class="repair-flags">${audioFlags.map(([field, label]) => `<label class="repair-flag"${field === "isVisualImpaired" ? ' title="For visually impaired viewers, such as an audio description"' : ""}><input type="checkbox" data-audit-kind="audio" data-audit-track="${index}" data-audit-field="${field}" ${track[field] ? "checked" : ""}> ${label}</label>`).join("")}</div>
		</div>`,
		)
		.join("");
	const subtitleRows = groupSubtitles
		.map(
			(track, index) => `<div class="repair-track">
			<div class="repair-track-head"><span class="sub-track-id">Subtitle ${index + 1}</span><span class="repair-codec">${escapeHtml(tracks[index]?.codec)}</span></div>
			<div class="repair-track-fields repair-audit-metadata-fields">
				<label>Subtitle name<input class="repair-input" data-audit-kind="subtitle" data-audit-track="${index}" data-audit-field="title" value="${escapeHtml(track.title)}" maxlength="512"></label>
				${languageField("subtitle", index, track.language)}
			</div>
			<div class="repair-flags">${subtitleFlags.map(([field, label]) => `<label class="repair-flag"><input type="checkbox" data-audit-kind="subtitle" data-audit-track="${index}" data-audit-field="${field}" ${track[field] ? "checked" : ""}> ${label}</label>`).join("")}</div>
		</div>`,
		)
		.join("");
	byId("repair-audit-details").innerHTML = `<div class="repair-audit-detail-head">
		<div><span class="repair-audit-group-badge ${groupClass(representative.group)}">${escapeHtml(representative.groupLabel)}</span><strong>Edit group ${escapeHtml(representative.groupLabel)}</strong></div>
		<small>Changes apply to all ${files.length} file${files.length === 1 ? "" : "s"} in this group.</small>
	</div>
	<fieldset class="repair-audit-group-fields" ${queueingGroup ? "disabled" : ""}>
		${audioRows ? `<div class="repair-audit-section-title">Audio</div><div class="repair-audit-tracks">${audioRows}</div>` : ""}
		${subtitleRows ? `<div class="repair-audit-section-title">Subtitles</div><div class="repair-audit-tracks">${subtitleRows}</div>` : ""}
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
			const canEdit = !!files[0]?.tracks.length && !files.some((file) => queuedPaths.has(file.path));
			return `<span class="repair-audit-group-summary"><span class="repair-audit-group-badge ${groupClass(group.group)}">${escapeHtml(group.label)}</span>${group.count} file${group.count === 1 ? "" : "s"}${group.group === 0 ? " (majority)" : ""}<button class="btn btn-ghost btn-sm" type="button" data-audit-edit-group="${group.group}" ${canEdit ? "" : "disabled"}>Edit group</button></span>`;
		})
		.join("");
	renderLanguages();
	renderFileList();
	renderDetails();
}

const languageNames = (() => {
	try {
		return new Intl.DisplayNames(["en"], { type: "language" });
	} catch {
		return null;
	}
})();

function languageName(tag: string): string {
	try {
		return languageNames?.of(tag) ?? tag;
	} catch {
		return tag;
	}
}

/** The episode code of a file name, such as S01E12, or the whole name. */
function shortFileName(name: string): string {
	return name.match(/S\d{1,2}E\d{1,4}/i)?.[0]?.toUpperCase() ?? name;
}

function languageRow(lang: RepairAuditLanguage, total: number): string {
	const complete = lang.fileCount === total;
	const missing = lang.missingFrom.map(shortFileName);
	const missingText = complete ? "" : missing.length > 8 ? `missing in ${missing.length} files` : `missing in ${missing.join(", ")}`;
	return `<label class="repair-audit-language${complete ? "" : " is-partial"}" title="${escapeHtml(lang.missingFrom.join("\n"))}">
		<input type="checkbox" data-audit-remove-language="${escapeHtml(lang.language)}" ${removeLanguages.has(lang.language) ? "checked" : ""} ${queueingGroup ? "disabled" : ""}>
		<strong>${escapeHtml(lang.language)}</strong>
		<span>${escapeHtml(languageName(lang.language))}</span>
		<span class="repair-audit-language-count">${lang.fileCount}/${total}</span>
		${lang.trackCount > lang.fileCount ? `<span class="repair-audit-language-count">${lang.trackCount} tracks</span>` : ""}
		${missingText ? `<small>${escapeHtml(missingText)}</small>` : ""}
	</label>`;
}

/** The subtitle languages of the folder, which files lack each, and removing chosen ones from every file. */
function renderLanguages(): void {
	const container = byId("repair-audit-languages");
	const languages = audit?.languages ?? [];
	const total = audit?.files.length ?? 0;
	if (!languages.length || !total) {
		container.innerHTML = "";
		return;
	}
	const previous = container.querySelector("details");
	if (previous) languagesOpen = previous.open;
	const complete = languages.filter((lang) => lang.fileCount === total);
	const partial = languages.filter((lang) => lang.fileCount < total);
	languagesOpen ??= partial.length > 0;
	const affected = audit!.files.filter((file) => file.tracks.some((track) => track.type === "subtitles" && removeLanguages.has(track.language)));
	const summary = partial.length ? `${complete.length} on all ${total} files, ${partial.length} on only some` : `All ${complete.length} on every file`;
	const section = (title: string, list: RepairAuditLanguage[]) =>
		list.length
			? `<div class="repair-audit-language-section"><strong>${title}</strong><div class="repair-audit-language-list">${list.map((lang) => languageRow(lang, total)).join("")}</div></div>`
			: "";
	container.innerHTML = `<details class="settings-subsection repair-audit-languages"${languagesOpen ? " open" : ""}>
		<summary>Subtitle languages <span class="hdr-note">${escapeHtml(summary)}</span></summary>
		<div class="settings-subsection-body">
			${section("On only some files", partial)}
			${section("On every file", complete)}
			<div class="repair-audit-language-actions">
				<button class="btn btn-ghost btn-sm" type="button" data-audit-select-partial ${partial.length && !queueingGroup ? "" : "disabled"}>Select the ones on only some files</button>
				<label class="repair-audit-save-mode">Save changes to
					<select class="select-input" id="repair-audit-languages-save-mode" ${queueingGroup ? "disabled" : ""}>
						<option value="existing" selected>Existing MKV files</option>
						<option value="copies">New .repaired.mkv copies</option>
					</select>
				</label>
				<button class="btn btn-primary btn-sm" type="button" data-audit-remove-languages ${removeLanguages.size && affected.length && !queueingGroup ? "" : "disabled"}>
					Remove ${removeLanguages.size} language${removeLanguages.size === 1 ? "" : "s"} from ${affected.length} file${affected.length === 1 ? "" : "s"}
				</button>
			</div>
		</div>
	</details>`;
}

export function handleRepairAuditLanguagesChange(event: Event): void {
	const input = event.target instanceof HTMLInputElement ? event.target : null;
	const language = input?.dataset.auditRemoveLanguage;
	if (!input || language === undefined || queueingGroup) return;
	if (input.checked) removeLanguages.add(language);
	else removeLanguages.delete(language);
	renderLanguages();
}

export function handleRepairAuditLanguagesClick(event: MouseEvent): void {
	if (queueingGroup || !audit) return;
	const target = event.target instanceof Element ? event.target : null;
	if (target?.closest("[data-audit-select-partial]")) {
		for (const lang of audit.languages) if (lang.fileCount < audit.files.length) removeLanguages.add(lang.language);
		renderLanguages();
		return;
	}
	if (target?.closest("[data-audit-remove-languages]")) void queueLanguageRemoval();
}

async function queueLanguageRemoval(): Promise<void> {
	if (!audit || !removeLanguages.size || queueingGroup) return;
	const currentAudit = audit;
	const languages = [...removeLanguages];
	const files = audit.files.filter((file) => file.tracks.some((track) => track.type === "subtitles" && removeLanguages.has(track.language)));
	if (!files.length) return;
	const busy = files.find((file) => queuedPaths.has(file.path));
	if (busy) {
		byId("repair-audit-status").textContent = `${busy.filename} already has queued changes. Audit again after they finish.`;
		return;
	}
	const replaceTarget = (byId("repair-audit-languages-save-mode") as HTMLSelectElement).value === "existing";
	const where = replaceTarget ? "The files are rewritten in place." : "New .repaired.mkv copies are written next to them.";
	if (!confirm(`Remove every subtitle track in ${languages.join(", ")} from ${files.length} file${files.length === 1 ? "" : "s"}?\n\n${where}`)) return;
	queueingGroup = true;
	buttonById("repair-audit-pick-folder-btn").disabled = true;
	renderLanguages();
	byId("repair-audit-status").textContent = `Validating and queueing changes for ${files.length} files...`;
	try {
		const result = await removeRepairAuditLanguages({ paths: files.map((file) => file.path), languages, replaceTarget });
		if (audit === currentAudit) {
			files.forEach((file) => queuedPaths.add(file.path));
			removeLanguages.clear();
			byId("repair-audit-status").textContent =
				`Queued ${result.jobIds.length} repairs removing ${languages.join(", ")}. Follow their progress in the job list. Audit again after completion to see the updated tracks.`;
		}
		void update().catch(() => {});
	} catch (error) {
		if (audit === currentAudit) byId("repair-audit-status").textContent = errorMessage(error);
	} finally {
		queueingGroup = false;
		buttonById("repair-audit-pick-folder-btn").disabled = false;
		if (audit === currentAudit) renderAudit();
	}
}

async function loadAudit(options: { path?: string; jobIds?: string[] }, label?: string): Promise<void> {
	if (queueingGroup) return;
	audit = null;
	selectedPath = "";
	editingGroup = null;
	groupSubtitles = [];
	groupAudio = [];
	queuedPaths.clear();
	removeLanguages.clear();
	languagesOpen = null;
	byId("repair-audit-languages").innerHTML = "";
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
		const tracks = groupFiles()[0]?.tracks || [];
		groupSubtitles = tracks.filter((track) => track.type === "subtitles").map(subtitleMetadata);
		groupAudio = tracks.filter((track) => track.type === "audio").map(audioMetadata);
		originalSubtitles = JSON.stringify(groupSubtitles);
		originalAudio = JSON.stringify(groupAudio);
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
	const input = event.target;
	const { auditKind, auditTrack, auditField } = input.dataset;
	if (auditTrack === undefined || !auditField) return;
	const index = Number(auditTrack);
	if (auditKind === "audio") {
		const track = groupAudio[index];
		if (!track) return;
		if (auditField === "title" || auditField === "language") track[auditField] = input.value;
		else {
			const flag = audioFlags.find(([field]) => field === auditField)?.[0];
			if (!flag) return;
			track[flag] = input.checked;
		}
	} else {
		const track = groupSubtitles[index];
		if (!track) return;
		if (auditField === "title" || auditField === "language") track[auditField] = input.value;
		else {
			const flag = subtitleFlags.find(([field]) => field === auditField)?.[0];
			if (!flag) return;
			track[flag] = input.checked;
		}
	}
	const edited = groupEdited();
	buttonById("repair-audit-group-queue").disabled = !edited.audio && !edited.subtitles;
}

async function queueAuditGroup(): Promise<void> {
	const files = groupFiles();
	const edited = groupEdited();
	if (queueingGroup || !files.length || (!edited.audio && !edited.subtitles)) return;
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
			...(edited.audio ? { audio: groupAudio } : {}),
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
