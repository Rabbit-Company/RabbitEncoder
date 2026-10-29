import type { RepairBatchPairing, RepairLayoutSourceTrack, RepairLayoutTrackPlan, RepairPairSuggestion, RepairSourceLayout } from "../types";
import { createRepairBatchJobs, fetchRepairBatchLayouts, fetchRepairBatchPairing, fetchRepairBatchSuggestion } from "../api/client";
import { buttonById, byId } from "../shared/dom";
import { errorMessage } from "../shared/errors";
import { openRepairFolderPicker } from "./repair";
import { update } from "./polling";

/** A row of the mapping table. `sourcePath` empty means "skip this encode". */
interface PairRow extends RepairPairSuggestion {
	edited: boolean;
}

/** A source layout and the output tracks chosen for it. */
interface LayoutState {
	layout: RepairSourceLayout;
	tracks: RepairLayoutTrackPlan[];
	note: string;
	/** What the subtitle workflow would build for the first source, null while it is being built. */
	suggestion: RepairLayoutTrackPlan[] | null;
	suggestionError: string;
	/** Set once the user changes the tracks, so a late suggestion does not overwrite them. */
	touched: boolean;
}

let targetDir = "";
let sourceDir = "";
let rows: PairRow[] = [];
let sourceChoices: { path: string; name: string }[] = [];
let layouts: LayoutState[] = [];
/** The pairs the layouts were read for. Any other pairing makes them stale. */
let layoutsKey = "";
let readingLayouts = false;
/** Bumped on every read, so suggestions for layouts that were replaced are dropped. */
let layoutsGeneration = 0;

const escapeHtml = (value: unknown): string =>
	String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");

const fileName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

function setError(message: string): void {
	const error = byId("repair-batch-error");
	error.textContent = message;
	error.style.display = message ? "" : "none";
}

function renderFolders(): void {
	byId("repair-batch-target-selection").innerHTML = targetDir
		? `<span class="repair-file-name" title="${escapeHtml(targetDir)}">${escapeHtml(fileName(targetDir))}</span><span class="repair-file-folder">${escapeHtml(targetDir)}</span>`
		: '<span class="repair-file-empty">No encodes folder selected</span>';
	byId("repair-batch-source-selection").innerHTML = sourceDir
		? `<span class="repair-file-name" title="${escapeHtml(sourceDir)}">${escapeHtml(fileName(sourceDir))}</span><span class="repair-file-folder">${escapeHtml(sourceDir)}</span>`
		: '<span class="repair-file-empty">No sources folder selected</span>';
	buttonById("repair-batch-pair-btn").disabled = !targetDir || !sourceDir;
}

/** Sources used by more than one row - always a mistake worth showing. */
function duplicateSourcePaths(): Set<string> {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const row of rows) {
		if (!row.sourcePath) continue;
		if (seen.has(row.sourcePath)) duplicates.add(row.sourcePath);
		seen.add(row.sourcePath);
	}
	return duplicates;
}

function methodLabel(row: PairRow): string {
	if (row.edited) return '<span class="repair-pair-method repair-pair-edited">Chosen by you</span>';
	if (row.method === "episode") return '<span class="repair-pair-method">Episode number</span>';
	if (row.method === "order") return '<span class="repair-pair-method repair-pair-weak">Filename order</span>';
	return '<span class="repair-pair-method repair-pair-none">No match</span>';
}

function renderRow(row: PairRow, index: number, duplicates: Set<string>): string {
	const options = [
		`<option value="" ${row.sourcePath ? "" : "selected"}>Skip this encode</option>`,
		...sourceChoices.map(
			(choice) => `<option value="${escapeHtml(choice.path)}" ${choice.path === row.sourcePath ? "selected" : ""}>${escapeHtml(choice.name)}</option>`,
		),
	].join("");
	const warning = duplicates.has(row.sourcePath)
		? '<div class="repair-pair-warning">This source is paired with more than one encode.</div>'
		: !row.sourcePath
			? '<div class="repair-pair-warning">Skipped — this encode keeps its current subtitles.</div>'
			: "";
	return `<div class="repair-pair-row${row.sourcePath ? "" : " repair-pair-row-skipped"}">
		<div class="repair-pair-target">
			<span class="repair-file-name">${escapeHtml(row.targetName)}</span>
			${methodLabel(row)}
		</div>
		<div class="repair-pair-arrow" aria-hidden="true">←</div>
		<div class="repair-pair-source">
			<select class="select-input" data-pair-index="${index}">${options}</select>
			${warning}
		</div>
	</div>`;
}

