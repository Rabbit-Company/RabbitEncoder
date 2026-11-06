import type { ReleaseAudioCandidate, ReleaseAudioCell, ReleaseAudioRow, ReleaseAudioScan, ReleaseCheck } from "../types";
import { createReleaseAudioJobs, fetchReleaseAudioScan, fetchReleaseCheck } from "../api/client";
import { buttonById, byId, inputById } from "../shared/dom";
import { errorMessage } from "../shared/errors";
import { openRepairFolderPicker } from "./repair";
import { update } from "./polling";

const MAX_RELEASE_FOLDERS = 10;

let targetDir = "";
/** Release folders, each with the numbering offset typed for it, empty for automatic. */
let releaseDirs: Array<{ path: string; offset: string }> = [];
let scan: ReleaseAudioScan | null = null;
/** What each cell takes, by episode then column: a candidate's id, or "" to leave the cell as the video has it. */
let selections = new Map<string, Map<string, string>>();
/** Columns turned off, which no episode takes. */
let excluded = new Set<string>();
let checks = new Map<string, { loading: boolean; results?: ReleaseCheck[]; error?: string }>();
let scanning = false;
/** The folders the grid was read with. Other ones make it stale. */
let scannedWith = "";

const escapeHtml = (value: unknown): string =>
	String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");

const fileName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const candidateId = (c: Pick<ReleaseAudioCandidate, "sourcePath" | "trackId">): string => `${c.trackId}\n${c.sourcePath}`;

function setError(message: string): void {
	const error = byId("release-audio-error");
	error.textContent = message;
	error.style.display = message ? "" : "none";
}

const currentOptions = () => ({
	targetDir,
	sourceDirs: releaseDirs.map((dir) => ({ path: dir.path, ...(dir.offset.trim() ? { offset: Number(dir.offset) } : {}) })),
});
const isStale = () => !!scan && scannedWith !== JSON.stringify(currentOptions());

function folderHtml(path: string): string {
	return `<span class="repair-file-name" title="${escapeHtml(path)}">${escapeHtml(fileName(path))}</span><span class="repair-file-folder">${escapeHtml(path)}</span>`;
}

function renderFolders(): void {
	byId("release-audio-target-selection").innerHTML = targetDir ? folderHtml(targetDir) : '<span class="repair-file-empty">No videos folder selected</span>';
	byId("release-audio-sources").innerHTML = releaseDirs.length
		? releaseDirs
				.map(
					(dir, i) => `<div class="release-subs-source">
						<div class="repair-file-selection">${folderHtml(dir.path)}</div>
						<label class="release-subs-offset" title="For a release numbered across seasons: what it adds to the episode number, such as 12 when S02E01 is episode 13. Empty finds it from the file names.">Offset
							<input type="number" min="1" max="5000" class="repair-input" data-release-offset="${i}" placeholder="auto" value="${escapeHtml(dir.offset)}">
						</label>
						<button class="btn btn-ghost btn-sm" type="button" data-release-remove-dir="${i}">Remove</button>
					</div>`,
				)
				.join("")
		: '<span class="repair-file-empty">No release folders added</span>';
	buttonById("release-audio-add-source-btn").disabled = releaseDirs.length >= MAX_RELEASE_FOLDERS;
	const button = buttonById("release-audio-scan-btn");
	button.disabled = scanning || !targetDir || !releaseDirs.length;
	button.textContent = scanning ? "Reading releases..." : scan ? "Read releases again" : "Read releases";
}

function methodLabel(method: string, offset?: number): string {
	if (method === "episode") return '<span class="repair-pair-method">Episode number</span>';
	if (method === "absolute")
		return `<span class="repair-pair-method" title="The release numbers its episodes across seasons">Absolute number (+${offset ?? "?"})</span>`;
	if (method === "order") return '<span class="repair-pair-method repair-pair-weak">Filename order</span>';
	return '<span class="repair-pair-method repair-pair-none">No match</span>';
}

function selectionOf(row: ReleaseAudioRow, cell: ReleaseAudioCell): string {
	if (excluded.has(cell.key)) return "";
	return selections.get(row.targetPath)?.get(cell.key) ?? (cell.chosen ? candidateId(cell.chosen) : "");
}

function cellState(cell: ReleaseAudioCell, selected: string): "missing" | "have" | "add" | "replace" | "skip" {
	if (!cell.candidates.length) return cell.have.length ? "have" : "missing";
	if (!selected) return cell.have.length ? "have" : "skip";
	return cell.have.length ? "replace" : "add";
}

