import type { RepairInspection, RepairSubtitleTrack, RepairSubtitleTrackPlan, RepairTrackSource } from "../types";
import type { LibraryEntry } from "../ui/models";
import { createRepairJob, fetchRepairBrowse, fetchRepairInspection, fetchRepairReplacePlan, fetchRepairRoots } from "../api/client";
import { buttonById, byId, inputById } from "../shared/dom";
import { errorMessage } from "../shared/errors";
import { humanFileSize } from "./library";
import { update } from "./polling";

interface EditableTrack extends RepairSubtitleTrackPlan {
	codec: string;
	canRabbitProcess: boolean;
	currentCompression: "none" | "zlib";
}

let inspection: RepairInspection | null = null;
let editableTracks: EditableTrack[] = [];
let sourceTracks: EditableTrack[] = [];
let selectedTargetPath = "";
let selectedSourcePath = "";

type PickerPurpose = "target" | "source" | "folder" | "subtitle-editor";
interface PickerNode extends LibraryEntry {
	depth: number;
	parentPath: string | null;
	expanded: boolean;
	loading: boolean;
	children: string[] | null;
}
let pickerPurpose: PickerPurpose = "target";
let pickerSelectedPath = "";
let pickerRoots: string[] = [];
const pickerNodes = new Map<string, PickerNode>();
let pickerFolderCallback: ((path: string) => void | Promise<void>) | null = null;
let pickerFileCallback: ((path: string) => void | Promise<void>) | null = null;

const escapeHtml = (value: unknown): string =>
	String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");

// Use the same folder artwork as the Library modal's tree and search rows.
const pickerFolderIcon = `<svg class="tree-icon tree-icon-folder" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
	<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
</svg>`;

function keyFor(source: RepairTrackSource, trackId: number): string {
	return `${source}:${trackId}`;
}

function fromInspection(source: RepairTrackSource, track: RepairSubtitleTrack, order: number): EditableTrack {
	return {
		source,
		trackId: track.id,
		mode: "copy",
		order,
		title: track.title,
		language: track.language,
		compression: "preserve",
		isDefault: track.isDefault,
		isForced: track.isForced,
		isEnabled: track.isEnabled,
		isHearingImpaired: track.isHearingImpaired,
		isOriginal: track.isOriginal,
		isCommentary: track.isCommentary,
		codec: track.codec,
		canRabbitProcess: track.canRabbitProcess,
		currentCompression: track.currentCompression,
	};
}

function setError(message: string): void {
	const error = byId("repair-error");
	error.textContent = message;
	error.style.display = message ? "" : "none";
}

function selectedFileHtml(path: string, emptyLabel: string): string {
	if (!path) return `<span class="repair-file-empty">${emptyLabel}</span>`;
	const slash = path.lastIndexOf("/");
	const name = slash >= 0 ? path.slice(slash + 1) : path;
	const folder = slash > 0 ? path.slice(0, slash) : "";
	return `<span class="repair-file-name" title="${escapeHtml(path)}">${escapeHtml(name)}</span><span class="repair-file-folder">${escapeHtml(folder)}</span>`;
}

function renderSelectedFiles(): void {
	byId("repair-target-selection").innerHTML = selectedFileHtml(selectedTargetPath, "No encoded target selected");
	byId("repair-source-selection").innerHTML = selectedFileHtml(selectedSourcePath, "No original source selected");
	buttonById("repair-clear-source-btn").style.display = selectedSourcePath ? "" : "none";
	buttonById("repair-inspect-btn").disabled = !selectedTargetPath;
}

function invalidateInspection(): void {
	inspection = null;
	editableTracks = [];
	sourceTracks = [];
	byId("repair-editor").style.display = "none";
	buttonById("repair-queue-btn").disabled = true;
	setError("");
}