function renderPairs(): void {
	const duplicates = duplicateSourcePaths();
	const paired = rows.filter((row) => row.sourcePath).length;
	const unresolved = rows.length - paired;

	byId("repair-batch-pairs").innerHTML = rows.length
		? rows.map((row, index) => renderRow(row, index, duplicates)).join("")
		: '<div class="repair-empty">Choose both folders and pair them to see the mapping.</div>';

	const parts = [`${paired} of ${rows.length} encode${rows.length === 1 ? "" : "s"} paired`];
	if (unresolved) parts.push(`${unresolved} skipped`);
	if (duplicates.size) parts.push(`${duplicates.size} source${duplicates.size === 1 ? "" : "s"} used twice`);
	byId("repair-batch-summary").textContent = rows.length ? parts.join(" | ") : "";

	buttonById("repair-batch-queue-btn").textContent = paired ? `Queue ${paired} replacement${paired === 1 ? "" : "s"}` : "Queue replacements";
	renderMode();
}

const pairedRows = () => rows.filter((row) => row.sourcePath).map((row) => ({ targetPath: row.targetPath, sourcePath: row.sourcePath }));
const pairsKey = () => JSON.stringify(pairedRows());
const choosingTracks = () => byId<HTMLSelectElement>("repair-batch-mode").value === "layouts";
const layoutsFresh = () => layouts.length > 0 && layoutsKey === pairsKey();

function renderMode(): void {
	const paired = pairedRows().length;
	const choosing = choosingTracks();
	const layoutsButton = buttonById("repair-batch-layouts-btn");
	layoutsButton.style.display = choosing ? "" : "none";
	layoutsButton.disabled = paired === 0 || readingLayouts;
	layoutsButton.textContent = readingLayouts ? "Reading layouts..." : layouts.length ? "Read layouts again" : "Read subtitle layouts";
	byId("repair-batch-mode-note").textContent = !choosing
		? "Each source is named, ordered and filtered by the subtitle settings when its job runs."
		: !layouts.length
			? "Sources with the same subtitle tracks share a layout. You pick the output tracks once for each layout."
			: layoutsFresh()
				? `${layouts.length} layout${layouts.length === 1 ? "" : "s"} across ${paired} source${paired === 1 ? "" : "s"}.`
				: "The pairs changed since the layouts were read. Read them again.";
	byId("repair-batch-layouts").style.display = choosing && layouts.length ? "" : "none";
	buttonById("repair-batch-queue-btn").disabled = paired === 0 || duplicateSourcePaths().size > 0 || (choosing && !layoutsFresh());
}

const trackLabel = (track: RepairLayoutSourceTrack): string => `#${track.id} ${track.title || "Untitled"} (${track.codec}, ${track.language})`;

function renderSourceTrack(track: RepairLayoutSourceTrack, layoutIndex: number, used: boolean): string {
	const flags = [
		track.isDefault ? "Default" : "",
		track.isForced ? "Forced" : "",
		track.isHearingImpaired ? "HI" : "",
		track.isCommentary ? "Commentary" : "",
	].filter(Boolean);
	return `<div class="repair-track repair-source-track">
		<div class="repair-track-head">
			<span class="sub-track-id">Source #${track.id}</span>
			<span class="repair-codec">${escapeHtml(track.codec)}</span>
			<button class="btn btn-primary btn-sm repair-add-track" type="button" data-layout-add="${track.position}" data-layout="${layoutIndex}" ${used ? "disabled" : ""}>${used ? "Added" : "Add →"}</button>
		</div>
		<div class="repair-source-title">${escapeHtml(track.title || "Untitled subtitle")}</div>
		<div class="repair-source-meta">
			<span>${escapeHtml(track.language || "und")}</span>
			${flags.map((flag) => `<span>${escapeHtml(flag)}</span>`).join("")}
		</div>
	</div>`;
}