function renderCell(row: ReleaseAudioRow, rowIndex: number, cell: ReleaseAudioCell): string {
	const selected = selectionOf(row, cell);
	const state = cellState(cell, selected);
	const haveTitles = cell.have.map((h) => [h.format, h.title].filter(Boolean).join(", ")).join("\n");
	if (!cell.candidates.length) {
		return state === "have"
			? `<td class="release-cell is-have" title="${escapeHtml(haveTitles)}">✓</td>`
			: '<td class="release-cell is-missing" title="No file has it">—</td>';
	}
	const options = [
		`<option value="" ${selected ? "" : "selected"}>${cell.have.length ? "✓ Keep" : "Don't add"}</option>`,
		...cell.candidates.map((c) => {
			const label = `${cell.have.length ? "Replace with " : ""}${c.credit ?? fileName(c.sourcePath)} · ${c.format}`;
			const id = candidateId(c);
			return `<option value="${escapeHtml(id)}" ${id === selected ? "selected" : ""} title="${escapeHtml(`${c.title || "Untitled"}\n${fileName(c.sourcePath)}`)}">${escapeHtml(label)}</option>`;
		}),
	].join("");
	const title = [cell.have.length ? `The video has: ${haveTitles}` : "", `${cell.candidates.length} release track${cell.candidates.length === 1 ? "" : "s"}`]
		.filter(Boolean)
		.join("\n");
	return `<td class="release-cell is-${state}" title="${escapeHtml(title)}">
		<select class="select-input release-cell-select" data-release-row="${rowIndex}" data-release-key="${escapeHtml(cell.key)}" ${excluded.has(cell.key) ? "disabled" : ""}>${options}</select>
	</td>`;
}

function renderCheck(row: ReleaseAudioRow): string {
	const check = checks.get(row.targetPath);
	if (!check) return "";
	if (check.loading) return '<div class="release-check">Comparing the audio...</div>';
	if (check.error) return `<div class="release-check repair-pair-none">${escapeHtml(check.error)}</div>`;
	return (check.results ?? [])
		.map(
			(r) =>
				`<div class="release-check ${r.matched ? "is-matched" : "repair-pair-none"}" title="${escapeHtml(fileName(r.sourcePath))}">${r.matched ? "✓" : "✗"} ${escapeHtml(fileName(r.sourcePath).slice(0, 28))}: ${escapeHtml(r.detail)}</div>`,
		)
		.join("");
}

function renderRow(row: ReleaseAudioRow, rowIndex: number): string {
	const sources = row.sources.length
		? row.sources
				.map((s) => `<div class="release-row-source" title="${escapeHtml(s.path)}">${escapeHtml(s.name)} ${methodLabel(s.method, s.offset)}</div>`)
				.join("")
		: '<div class="repair-pair-warning">No release of this episode was found.</div>';
	const check = checks.get(row.targetPath);
	return `<tr>
		<th class="release-row-head" scope="row">
			<div class="repair-file-name" title="${escapeHtml(row.targetPath)}">${escapeHtml(row.targetName)}</div>
			${sources}
			${row.sources.length ? `<button class="btn btn-ghost btn-sm" type="button" data-release-check="${rowIndex}" ${check?.loading ? "disabled" : ""}>Check timing</button>` : ""}
			${renderCheck(row)}
		</th>
		${row.cells.map((cell) => renderCell(row, rowIndex, cell)).join("")}
	</tr>`;
}

/** What queueing would send: every cell a release can fill, as the grid shows it. */
function plannedRows() {
	if (!scan) return [];
	return scan.rows
		.filter((row) => row.sources.length)
		.map((row) => {
			const choices: Record<string, { sourcePath: string; trackId: number } | null> = {};
			let changes = 0;
			for (const cell of row.cells) {
				if (!cell.candidates.length) continue;
				const selected = selectionOf(row, cell);
				const picked = selected ? cell.candidates.find((c) => candidateId(c) === selected) : undefined;
				choices[cell.key] = picked ? { sourcePath: picked.sourcePath, trackId: picked.trackId } : null;
				if (picked) changes++;
			}
			return { targetPath: row.targetPath, sourcePaths: row.sources.map((s) => s.path), choices, changes };
		});
}

function renderGrid(): void {
	const grid = byId("release-audio-grid");
	if (!scan) {
		grid.innerHTML = '<div class="repair-empty">Choose the videos folder and at least one folder of other releases, then read them.</div>';
		byId("release-audio-summary").textContent = "";
		byId("release-audio-unmatched").innerHTML = "";
		renderQueueButton();
		return;
	}
	const head = scan.columns
		.map(
			(col) =>
				`<th class="release-col${excluded.has(col.key) ? " is-excluded" : ""}" scope="col"><label title="Take ${escapeHtml(col.label)} audio from the releases"><input type="checkbox" data-release-column="${escapeHtml(col.key)}" ${excluded.has(col.key) ? "" : "checked"}> ${escapeHtml(col.label)}</label></th>`,
		)
		.join("");
	grid.innerHTML = scan.rows.length
		? `<table class="release-grid"><thead><tr><th class="release-row-head" scope="col">Episode</th>${head}</tr></thead><tbody>${scan.rows.map(renderRow).join("")}</tbody></table>`
		: '<div class="repair-empty">The videos folder has no MKV files.</div>';

	const planned = plannedRows();
	const tracks = planned.reduce((n, r) => n + r.changes, 0);
	const episodes = planned.filter((r) => r.changes).length;
	const unpaired = scan.rows.length - planned.length;
	const parts = [`${tracks} track${tracks === 1 ? "" : "s"} for ${episodes} of ${scan.rows.length} episode${scan.rows.length === 1 ? "" : "s"}`];
	if (unpaired) parts.push(`${unpaired} without a release`);
	if (isStale()) parts.push("the folders changed, read the releases again");
	byId("release-audio-summary").textContent = parts.join(" | ");
	byId("release-audio-unmatched").innerHTML = scan.unmatchedSources.length
		? `<details class="repair-layout-files"><summary>${scan.unmatchedSources.length} release file${scan.unmatchedSources.length === 1 ? "" : "s"} matched no video</summary>${scan.unmatchedSources.map((p) => `<div>${escapeHtml(fileName(p))}</div>`).join("")}</details>`
		: "";
	renderQueueButton();
}