function flagCheckbox(key: string, field: keyof EditableTrack, label: string, checked: boolean): string {
	return `<label class="repair-flag"><input type="checkbox" data-field="${field}" data-key="${key}" ${checked ? "checked" : ""}> ${label}</label>`;
}

function renderTrack(track: EditableTrack, index: number): string {
	const key = keyFor(track.source, track.trackId);
	const sourceLabel = track.source === "target" ? "Encoded" : "Source";
	return `<div class="repair-track" data-key="${key}">
		<div class="repair-track-head">
			<span class="sub-track-id">${sourceLabel} #${track.trackId}</span>
			<span class="repair-codec">${escapeHtml(track.codec)} (${track.currentCompression})</span>
			<div class="repair-order">
				<button class="btn btn-ghost btn-sm" type="button" data-repair-move="up" data-key="${key}" ${index === 0 ? "disabled" : ""}>↑</button>
				<button class="btn btn-ghost btn-sm" type="button" data-repair-move="down" data-key="${key}" ${index === editableTracks.length - 1 ? "disabled" : ""}>↓</button>
				<button class="btn btn-ghost btn-sm repair-remove-track" type="button" data-repair-remove="${key}">Remove</button>
			</div>
		</div>
		<div class="repair-track-fields">
			<label>Title<input class="repair-input" data-field="title" data-key="${key}" value="${escapeHtml(track.title)}" maxlength="512"></label>
			<label>Language<input class="repair-input repair-language" data-field="language" data-key="${key}" value="${escapeHtml(track.language)}" maxlength="35"></label>
			<label>Handling<select class="select-input" data-field="mode" data-key="${key}">
				<option value="copy" ${track.mode === "copy" ? "selected" : ""}>Copy unchanged</option>
				<option value="rabbit" ${track.mode === "rabbit" ? "selected" : ""} ${track.canRabbitProcess ? "" : "disabled"}>Rabbit defaults</option>
			</select></label>
			<label>Compression<select class="select-input" data-field="compression" data-key="${key}">
				<option value="preserve" ${track.compression === "preserve" ? "selected" : ""}>Preserve (${track.currentCompression})</option>
				<option value="auto" ${track.compression === "auto" ? "selected" : ""}>Auto (only if it saves space)</option>
				<option value="none" ${track.compression === "none" ? "selected" : ""}>None</option>
				<option value="zlib" ${track.compression === "zlib" ? "selected" : ""}>zlib</option>
			</select></label>
		</div>
		<div class="repair-flags">
			${flagCheckbox(key, "isDefault", "Default", track.isDefault)}
			${flagCheckbox(key, "isForced", "Forced", track.isForced)}
			${flagCheckbox(key, "isEnabled", "Enabled", track.isEnabled)}
			${flagCheckbox(key, "isHearingImpaired", "HI", track.isHearingImpaired)}
			${flagCheckbox(key, "isOriginal", "Original", track.isOriginal)}
			${flagCheckbox(key, "isCommentary", "Commentary", track.isCommentary)}
		</div>
	</div>`;
}

function renderSourceTrack(track: EditableTrack): string {
	const key = keyFor(track.source, track.trackId);
	const flags = [
		track.isDefault ? "Default" : "",
		track.isForced ? "Forced" : "",
		track.isHearingImpaired ? "HI" : "",
		track.isOriginal ? "Original" : "",
		track.isCommentary ? "Commentary" : "",
	].filter(Boolean);
	return `<div class="repair-track repair-source-track" data-key="${key}">
		<div class="repair-track-head">
			<span class="sub-track-id">Source #${track.trackId}</span>
			<span class="repair-codec">${escapeHtml(track.codec)} (${track.currentCompression})</span>
			<button class="btn btn-primary btn-sm repair-add-track" type="button" data-repair-add="${key}">Add →</button>
		</div>
		<div class="repair-source-title">${escapeHtml(track.title || "Untitled subtitle")}</div>
		<div class="repair-source-meta">
			<span>${escapeHtml(track.language || "und")}</span>
			${flags.map((flag) => `<span>${escapeHtml(flag)}</span>`).join("")}
		</div>
	</div>`;
}

