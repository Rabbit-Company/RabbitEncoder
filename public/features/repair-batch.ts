import type { RepairBatchPairing, RepairPairSuggestion } from "../types";
import { createRepairBatchJobs, fetchRepairBatchPairing } from "../api/client";
import { buttonById, byId } from "../shared/dom";
import { errorMessage } from "../shared/errors";
import { openRepairFolderPicker } from "./repair";
import { update } from "./polling";

/** A row of the mapping table. `sourcePath` empty means "skip this encode". */
interface PairRow extends RepairPairSuggestion {
	edited: boolean;
}

let targetDir = "";
let sourceDir = "";
let rows: PairRow[] = [];
let sourceChoices: { path: string; name: string }[] = [];

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
	byId("repair-batch-summary").textContent = rows.length ? parts.join(" · ") : "";

	buttonById("repair-batch-queue-btn").disabled = paired === 0 || duplicates.size > 0;
	buttonById("repair-batch-queue-btn").textContent = paired ? `Queue ${paired} replacement${paired === 1 ? "" : "s"}` : "Queue replacements";
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
	const pairs = rows.filter((row) => row.sourcePath).map((row) => ({ targetPath: row.targetPath, sourcePath: row.sourcePath }));
	if (!pairs.length) {
		setError("Pair at least one encode with a source.");
		return;
	}
	setError("");
	const button = buttonById("repair-batch-queue-btn");
	const label = button.textContent;
	button.disabled = true;
	button.textContent = "Queueing...";
	try {
		await createRepairBatchJobs({ pairs, replaceTarget: byId<HTMLSelectElement>("repair-batch-save-mode").value === "existing" });
		closeRepairBatch();
		await update();
	} catch (error) {
		setError(errorMessage(error));
		button.disabled = false;
		button.textContent = label;
	}
}