function renderOutputTrack(state: LayoutState, layoutIndex: number, index: number): string {
	const track = state.tracks[index]!;
	const source = state.layout.tracks[track.position];
	const usedElsewhere = new Set(state.tracks.filter((_, other) => other !== index).map((other) => other.position));
	const attrs = `data-layout="${layoutIndex}" data-row="${index}"`;
	const flag = (field: keyof RepairLayoutTrackPlan, label: string) =>
		`<label class="repair-flag"><input type="checkbox" data-field="${field}" ${attrs} ${track[field] ? "checked" : ""}> ${label}</label>`;
	return `<div class="repair-track">
		<div class="repair-track-head">
			<select class="select-input repair-layout-source" data-field="position" ${attrs} title="The source subtitle this track is made from">
				${state.layout.tracks
					.map(
						(choice) =>
							`<option value="${choice.position}" ${choice.position === track.position ? "selected" : ""} ${usedElsewhere.has(choice.position) ? "disabled" : ""}>${escapeHtml(trackLabel(choice))}</option>`,
					)
					.join("")}
			</select>
			<div class="repair-order">
				<button class="btn btn-ghost btn-sm" type="button" data-layout-move="up" ${attrs} ${index === 0 ? "disabled" : ""}>↑</button>
				<button class="btn btn-ghost btn-sm" type="button" data-layout-move="down" ${attrs} ${index === state.tracks.length - 1 ? "disabled" : ""}>↓</button>
				<button class="btn btn-ghost btn-sm repair-remove-track" type="button" data-layout-remove ${attrs}>Remove</button>
			</div>
		</div>
		<div class="repair-track-fields">
			<label>Title<input class="repair-input" data-field="title" ${attrs} value="${escapeHtml(track.title)}" maxlength="512"></label>
			<label>Language<input class="repair-input repair-language" data-field="language" ${attrs} value="${escapeHtml(track.language)}" maxlength="35"></label>
			<label>Handling<select class="select-input" data-field="mode" ${attrs}>
				<option value="copy" ${track.mode === "copy" ? "selected" : ""}>Copy unchanged</option>
				<option value="rabbit" ${track.mode === "rabbit" ? "selected" : ""} ${source?.canRabbitProcess ? "" : "disabled"}>Rabbit defaults</option>
			</select></label>
			<label>Compression<select class="select-input" data-field="compression" ${attrs}>
				<option value="preserve" ${track.compression === "preserve" ? "selected" : ""}>Preserve (${source?.currentCompression || "none"})</option>
				<option value="auto" ${track.compression === "auto" ? "selected" : ""}>Auto (only if it saves space)</option>
				<option value="none" ${track.compression === "none" ? "selected" : ""}>None</option>
				<option value="zlib" ${track.compression === "zlib" ? "selected" : ""}>zlib</option>
			</select></label>
		</div>
		<div class="repair-flags">
			${flag("isDefault", "Default")}
			${flag("isForced", "Forced")}
			${flag("isEnabled", "Enabled")}
			${flag("isHearingImpaired", "HI")}
			${flag("isOriginal", "Original")}
			${flag("isCommentary", "Commentary")}
		</div>
	</div>`;
}