function normalizeTrackOrder(): void {
	editableTracks.forEach((track, order) => {
		track.order = order;
	});
}

function renderTracks(): void {
	const addedKeys = new Set(editableTracks.map((track) => keyFor(track.source, track.trackId)));
	const availableSourceTracks = sourceTracks.filter((track) => !addedKeys.has(keyFor(track.source, track.trackId)));
	byId("repair-source-tracks").innerHTML = !inspection?.source
		? '<div class="repair-empty">Choose an original source and inspect the files to import its subtitles.</div>'
		: !sourceTracks.length
			? '<div class="repair-empty">The selected source has no text subtitle tracks.</div>'
			: availableSourceTracks.length
				? availableSourceTracks.map(renderSourceTrack).join("")
				: '<div class="repair-empty repair-empty-success">All source subtitle tracks have been added.</div>';
	byId("repair-tracks").innerHTML = editableTracks.length
		? editableTracks.map(renderTrack).join("")
		: '<div class="repair-empty">No output subtitles. Queueing this plan will remove every subtitle from the encoded target.</div>';
	byId("repair-source-count").textContent = inspection?.source ? `${availableSourceTracks.length} of ${sourceTracks.length} available` : "No source selected";
	buttonById("repair-add-all-btn").disabled = availableSourceTracks.length === 0;
	buttonById("repair-replace-btn").disabled = !inspection?.source || sourceTracks.length === 0;
	byId("repair-output-count").textContent = `${editableTracks.length} track${editableTracks.length === 1 ? "" : "s"}`;
	byId("repair-editor").style.display = "";
}

function loadInspection(data: RepairInspection): void {
	inspection = data;
	selectedTargetPath = data.target.path;
	selectedSourcePath = data.source?.path || "";
	renderSelectedFiles();
	editableTracks = data.target.subtitles.map((track, index) => fromInspection("target", track, index));
	sourceTracks = (data.source?.subtitles || []).map((track, index) => fromInspection("source", track, index));
	renderTracks();
	buttonById("repair-queue-btn").disabled = false;
}

export async function inspectRepairPaths(jobId?: string): Promise<void> {
	setError("");
	const button = buttonById("repair-inspect-btn");
	button.disabled = true;
	button.textContent = "Inspecting...";
	byId("repair-editor").style.display = "none";
	try {
		const data = await fetchRepairInspection(
			jobId
				? { jobId }
				: {
						targetPath: selectedTargetPath,
						sourcePath: selectedSourcePath || undefined,
					},
		);
		loadInspection(data);
	} catch (error) {
		inspection = null;
		editableTracks = [];
		sourceTracks = [];
		buttonById("repair-queue-btn").disabled = true;
		setError(errorMessage(error));
	} finally {
		button.disabled = !selectedTargetPath;
		button.textContent = "Inspect selected files";
	}
}

export async function openRepair(jobId?: string): Promise<void> {
	inspection = null;
	editableTracks = [];
	sourceTracks = [];
	selectedTargetPath = "";
	selectedSourcePath = "";
	byId<HTMLSelectElement>("repair-save-mode").value = "existing";
	byId("repair-editor").style.display = "none";
	buttonById("repair-queue-btn").disabled = true;
	setError("");
	renderSelectedFiles();
	byId("repair-modal").style.display = "";
	if (jobId) await inspectRepairPaths(jobId);
}

export async function openRepairPaths(targetPath: string, sourcePath?: string): Promise<void> {
	inspection = null;
	editableTracks = [];
	sourceTracks = [];
	selectedTargetPath = targetPath;
	selectedSourcePath = sourcePath || "";
	byId<HTMLSelectElement>("repair-save-mode").value = "existing";
	byId("repair-editor").style.display = "none";
	buttonById("repair-queue-btn").disabled = true;
	setError("");
	renderSelectedFiles();
	byId("repair-modal").style.display = "";
	await inspectRepairPaths();
}

