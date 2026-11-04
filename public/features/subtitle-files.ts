import type { SubtitleFileFont, SubtitleFileFontSource, SubtitleFilesPair, SubtitleFilesScan } from "../types";
import { createSubtitleFileJobs, scanSubtitleFiles, uploadSubtitleFont } from "../api/client";
import { buttonById, byId, inputById } from "../shared/dom";
import { errorMessage } from "../shared/errors";
import { findLanguage } from "../shared/languages";
import { openRepairFolderPicker } from "./repair";
import { update } from "./polling";

/** A row of the pairing table. `sourcePath` empty skips the video. */
interface Row extends SubtitleFilesPair {
	edited: boolean;
}

let targetDir = "";
let subtitleDir = "";
let scan: SubtitleFilesScan | null = null;
let rows: Row[] = [];
let subtitleChoices: string[] = [];
/** Uploaded fonts by the normalized name of the font they stand in for. */
const uploads = new Map<string, SubtitleFileFontSource>();
let busy = false;
let fontsOpen: boolean | null = null;

const escapeHtml = (value: unknown): string =>
	String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");

const fileName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const normalizeFontName = (name: string): string => name.trim().toLowerCase().replace(/^@/, "");
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function setError(message: string): void {
	const error = byId("subfiles-error");
	error.textContent = message;
	error.style.display = message ? "" : "none";
}

function fontState(font: SubtitleFileFont): { status: SubtitleFileFont["status"]; upload?: SubtitleFileFontSource } {
	const upload = uploads.get(normalizeFontName(font.name));
	return upload ? { status: "uploaded", upload } : { status: font.status === "uploaded" ? "missing" : font.status };
}

const missingFonts = () => (scan?.fonts ?? []).filter((font) => fontState(font).status === "missing");

function renderFolders(): void {
	const selection = (path: string, empty: string) =>
		path
			? `<span class="repair-file-name" title="${escapeHtml(path)}">${escapeHtml(fileName(path))}</span><span class="repair-file-folder">${escapeHtml(path)}</span>`
			: `<span class="repair-file-empty">${empty}</span>`;
	byId("subfiles-target-selection").innerHTML = selection(targetDir, "No videos folder selected");
	byId("subfiles-source-selection").innerHTML = selection(subtitleDir, "No subtitles folder selected");
	buttonById("subfiles-pair-btn").disabled = !targetDir || !subtitleDir || busy;
}

function sameLanguage(a: string, b: string): boolean {
	const base = (code: string) => (findLanguage(code)?.tag ?? code).split("-")[0]!.toLowerCase();
	return base(a) === base(b);
}

function methodLabel(row: Row): string {
	if (row.edited) return '<span class="repair-pair-method repair-pair-edited">Chosen by you</span>';
	if (row.method === "episode") return '<span class="repair-pair-method">Episode number</span>';
	if (row.method === "absolute")
		return `<span class="repair-pair-method" title="The files number their episodes across seasons">Absolute number (+${row.offset ?? "?"})</span>`;
	if (row.method === "order") return '<span class="repair-pair-method repair-pair-weak">Filename order</span>';
	return '<span class="repair-pair-method repair-pair-none">No match</span>';
}

function renderRow(row: Row, index: number, duplicates: Set<string>, language: string): string {
	const options = [
		`<option value="" ${row.sourcePath ? "" : "selected"}>Skip this video</option>`,
		...subtitleChoices.map((path) => `<option value="${escapeHtml(path)}" ${path === row.sourcePath ? "selected" : ""}>${escapeHtml(fileName(path))}</option>`),
	].join("");
	const has = language && row.existingLanguages.some((existing) => sameLanguage(existing, language));
	const warning = duplicates.has(row.sourcePath)
		? '<div class="repair-pair-warning">This file is paired with more than one video.</div>'
		: !row.sourcePath
			? '<div class="repair-pair-warning">Skipped. This video keeps its subtitles as they are.</div>'
			: has
				? `<div class="repair-pair-warning">The video already has a ${escapeHtml(findLanguage(language)?.name ?? language)} subtitle. This adds another.</div>`
				: "";
	return `<div class="repair-pair-row${row.sourcePath ? "" : " repair-pair-row-skipped"}">
		<div class="repair-pair-target">
			<span class="repair-file-name">${escapeHtml(row.targetName)}</span>
			${methodLabel(row)}
		</div>
		<div class="repair-pair-arrow" aria-hidden="true">←</div>
		<div class="repair-pair-source">
			<select class="select-input" data-subfiles-pair="${index}" ${busy ? "disabled" : ""}>${options}</select>
			${warning}
		</div>
	</div>`;
}