function renderLayout(state: LayoutState, layoutIndex: number): string {
	const { layout } = state;
	const used = new Set(state.tracks.map((track) => track.position));
	const names = layout.sourcePaths.map(fileName);
	const copyButtons = layouts
		.filter((_, other) => other !== layoutIndex)
		.map(
			(other) =>
				`<button class="btn btn-ghost btn-sm" type="button" data-layout-copy="${layouts.indexOf(other)}" data-layout="${layoutIndex}" title="Pick the same tracks as layout ${other.layout.label}, matched by title and release group">Copy layout ${other.layout.label}</button>`,
		)
		.join("");
	const building = state.suggestion === null && !state.suggestionError;
	const notes = [
		state.suggestionError ? `Rabbit could not suggest tracks: ${state.suggestionError}` : "",
		state.note,
		state.tracks.length || building ? "" : "No output tracks. These encodes will lose every subtitle.",
	].filter(Boolean);
	const emptyOutput = building
		? '<div class="repair-empty">Building Rabbit\'s suggestion. Add tracks by hand or wait for it.</div>'
		: '<div class="repair-empty">No output subtitles.</div>';
	return `<section class="repair-layout">
		<div class="repair-editor-header">
			<div>
				<h3>Layout ${escapeHtml(layout.label)}</h3>
				<details class="repair-layout-files">
					<summary>${names.length} source${names.length === 1 ? "" : "s"}: ${escapeHtml(names.slice(0, 3).join(", "))}${names.length > 3 ? ", ..." : ""}</summary>
					${names.map((name) => `<div>${escapeHtml(name)}</div>`).join("")}
				</details>
			</div>
			<div class="repair-layout-actions">
				${copyButtons}
				<button class="btn btn-ghost btn-sm" type="button" data-layout-suggest data-layout="${layoutIndex}" title="Start over from what the subtitle workflow would pick" ${state.suggestion ? "" : "disabled"}>${building ? "Building suggestion..." : "Rabbit suggestion"}</button>
			</div>
		</div>
		${notes.map((note) => `<div class="repair-pair-warning">${escapeHtml(note)}</div>`).join("")}
		<div class="repair-track-transfer">
			<div class="repair-transfer-pane">
				<div class="repair-tracks repair-source-tracks">${layout.tracks.map((track) => renderSourceTrack(track, layoutIndex, used.has(track.position))).join("")}</div>
			</div>
			<div class="repair-transfer-arrow" aria-hidden="true">→</div>
			<div class="repair-transfer-pane">
				<div class="repair-tracks">${state.tracks.map((_, index) => renderOutputTrack(state, layoutIndex, index)).join("") || emptyOutput}</div>
			</div>
		</div>
	</section>`;
}

function renderLayouts(): void {
	byId("repair-batch-layouts").innerHTML = layouts.map(renderLayout).join("");
	renderMode();
}

export function handleRepairBatchModeChange(): void {
	setError("");
	renderMode();
}

export async function readRepairBatchLayouts(): Promise<void> {
	const pairs = pairedRows();
	if (!pairs.length) return;
	setError("");
	readingLayouts = true;
	renderMode();
	let read: RepairSourceLayout[];
	try {
		read = await fetchRepairBatchLayouts(pairs);
	} catch (error) {
		setError(errorMessage(error));
		return;
	} finally {
		readingLayouts = false;
		renderMode();
	}
	const generation = ++layoutsGeneration;
	layouts = read.map((layout) => ({ layout, tracks: [], note: "", suggestion: null, suggestionError: "", touched: false }));
	layoutsKey = JSON.stringify(pairs);
	renderLayouts();

	// One at a time, since each reads a whole source and they usually sit on the same disk.
	for (const state of layouts) {
		const sourcePath = state.layout.sourcePaths[0]!;
		const pair = pairs.find((candidate) => candidate.sourcePath === sourcePath)!;
		try {
			const suggestion = await fetchRepairBatchSuggestion(pair);
			if (generation !== layoutsGeneration) return;
			state.suggestion = suggestion;
			if (!state.touched) state.tracks = suggestion.map((track) => ({ ...track }));
		} catch (error) {
			if (generation !== layoutsGeneration) return;
			state.suggestionError = errorMessage(error);
		}
		renderLayouts();
	}
}

/** Swap "[Old]" for "[New]" in a title, so a renamed track keeps crediting the right release group. */
export function swapReleaseGroup(title: string, from: string | null, to: string | null): string {
	if (!from || from === to) return title;
	const tag = `[${from}]`;
	if (!title.includes(tag)) return title;
	return to
		? title.replace(tag, `[${to}]`)
		: title
				.replace(tag, "")
				.replace(/\s{2,}/g, " ")
				.trim();
}