export function closeRepair(): void {
	byId("repair-modal").style.display = "none";
}

export function closeRepairIfOutside(event: MouseEvent): void {
	if (event.target === event.currentTarget) closeRepair();
}

function renderPickerNode(node: PickerNode): string {
	if (node.type === "file") {
		if (pickerPurpose === "folder") {
			return `<div class="tree-node tree-file repair-picker-file is-folder-context">
				<div class="tree-row" style="padding-left:${node.depth * 24 + 40}px">
					<svg class="tree-icon tree-icon-file" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
					<span class="tree-name tree-name-file" title="${escapeHtml(node.path)}">${escapeHtml(node.name)}</span>
					<span class="tree-meta">${node.size ? humanFileSize(node.size) : "MKV"}</span>
				</div>
			</div>`;
		}
		const selected = node.path === pickerSelectedPath ? " is-selected" : "";
		return `<div class="tree-node tree-file repair-picker-file${selected}" data-picker-action="select" data-path="${escapeHtml(node.path)}">
			<div class="tree-row" style="padding-left:${node.depth * 24 + 40}px">
				<svg class="tree-icon tree-icon-file" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
				<span class="tree-name tree-name-file" title="${escapeHtml(node.path)}">${escapeHtml(node.name)}</span>
				<span class="tree-meta">${node.size ? humanFileSize(node.size) : "MKV"}</span>
			</div>
		</div>`;
	}
	let children = "";
	if (node.loading) children = `<div class="tree-loading" style="padding-left:${node.depth * 24 + 56}px">Loading...</div>`;
	else if (node.expanded && node.children) {
		children = node.children
			.map((path) => pickerNodes.get(path))
			.filter((child): child is PickerNode => !!child)
			.map(renderPickerNode)
			.join("");
		if (!children) children = `<div class="tree-empty" style="padding-left:${node.depth * 24 + 56}px">No MKV files</div>`;
	}
	const selected = pickerPurpose === "folder" && node.path === pickerSelectedPath ? " is-selected" : "";
	const chooseFolder =
		pickerPurpose === "folder"
			? `<button class="btn btn-ghost btn-sm repair-picker-use-folder" type="button" data-picker-action="select-folder" data-path="${escapeHtml(node.path)}">Select folder</button>`
			: "";
	return `<div class="tree-node tree-folder${selected}">
		<div class="tree-row" style="padding-left:${node.depth * 24}px" data-picker-action="expand" data-path="${escapeHtml(node.path)}">
			<button class="tree-chevron ${node.expanded ? "expanded" : ""}" type="button"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></button>
			${pickerFolderIcon}
			<span class="tree-name" title="${escapeHtml(node.path)}">${escapeHtml(node.name)}</span>${chooseFolder}
		</div>${children}
	</div>`;
}

function renderPickerSearchResult(node: PickerNode): string {
	if (node.type === "file") return renderPickerNode({ ...node, depth: 0 });
	return `<div class="tree-node tree-folder repair-picker-folder-result" data-picker-action="open-folder" data-path="${escapeHtml(node.path)}">
		<div class="tree-row" style="padding-left:16px">
			${pickerFolderIcon}
			<span class="tree-name" title="${escapeHtml(node.path)}">${escapeHtml(node.name)}</span>
			<span class="tree-meta">Folder</span>
		</div>
	</div>`;
}