function duplicateSources(): Set<string> {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const row of rows) {
		if (!row.sourcePath) continue;
		if (seen.has(row.sourcePath)) duplicates.add(row.sourcePath);
		seen.add(row.sourcePath);
	}
	return duplicates;
}

const pairedRows = () => rows.filter((row) => row.sourcePath);

function renderPairs(): void {
	const duplicates = duplicateSources();
	const language = inputById("subfiles-language").value.trim();
	byId("subfiles-pairs").innerHTML = rows.length
		? rows.map((row, index) => renderRow(row, index, duplicates, language)).join("")
		: '<div class="repair-empty">Choose both folders and pair them to see the mapping.</div>';
	const paired = pairedRows().length;
	const parts = rows.length ? [`${paired} of ${plural(rows.length, "video")} paired`] : [];
	if (rows.length > paired) parts.push(`${rows.length - paired} skipped`);
	if (duplicates.size) parts.push(`${plural(duplicates.size, "file")} used twice`);
	if (scan?.unmatchedSubtitles.length) parts.push(`${plural(scan.unmatchedSubtitles.length, "file")} not paired`);
	byId("subfiles-summary").textContent = parts.join(" | ");
	renderQueueButton();
}

function renderQueueButton(): void {
	const paired = pairedRows().length;
	const button = buttonById("subfiles-queue-btn");
	button.textContent = busy ? "Queueing..." : paired ? `Queue ${plural(paired, "video")}` : "Queue subtitles";
	button.disabled = busy || !paired || duplicateSources().size > 0 || !inputById("subfiles-language").value.trim();
}

function renderTrackName(): void {
	const credit = inputById("subfiles-credit").value.replace(/[[\]]/g, "").trim();
	byId("subfiles-track-name").textContent = credit
		? `Tracks are named “Full Subtitles [${credit}]”.`
		: "Without a credit, tracks are named after the group in the file name, such as “Full Subtitles [Kirion]”.";
}

function statusLabel(font: SubtitleFileFont): string {
	const { status, upload } = fontState(font);
	if (status === "attached") return '<span class="subfiles-font-status is-ok">Already in the videos</span>';
	if (status === "folder") return '<span class="subfiles-font-status is-ok">In the subtitles folder</span>';
	if (status === "replaced") return `<span class="subfiles-font-status is-ok">Replaced by ${escapeHtml(scan?.dialogueFontGroup ?? "the font group")}</span>`;
	if (status === "uploaded")
		return `<span class="subfiles-font-status is-ok" title="${escapeHtml(upload!.fileName)}">Uploaded${upload!.renamedFrom ? `, renamed from ${escapeHtml(upload!.renamedFrom)}` : ""}</span>`;
	const where = font.missingIn.length === rows.length ? "every video" : plural(font.missingIn.length, "video");
	return `<span class="subfiles-font-status is-missing" title="${escapeHtml(font.missingIn.join("\n"))}">Missing in ${where}</span>`;
}

function fontRow(font: SubtitleFileFont): string {
	const { status } = fontState(font);
	const canUpload = status === "missing" || status === "uploaded";
	const windows =
		font.windows && status === "missing" ? '<small title="Players on Windows have it. TVs, phones and Linux often do not.">Comes with Windows</small>' : "";
	return `<div class="subfiles-font${status === "missing" ? " is-missing" : ""}">
		<span class="subfiles-font-name" style="font-family: ${escapeHtml(JSON.stringify(font.name))}, var(--font-body)">${escapeHtml(font.name)}</span>
		<span class="subfiles-font-used">${plural(font.usedBy, "file")}</span>
		${statusLabel(font)}
		${windows}
		<span class="subfiles-font-actions">
			${canUpload ? `<label class="btn btn-ghost btn-sm${busy ? " is-disabled" : ""}">${status === "uploaded" ? "Replace..." : "Upload..."}<input type="file" accept=".ttf,.otf,.ttc,.otc" data-subfiles-font="${escapeHtml(font.name)}" hidden ${busy ? "disabled" : ""}></label>` : ""}
			${status === "uploaded" ? `<button class="btn btn-ghost btn-sm" type="button" data-subfiles-font-remove="${escapeHtml(font.name)}" ${busy ? "disabled" : ""}>Remove</button>` : ""}
		</span>
	</div>`;
}