function changeSourceTrack(state: LayoutState, track: RepairLayoutTrackPlan, position: number): void {
	const from = state.layout.tracks[track.position];
	const to = state.layout.tracks[position];
	if (!from || !to) return;
	track.position = position;
	track.title = track.title === from.title ? to.title : swapReleaseGroup(track.title, from.releaseGroup, to.releaseGroup);
	if (track.mode === "rabbit" && !to.canRabbitProcess) track.mode = "copy";
}

/** The track of `layout` that is the same subtitle as `track`: equal title first, then the same kind from the same release group. */
function matchingTrack(track: RepairLayoutSourceTrack, layout: RepairSourceLayout, taken: Set<number>): RepairLayoutSourceTrack | undefined {
	const free = layout.tracks.filter((candidate) => !taken.has(candidate.position) && candidate.codecId === track.codecId);
	const sameTitle = free.filter((candidate) => candidate.title === track.title);
	if (sameTitle.length) return sameTitle[0];
	if (!track.releaseGroup) return undefined;
	const sameGroup = free.filter(
		(candidate) => candidate.isForced === track.isForced && candidate.releaseGroup?.toLowerCase() === track.releaseGroup!.toLowerCase(),
	);
	return sameGroup.length === 1 ? sameGroup[0] : undefined;
}

function copyLayout(target: LayoutState, from: LayoutState): void {
	const taken = new Set<number>();
	const missing: string[] = [];
	target.tracks = from.tracks.flatMap((track) => {
		const original = from.layout.tracks[track.position];
		const match = original && matchingTrack(original, target.layout, taken);
		if (!match) {
			missing.push(original?.title || `#${track.position + 1}`);
			return [];
		}
		taken.add(match.position);
		return [{ ...track, position: match.position, mode: track.mode === "rabbit" && !match.canRabbitProcess ? "copy" : track.mode }];
	});
	target.note = missing.length ? `Layout ${from.layout.label} uses tracks this layout does not have: ${missing.join(", ")}. Add a replacement by hand.` : "";
}

export function handleRepairBatchLayoutClick(event: MouseEvent): void {
	const element = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-layout]") : null;
	if (!(element instanceof HTMLButtonElement)) return;
	const state = layouts[Number(element.dataset.layout)];
	if (!state) return;
	const row = Number(element.dataset.row);

	if (element.dataset.layoutAdd !== undefined) {
		const source = state.layout.tracks[Number(element.dataset.layoutAdd)];
		if (!source) return;
		state.tracks.push({
			position: source.position,
			mode: "copy",
			order: state.tracks.length,
			title: source.title,
			language: source.language,
			compression: "preserve",
			isDefault: source.isDefault,
			isForced: source.isForced,
			isEnabled: source.isEnabled,
			isHearingImpaired: source.isHearingImpaired,
			isOriginal: source.isOriginal,
			isCommentary: source.isCommentary,
		});
	} else if (element.dataset.layoutRemove !== undefined) {
		state.tracks.splice(row, 1);
	} else if (element.dataset.layoutMove) {
		const next = element.dataset.layoutMove === "up" ? row - 1 : row + 1;
		if (next < 0 || next >= state.tracks.length) return;
		[state.tracks[row], state.tracks[next]] = [state.tracks[next]!, state.tracks[row]!];
	} else if (element.dataset.layoutCopy !== undefined) {
		const from = layouts[Number(element.dataset.layoutCopy)];
		if (!from) return;
		copyLayout(state, from);
	} else if (element.dataset.layoutSuggest !== undefined) {
		if (!state.suggestion) return;
		state.tracks = state.suggestion.map((track) => ({ ...track }));
		state.note = "";
	} else return;
	state.touched = true;
	renderLayouts();
}