function renderPicker(): void {
	const query = inputById("repair-picker-search").value.trim().toLowerCase();
	if (query) {
		const matches = [...pickerNodes.values()]
			.filter((node) => (pickerPurpose !== "folder" || node.type === "directory") && node.name.toLowerCase().includes(query))
			.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === "directory" ? -1 : 1));
		byId("repair-picker-content").innerHTML = matches.length
			? matches.map((node) => `<div class="repair-picker-search-result">${renderPickerSearchResult(node)}</div>`).join("")
			: `<div class="library-empty">No loaded ${pickerPurpose === "folder" ? "folders" : "folders or MKV files"} match. Expand folders to load more entries.</div>`;
	} else {
		byId("repair-picker-content").innerHTML = pickerRoots
			.map((path) => pickerNodes.get(path))
			.filter((node): node is PickerNode => !!node)
			.map(renderPickerNode)
			.join("");
	}
	byId("repair-picker-note").textContent = pickerSelectedPath || (pickerPurpose === "folder" ? "Select one folder" : "Select one MKV file");
	buttonById("repair-picker-choose-btn").disabled = !pickerSelectedPath;
}

async function togglePickerFolder(path: string): Promise<void> {
	const node = pickerNodes.get(path);
	if (!node || node.type !== "directory") return;
	if (node.expanded) {
		node.expanded = false;
		renderPicker();
		return;
	}
	if (node.children === null) {
		node.loading = true;
		renderPicker();
		try {
			const entries = await fetchRepairBrowse(node.path);
			node.children = entries.map((entry) => {
				pickerNodes.set(entry.path, {
					...entry,
					depth: node.depth + 1,
					parentPath: node.path,
					expanded: false,
					loading: false,
					children: entry.type === "directory" ? null : [],
				});
				return entry.path;
			});
		} catch (error) {
			node.children = [];
			byId("repair-picker-error").textContent = errorMessage(error);
			byId("repair-picker-error").style.display = "";
		} finally {
			node.loading = false;
		}
	}
	node.expanded = true;
	renderPicker();
}

async function openPickerFolderFromSearch(path: string): Promise<void> {
	const node = pickerNodes.get(path);
	if (!node || node.type !== "directory") return;
	inputById("repair-picker-search").value = "";
	let parentPath = node.parentPath;
	while (parentPath) {
		const parent = pickerNodes.get(parentPath);
		if (!parent) break;
		parent.expanded = true;
		parentPath = parent.parentPath;
	}
	if (!node.expanded) await togglePickerFolder(path);
	else renderPicker();
	requestAnimationFrame(() => scrollPickerNodeIntoView(path));
}

function scrollPickerNodeIntoView(path: string): void {
	const content = byId("repair-picker-content");
	let row: HTMLElement | null = null;
	for (const candidate of Array.from(content.querySelectorAll<HTMLElement>('.tree-folder > .tree-row[data-picker-action="expand"]'))) {
		if (candidate.dataset.path === path) {
			row = candidate;
			break;
		}
	}
	if (!row) return;
	row.scrollIntoView({ block: "center", behavior: "smooth" });
	row.classList.add("tree-row-flash");
	setTimeout(() => row?.classList.remove("tree-row-flash"), 1200);
}

export async function openRepairPicker(purpose: PickerPurpose): Promise<void> {
	pickerPurpose = purpose;
	pickerSelectedPath = purpose === "target" ? selectedTargetPath : purpose === "source" ? selectedSourcePath : "";
	pickerRoots = [];
	pickerNodes.clear();
	inputById("repair-picker-search").value = "";
	byId("repair-picker-title").textContent =
		purpose === "target"
			? "Choose encoded target"
			: purpose === "source"
				? "Choose original subtitle source"
				: purpose === "subtitle-editor"
					? "Choose MKV to edit subtitles"
					: "Choose folder to audit";
	inputById("repair-picker-search").placeholder = purpose === "folder" ? "Filter loaded folders..." : "Filter loaded folders and MKV files...";
	byId("repair-picker-error").style.display = "none";
	byId("repair-picker-content").innerHTML = '<div class="library-loading">Loading media folders...</div>';
	byId("repair-picker-modal").style.display = "";
	try {
		const roots = await fetchRepairRoots();
		for (const root of roots) {
			pickerRoots.push(root.path);
			pickerNodes.set(root.path, { ...root, type: "directory", depth: 0, parentPath: null, expanded: false, loading: false, children: null });
		}
		if (roots.length) {
			renderPicker();
			const preferred =
				purpose === "target"
					? roots.find((root) => root.name.startsWith("Output")) || roots[0]
					: purpose === "source"
						? roots.find((root) => root.name.startsWith("Input")) || roots.find((root) => root.name.startsWith("Library")) || roots[0]
						: roots.find((root) => root.name.startsWith("Output")) || roots.find((root) => root.name.startsWith("Library")) || roots[0];
			if (preferred) await togglePickerFolder(preferred.path);
		} else byId("repair-picker-content").innerHTML = '<div class="library-empty">No input, output, or library folders are available.</div>';
	} catch (error) {
		byId("repair-picker-content").innerHTML = `<div class="library-empty">${escapeHtml(errorMessage(error))}</div>`;
	}
}