function renderFonts(): void {
	const container = byId("subfiles-fonts");
	const fonts = scan?.fonts ?? [];
	if (!fonts.length) {
		container.innerHTML = "";
		return;
	}
	const previous = container.querySelector("details");
	if (previous) fontsOpen = previous.open;
	const missing = missingFonts();
	fontsOpen ??= missing.length > 0;
	const summary = missing.length ? `${plural(missing.length, "font")} of ${fonts.length} missing` : `All ${plural(fonts.length, "font")} available`;
	container.innerHTML = `<details class="settings-subsection subfiles-fonts"${fontsOpen ? " open" : ""}>
		<summary>Fonts <span class="hdr-note${missing.length ? " has-outliers" : ""}">${summary}</span></summary>
		<div class="settings-subsection-body">
			${
				missing.length
					? `<p class="subfiles-font-warning">The subtitles use fonts that neither the videos nor the subtitles folder have. Players draw that text in another font, so signs, songs and styled lines lose their look. Upload each missing font. A font with another name is renamed to the one the subtitles use.</p>`
					: ""
			}
			<p class="lang-filter-hint">Fonts inside the subtitles folder, or in a Fonts folder next to it, are found on their own. Only the fonts each episode uses are attached to it.${
				scan?.dialogueFontGroup ? ` Dialogue is set in your ${escapeHtml(scan.dialogueFontGroup)} font group, per the Replace dialogue font setting.` : ""
			}</p>
			<div class="subfiles-font-list">${fonts.map(fontRow).join("")}</div>
			<div class="subfiles-font-bulk">
				<label class="btn btn-ghost btn-sm${busy ? " is-disabled" : ""}">Upload several fonts...<input type="file" accept=".ttf,.otf,.ttc,.otc" multiple data-subfiles-fonts hidden ${busy ? "disabled" : ""}></label>
				<span class="lang-filter-hint" id="subfiles-font-status"></span>
			</div>
		</div>
	</details>`;
}

function render(): void {
	renderFolders();
	byId("subfiles-options").style.display = scan ? "" : "none";
	renderFonts();
	renderPairs();
	renderTrackName();
}

function resetScan(): void {
	scan = null;
	rows = [];
	subtitleChoices = [];
	uploads.clear();
	fontsOpen = null;
}

export function openSubtitleFiles(): void {
	setError("");
	render();
	byId("subfiles-modal").style.display = "";
}

export function closeSubtitleFiles(): void {
	byId("subfiles-modal").style.display = "none";
}

export function closeSubtitleFilesIfOutside(event: MouseEvent): void {
	if (event.target === byId("subfiles-modal")) closeSubtitleFiles();
}

export function pickSubtitleFilesTargetFolder(): void {
	openRepairFolderPicker((path) => {
		targetDir = path;
		resetScan();
		render();
	}, "Choose the folder of videos");
}

export function pickSubtitleFilesSourceFolder(): void {
	openRepairFolderPicker((path) => {
		subtitleDir = path;
		resetScan();
		render();
	}, "Choose the folder of subtitle files");
}

export async function pairSubtitleFiles(): Promise<void> {
	if (!targetDir || !subtitleDir || busy) return;
	setError("");
	busy = true;
	const button = buttonById("subfiles-pair-btn");
	button.textContent = "Reading folders...";
	renderFolders();
	try {
		const result = await scanSubtitleFiles({ targetDir, subtitleDir });
		resetScan();
		scan = result;
		rows = result.pairs.map((pair) => ({ ...pair, edited: false }));
		subtitleChoices = [...new Set([...result.pairs.map((pair) => pair.sourcePath).filter(Boolean), ...result.unmatchedSubtitles])].sort((a, b) =>
			fileName(a).localeCompare(fileName(b), undefined, { numeric: true, sensitivity: "base" }),
		);
		inputById("subfiles-language").value = result.language ?? "";
		inputById("subfiles-credit").value = result.credit;
	} catch (error) {
		setError(errorMessage(error));
	} finally {
		busy = false;
		button.textContent = "Pair folders";
		render();
	}
}