export function handleRepairBatchLayoutInput(event: Event): void {
	const element = event.target;
	if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement)) return;
	const state = layouts[Number(element.dataset.layout)];
	const track = state?.tracks[Number(element.dataset.row)];
	const field = element.dataset.field;
	if (!state || !track || !field) return;
	// Text fields update as they are typed, everything else once it is changed.
	const isText = element instanceof HTMLInputElement && element.type !== "checkbox";
	if ((event.type === "input") !== isText) return;
	state.touched = true;
	if (field === "position") {
		changeSourceTrack(state, track, Number(element.value));
		renderLayouts();
	} else if (element instanceof HTMLInputElement && element.type === "checkbox") (track as any)[field] = element.checked;
	else (track as any)[field] = element.value;
}

function loadPairing(data: RepairBatchPairing): void {
	targetDir = data.targetDir;
	sourceDir = data.sourceDir;
	rows = data.pairs.map((pair) => ({ ...pair, edited: false }));
	// Every source in the folder stays selectable, including ones nothing claimed.
	const known = new Map<string, string>();
	for (const pair of data.pairs) if (pair.sourcePath) known.set(pair.sourcePath, pair.sourceName);
	for (const path of data.unmatchedSources) known.set(path, fileName(path));
	sourceChoices = [...known.entries()]
		.map(([path, name]) => ({ path, name }))
		.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
	renderFolders();
	renderPairs();
}

export function openRepairBatch(): void {
	setError("");
	rows = [];
	sourceChoices = [];
	layouts = [];
	layoutsKey = "";
	layoutsGeneration++;
	byId("repair-batch-layouts").innerHTML = "";
	renderFolders();
	renderPairs();
	byId("repair-batch-modal").style.display = "";
}

export function closeRepairBatch(): void {
	byId("repair-batch-modal").style.display = "none";
}

export function closeRepairBatchIfOutside(event: MouseEvent): void {
	if (event.target === byId("repair-batch-modal")) closeRepairBatch();
}

export function pickRepairBatchTargetFolder(): void {
	openRepairFolderPicker((path) => {
		targetDir = path;
		rows = [];
		renderFolders();
		renderPairs();
	});
}

export function pickRepairBatchSourceFolder(): void {
	openRepairFolderPicker((path) => {
		sourceDir = path;
		rows = [];
		renderFolders();
		renderPairs();
	});
}

export async function pairRepairBatchFolders(): Promise<void> {
	setError("");
	const button = buttonById("repair-batch-pair-btn");
	button.disabled = true;
	button.textContent = "Pairing...";
	try {
		loadPairing(await fetchRepairBatchPairing({ targetDir, sourceDir }));
	} catch (error) {
		rows = [];
		renderPairs();
		setError(errorMessage(error));
	} finally {
		button.disabled = !targetDir || !sourceDir;
		button.textContent = "Pair folders";
	}
}

/** Re-point one encode at a different source, or skip it. */
export function handleRepairBatchPairChange(event: Event): void {
	const element = event.target;
	if (!(element instanceof HTMLSelectElement) || element.dataset.pairIndex === undefined) return;
	const row = rows[Number(element.dataset.pairIndex)];
	if (!row) return;
	row.sourcePath = element.value;
	row.sourceName = element.value ? fileName(element.value) : "";
	row.edited = true;
	renderPairs();
}

export async function queueRepairBatch(): Promise<void> {
	const pairs = pairedRows();
	if (!pairs.length) {
		setError("Pair at least one encode with a source.");
		return;
	}
	if (choosingTracks() && !layoutsFresh()) {
		setError("Read the subtitle layouts of the current pairs first.");
		return;
	}
	setError("");
	const button = buttonById("repair-batch-queue-btn");
	const label = button.textContent;
	button.disabled = true;
	button.textContent = "Queueing...";
	try {
		await createRepairBatchJobs({
			pairs,
			replaceTarget: byId<HTMLSelectElement>("repair-batch-save-mode").value === "existing",
			layouts: choosingTracks()
				? layouts.map((state) => ({ signature: state.layout.signature, tracks: state.tracks.map((track, order) => ({ ...track, order })) }))
				: undefined,
		});
		closeRepairBatch();
		await update();
	} catch (error) {
		setError(errorMessage(error));
		button.disabled = false;
		button.textContent = label;
	}
}