export function openRepairFolderPicker(onChoose: (path: string) => void | Promise<void>): void {
	pickerFolderCallback = onChoose;
	void openRepairPicker("folder");
}

export function openSubtitleFilePicker(onChoose: (path: string) => void | Promise<void>): void {
	pickerFileCallback = onChoose;
	void openRepairPicker("subtitle-editor");
}

export function closeRepairPicker(): void {
	byId("repair-picker-modal").style.display = "none";
	pickerFileCallback = null;
}

export function closeRepairPickerIfOutside(event: MouseEvent): void {
	if (event.target === event.currentTarget) closeRepairPicker();
}

export function handleRepairPickerClick(event: MouseEvent): void {
	const action = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-picker-action]") : null;
	if (!action?.dataset.path) return;
	if (action.dataset.pickerAction === "expand") void togglePickerFolder(action.dataset.path);
	else if (action.dataset.pickerAction === "open-folder") void openPickerFolderFromSearch(action.dataset.path);
	else if (action.dataset.pickerAction === "select-folder") {
		event.stopPropagation();
		pickerSelectedPath = action.dataset.path;
		renderPicker();
	} else if (action.dataset.pickerAction === "select") {
		pickerSelectedPath = action.dataset.path;
		renderPicker();
	}
}

export function filterRepairPicker(): void {
	renderPicker();
}

export function chooseRepairPickerFile(): void {
	if (!pickerSelectedPath) return;
	if (pickerPurpose === "subtitle-editor") {
		const callback = pickerFileCallback;
		closeRepairPicker();
		if (callback) void callback(pickerSelectedPath);
		return;
	}
	if (pickerPurpose === "folder") {
		const callback = pickerFolderCallback;
		pickerFolderCallback = null;
		closeRepairPicker();
		if (callback) void callback(pickerSelectedPath);
		return;
	}
	if (pickerPurpose === "target") selectedTargetPath = pickerSelectedPath;
	else selectedSourcePath = pickerSelectedPath;
	invalidateInspection();
	renderSelectedFiles();
	closeRepairPicker();
}

export function clearRepairSource(): void {
	selectedSourcePath = "";
	invalidateInspection();
	renderSelectedFiles();
}

function findEditable(key: string): EditableTrack | undefined {
	return editableTracks.find((track) => keyFor(track.source, track.trackId) === key);
}

export function handleRepairEditorInput(event: Event): void {
	const element = event.target;
	if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement)) return;
	const key = element.dataset.key;
	const field = element.dataset.field as keyof EditableTrack | undefined;
	if (!key || !field) return;
	const track = findEditable(key);
	if (!track) return;
	if (element instanceof HTMLInputElement && element.type === "checkbox") (track as any)[field] = element.checked;
	else (track as any)[field] = element.value;
}