function renderQueueButton(): void {
	const button = buttonById("release-audio-queue-btn");
	const episodes = plannedRows().filter((r) => r.changes).length;
	button.textContent = episodes ? `Queue ${episodes} episode${episodes === 1 ? "" : "s"}` : "Queue episodes";
	button.disabled = !episodes || isStale() || scanning;
}

export function openReleaseAudio(): void {
	setError("");
	renderFolders();
	renderGrid();
	byId("release-audio-modal").style.display = "";
}

export function closeReleaseAudio(): void {
	byId("release-audio-modal").style.display = "none";
}

export function closeReleaseAudioIfOutside(event: MouseEvent): void {
	if (event.target === byId("release-audio-modal")) closeReleaseAudio();
}

export function pickReleaseAudioTargetFolder(): void {
	openRepairFolderPicker((path) => {
		targetDir = path;
		renderFolders();
		renderGrid();
	});
}

export function addReleaseAudioSourceFolder(): void {
	openRepairFolderPicker((path) => {
		if (!releaseDirs.some((dir) => dir.path === path) && releaseDirs.length < MAX_RELEASE_FOLDERS) releaseDirs.push({ path, offset: "" });
		renderFolders();
		renderGrid();
	});
}

export function handleReleaseAudioSourcesClick(event: MouseEvent): void {
	const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-release-remove-dir]") : null;
	if (!button) return;
	releaseDirs.splice(Number(button.dataset.releaseRemoveDir), 1);
	renderFolders();
	renderGrid();
}

/** Typing an offset only marks the grid stale, so the field keeps its focus. */
export function handleReleaseAudioSourcesInput(event: Event): void {
	const input = event.target;
	if (!(input instanceof HTMLInputElement) || input.dataset.releaseOffset === undefined) return;
	const dir = releaseDirs[Number(input.dataset.releaseOffset)];
	if (!dir) return;
	dir.offset = input.value;
	renderGrid();
}

export async function scanReleaseAudio(): Promise<void> {
	setError("");
	scanning = true;
	renderFolders();
	renderQueueButton();
	const options = currentOptions();
	try {
		scan = await fetchReleaseAudioScan(options);
		scannedWith = JSON.stringify(options);
		selections = new Map();
		excluded = new Set();
		checks = new Map();
	} catch (error) {
		setError(errorMessage(error));
	} finally {
		scanning = false;
		renderFolders();
		renderGrid();
	}
}

export function handleReleaseAudioGridChange(event: Event): void {
	const element = event.target;
	if (!scan) return;
	if (element instanceof HTMLInputElement && element.dataset.releaseColumn) {
		const key = element.dataset.releaseColumn;
		if (element.checked) excluded.delete(key);
		else excluded.add(key);
		renderGrid();
		return;
	}
	if (!(element instanceof HTMLSelectElement) || element.dataset.releaseRow === undefined) return;
	const row = scan.rows[Number(element.dataset.releaseRow)];
	const key = element.dataset.releaseKey;
	if (!row || !key) return;
	let byKey = selections.get(row.targetPath);
	if (!byKey) selections.set(row.targetPath, (byKey = new Map()));
	byKey.set(key, element.value);
	renderGrid();
}

export async function handleReleaseAudioGridClick(event: MouseEvent): Promise<void> {
	const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-release-check]") : null;
	if (!button || !scan) return;
	const row = scan.rows[Number(button.dataset.releaseCheck)];
	if (!row) return;
	checks.set(row.targetPath, { loading: true });
	renderGrid();
	try {
		checks.set(row.targetPath, {
			loading: false,
			results: await fetchReleaseCheck({ targetPath: row.targetPath, sourcePaths: row.sources.map((s) => s.path) }),
		});
	} catch (error) {
		checks.set(row.targetPath, { loading: false, error: errorMessage(error) });
	}
	renderGrid();
}

export async function queueReleaseAudio(): Promise<void> {
	const rows = plannedRows().filter((r) => r.changes);
	if (!rows.length) return;
	setError("");
	const button = buttonById("release-audio-queue-btn");
	button.disabled = true;
	button.textContent = "Queueing...";
	try {
		await createReleaseAudioJobs({
			rows: rows.map(({ changes: _changes, ...row }) => row),
			replaceTarget: byId<HTMLSelectElement>("release-audio-save-mode").value === "existing",
			applySettings: inputById("release-audio-apply").checked,
		});
		closeReleaseAudio();
		await update();
	} catch (error) {
		setError(errorMessage(error));
		renderQueueButton();
	}
}