async function uploadFor(name: string, file: File): Promise<void> {
	setError("");
	try {
		const font = await uploadSubtitleFont(file, name);
		uploads.set(normalizeFontName(name), font);
	} catch (error) {
		setError(errorMessage(error));
	}
	renderFonts();
}

/** Uploads fonts as they are and keeps those whose names the subtitles use. */
async function uploadSeveral(files: File[]): Promise<void> {
	setError("");
	const wanted = new Map((scan?.fonts ?? []).map((font) => [normalizeFontName(font.name), font.name]));
	const unused: string[] = [];
	const failed: string[] = [];
	for (const file of files) {
		try {
			const font = await uploadSubtitleFont(file);
			const matches = font.names.filter((name) => wanted.has(name));
			if (!matches.length) unused.push(file.name);
			for (const name of matches) uploads.set(name, font);
		} catch (error) {
			failed.push(`${file.name}: ${errorMessage(error)}`);
		}
	}
	renderFonts();
	const notes = [];
	if (unused.length) notes.push(`Not used by the subtitles: ${unused.join(", ")}. Upload it on a font's own row to stand in for that font.`);
	if (failed.length) notes.push(failed.join(". "));
	byId("subfiles-font-status").textContent = notes.join(" ");
}

export function handleSubtitleFilesChange(event: Event): void {
	const target = event.target;
	if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement) || busy) return;
	if (target instanceof HTMLSelectElement && target.dataset.subfilesPair !== undefined) {
		const row = rows[Number(target.dataset.subfilesPair)];
		if (!row) return;
		row.sourcePath = target.value;
		row.sourceName = target.value ? fileName(target.value) : "";
		row.edited = true;
		renderPairs();
		return;
	}
	if (!(target instanceof HTMLInputElement) || target.type !== "file" || !target.files?.length) return;
	const files = [...target.files];
	if (target.dataset.subfilesFont !== undefined) void uploadFor(target.dataset.subfilesFont, files[0]!);
	else if (target.hasAttribute("data-subfiles-fonts")) void uploadSeveral(files);
}

export function handleSubtitleFilesInput(event: Event): void {
	const id = (event.target as HTMLElement | null)?.id;
	if (id === "subfiles-language") renderPairs();
	if (id === "subfiles-credit") renderTrackName();
}

export function handleSubtitleFilesClick(event: MouseEvent): void {
	const remove = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-subfiles-font-remove]") : null;
	if (!remove || busy) return;
	uploads.delete(normalizeFontName(remove.dataset.subfilesFontRemove!));
	renderFonts();
}

export async function queueSubtitleFiles(): Promise<void> {
	if (!scan || busy) return;
	const pairs = pairedRows().map((row) => ({ targetPath: row.targetPath, sourcePath: row.sourcePath }));
	const language = inputById("subfiles-language").value.trim();
	if (!pairs.length || !language) return;
	const missing = missingFonts();
	if (
		missing.length &&
		!confirm(
			`${plural(missing.length, "font")} the subtitles use ${missing.length === 1 ? "is" : "are"} still missing: ${missing.map((font) => font.name).join(", ")}.\n\nPlayers will draw that text in another font. Queue anyway?`,
		)
	)
		return;
	setError("");
	busy = true;
	render();
	try {
		const fonts = [...new Set([...scan.folderFonts.map((font) => font.path), ...[...uploads.values()].map((font) => font.path)])];
		const result = await createSubtitleFileJobs({ pairs, language, credit: inputById("subfiles-credit").value, fonts });
		byId("subfiles-summary").textContent = `Queued ${plural(result.jobIds.length, "video")}. Follow their progress in the job list.`;
		rows = [];
		void update().catch(() => {});
	} catch (error) {
		setError(errorMessage(error));
	} finally {
		busy = false;
		renderFolders();
		renderFonts();
		if (rows.length) renderPairs();
		else {
			byId("subfiles-pairs").innerHTML = "";
			renderQueueButton();
		}
	}
}