export function handleRepairTrackMove(event: MouseEvent): void {
	const element =
		event.target instanceof Element
			? event.target.closest<HTMLElement>("[data-repair-add-all], [data-repair-add], [data-repair-remove], [data-repair-move]")
			: null;
	if (!element) return;

	if (element.hasAttribute("data-repair-add-all")) {
		const addedKeys = new Set(editableTracks.map((track) => keyFor(track.source, track.trackId)));
		for (const track of sourceTracks) {
			if (!addedKeys.has(keyFor(track.source, track.trackId))) editableTracks.push({ ...track, order: editableTracks.length });
		}
	} else if (element.dataset.repairAdd) {
		const sourceTrack = sourceTracks.find((track) => keyFor(track.source, track.trackId) === element.dataset.repairAdd);
		if (!sourceTrack) return;
		editableTracks.push({ ...sourceTrack, order: editableTracks.length });
	} else if (element.dataset.repairRemove) {
		const index = editableTracks.findIndex((track) => keyFor(track.source, track.trackId) === element.dataset.repairRemove);
		if (index < 0) return;
		editableTracks.splice(index, 1);
	} else {
		const index = editableTracks.findIndex((track) => keyFor(track.source, track.trackId) === element.dataset.key);
		const next = element.dataset.repairMove === "up" ? index - 1 : index + 1;
		if (index < 0 || next < 0 || next >= editableTracks.length) return;
		[editableTracks[index], editableTracks[next]] = [editableTracks[next]!, editableTracks[index]!];
	}
	normalizeTrackOrder();
	renderTracks();
}

/**
 * Drop the encode's subtitles and rebuild the output list from the source,
 * named, ordered and flagged the way an encode would. The plan is loaded into
 * the editor rather than queued, so it can still be reviewed and adjusted.
 */
export async function replaceSubtitlesFromSource(): Promise<void> {
	if (!inspection?.source) {
		setError("Choose an original source and inspect the files first.");
		return;
	}
	setError("");
	const button = buttonById("repair-replace-btn");
	button.disabled = true;
	button.textContent = "Building plan...";
	try {
		const plan = await fetchRepairReplacePlan({
			targetPath: inspection.target.path,
			sourcePath: inspection.source.path,
			replaceTarget: byId<HTMLSelectElement>("repair-save-mode").value === "existing",
		});
		const byTrackId = new Map(sourceTracks.map((track) => [track.trackId, track]));
		editableTracks = plan.tracks.map((track, order) => {
			const known = byTrackId.get(track.trackId);
			return {
				...track,
				order,
				mode: track.mode === "rabbit" && known && !known.canRabbitProcess ? "copy" : track.mode,
				codec: known?.codec || "",
				canRabbitProcess: known?.canRabbitProcess ?? false,
				currentCompression: known?.currentCompression ?? "none",
			};
		});
		normalizeTrackOrder();
		renderTracks();
	} catch (error) {
		setError(errorMessage(error));
	} finally {
		button.disabled = !inspection?.source;
		button.textContent = "Replace from source";
	}
}

export async function queueRepair(): Promise<void> {
	if (!inspection) {
		setError("Inspect the files before queueing a repair.");
		return;
	}
	if (selectedTargetPath !== inspection.target.path || selectedSourcePath !== (inspection.source?.path || "")) {
		setError("Paths changed after inspection. Inspect the files again before queueing.");
		return;
	}
	setError("");
	const button = buttonById("repair-queue-btn");
	button.disabled = true;
	button.textContent = "Queueing...";
	try {
		const tracks = editableTracks.map(({ codec: _codec, canRabbitProcess: _canProcess, currentCompression: _currentCompression, ...track }, order) => ({
			...track,
			order,
		}));
		await createRepairJob({
			targetPath: inspection.target.path,
			sourcePath: inspection.source?.path,
			replaceTarget: byId<HTMLSelectElement>("repair-save-mode").value === "existing",
			tracks,
		});
		closeRepair();
		await update();
	} catch (error) {
		setError(errorMessage(error));
	} finally {
		button.disabled = false;
		button.textContent = "Queue repair";
	}
}
