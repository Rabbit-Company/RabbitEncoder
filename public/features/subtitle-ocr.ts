import { fetchOcrPairs, fetchOcrTracks, queueOcrBatch, queueOcrJob, type OcrPair, type OcrTrackInfo } from "../api/client";
import { buttonById, byId, inputById } from "../shared/dom";
import { errorMessage } from "../shared/errors";
import { appState } from "../state";
import { update } from "./polling";
import { openHdrSourcePicker, openRepairFolderPicker, openSubtitleOcrPicker } from "./repair";
import { renderRadioPills } from "./settings-controls";

type Scope = "file" | "folder";

let scope: Scope = "file";
let targetPath = "";
let folderPath = "";
/** Original to read from, when the video no longer has its picture tracks. */
let sourcePath = "";
let sourceFolder = "";
/** Encode and original pairs for a folder, null until matched. */
let pairs: OcrPair[] | null = null;
let unmatchedSources = 0;
const skippedPairs = new Set<string>();
let tracks: OcrTrackInfo[] | null = null;
const chosen = new Set<number>();
/** Bumped on every inspection, so a late answer for another file is dropped. */
let inspectRun = 0;

const escapeHtml = (value: unknown): string =>
	String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");

const fileName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

function configured(): boolean {
	return !!appState.defaults?.ocrBaseUrl?.trim() && !!appState.defaults?.ocrModel?.trim();
}

function setError(message: string): void {
	const el = byId("subocr-error");
	el.textContent = message;
	el.style.display = message ? "" : "none";
}

function selection(path: string, empty: string): string {
	return path
		? `<span class="repair-file-name" title="${escapeHtml(path)}">${escapeHtml(fileName(path))}</span><span class="repair-file-folder">${escapeHtml(path)}</span>`
		: `<span class="repair-file-empty">${escapeHtml(empty)}</span>`;
}

const TYPE_LABELS: Record<string, string> = {
	full: "Full",
	sdh: "SDH",
	forced: "Forced",
	commentary: "Commentary",
	honorifics: "Honorifics",
	storyboard: "Storyboard",
};

function renderTracks(): void {
	const container = byId("subocr-tracks");
	if (scope !== "file" || !targetPath) {
		container.innerHTML = "";
		return;
	}
	if (!tracks) {
		container.innerHTML = '<div class="library-loading">Reading the video...</div>';
		return;
	}
	const pictures = tracks.filter((t) => t.picture);
	if (!pictures.length) {
		container.innerHTML = `<div class="lang-filter-hint">${sourcePath ? "The original" : "This video"} has no PGS picture subtitles.${
			sourcePath ? "" : " If its original still has them, choose the original."
		}</div>`;
		return;
	}
	const rows = pictures
		.map((t) => {
			const note = t.hasText ? '<span class="hdr-note">has a text track already</span>' : "";
			return `<label class="toggle-label subocr-track">
				<input type="checkbox" data-subocr-track="${t.index}"${chosen.has(t.index) ? " checked" : ""} />
				<span>Track ${t.index}: ${escapeHtml(t.languageName)} <span class="hdr-note">${escapeHtml(t.language)}</span>, ${escapeHtml(TYPE_LABELS[t.type] ?? t.type)}${
					t.title ? `, ${escapeHtml(t.title)}` : ""
				} ${note}</span>
			</label>`;
		})
		.join("");
	const heading = sourcePath ? "Picture subtitle tracks of the original" : "Picture subtitle tracks";
	const timing = sourcePath
		? '<div class="lang-filter-hint">The text is checked against the video\'s own subtitles or audio, and shifted when the video was cut or delayed. If it does not fit, it is not added.</div>'
		: "";
	container.innerHTML = `<div class="setting-group"><label>${heading}</label>${rows}${timing}</div>`;
}

const METHOD_LABELS: Record<OcrPair["method"], string> = { episode: "same episode", order: "file order", none: "no match" };

function renderPairs(): void {
	const container = byId("subocr-pairs");
	if (scope !== "folder" || !sourceFolder || !pairs) {
		container.innerHTML = "";
		return;
	}
	const rows = pairs
		.map((pair) => {
			const usable = !!pair.sourcePath;
			const on = usable && !skippedPairs.has(pair.targetPath);
			return `<label class="toggle-label subocr-track">
				<input type="checkbox" data-subocr-pair="${escapeHtml(pair.targetPath)}"${on ? " checked" : ""}${usable ? "" : " disabled"} />
				<span>${escapeHtml(pair.targetName)} <span class="hdr-note">${usable ? `from ${escapeHtml(pair.sourceName)}, ${METHOD_LABELS[pair.method]}` : "no original found"}</span></span>
			</label>`;
		})
		.join("");
	const unmatched = unmatchedSources ? `<div class="lang-filter-hint">${unmatchedSources} original(s) matched no encode.</div>` : "";
	container.innerHTML = `<div class="setting-group"><label>Encodes and their originals</label>${rows}${unmatched}</div>`;
}

function chosenPairs(): OcrPair[] {
	return (pairs ?? []).filter((pair) => pair.sourcePath && !skippedPairs.has(pair.targetPath));
}

function updateQueueButton(): void {
	const folderReady = !!folderPath && (!sourceFolder || chosenPairs().length > 0);
	const ready = configured() && (scope === "file" ? !!targetPath && chosen.size > 0 : folderReady);
	buttonById("subocr-queue").disabled = !ready;
	// Picture tracks of an original are not in the video, so there is nothing to remove from it.
	const original = scope === "file" ? !!sourcePath : !!sourceFolder;
	const remove = inputById("subocr-remove");
	remove.disabled = original;
	if (original) remove.checked = false;
}

function render(): void {
	byId("subocr-setup").style.display = configured() ? "none" : "";
	byId("subocr-file-choice").style.display = scope === "file" ? "" : "none";
	byId("subocr-folder-choice").style.display = scope === "folder" ? "" : "none";
	byId("subocr-folder-options").style.display = scope === "folder" ? "" : "none";
	byId("subocr-target-selection").innerHTML = selection(targetPath, "No video selected");
	byId("subocr-folder-selection").innerHTML = selection(folderPath, "No folder selected");
	byId("subocr-source-choice").style.display = scope === "file" ? "" : "none";
	byId("subocr-source-selection").innerHTML = selection(sourcePath, "None, read the video's own picture subtitles");
	byId("subocr-clear-source").style.display = sourcePath ? "" : "none";
	byId("subocr-source-folder-choice").style.display = scope === "folder" ? "" : "none";
	byId("subocr-source-folder-selection").innerHTML = selection(sourceFolder, "None, read each encode's own picture subtitles");
	byId("subocr-clear-source-folder").style.display = sourceFolder ? "" : "none";
	byId("subocr-match").style.display = sourceFolder && folderPath ? "" : "none";
	renderTracks();
	renderPairs();
	updateQueueButton();
}

async function inspect(): Promise<void> {
	const current = ++inspectRun;
	tracks = null;
	chosen.clear();
	setError("");
	render();
	try {
		const result = await fetchOcrTracks(targetPath, sourcePath || undefined);
		if (current !== inspectRun) return;
		tracks = result.tracks;
		// Tracks without a text version are what OCR is for, so they start chosen.
		for (const t of tracks) if (t.picture && !t.hasText && t.type !== "storyboard") chosen.add(t.index);
	} catch (error) {
		if (current !== inspectRun) return;
		setError(errorMessage(error));
		targetPath = "";
	}
	render();
}

export function openSubtitleOcr(): void {
	byId("subocr-modal").style.display = "";
	byId("subocr-result").textContent = "";
	renderRadioPills(
		byId("subocr-scope"),
		["file", "folder"] as const,
		scope,
		(value) => {
			scope = value;
			setError("");
			render();
		},
		(value) => (value === "file" ? "One file" : "Every MKV in a folder"),
	);
	render();
}

export function closeSubtitleOcr(): void {
	byId("subocr-modal").style.display = "none";
}

export function closeSubtitleOcrIfOutside(event: MouseEvent): void {
	if (event.target === event.currentTarget) closeSubtitleOcr();
}

export function chooseSubtitleOcrTarget(): void {
	openSubtitleOcrPicker((path) => {
		targetPath = path;
		byId("subocr-result").textContent = "";
		void inspect();
	});
}

export function chooseSubtitleOcrFolder(): void {
	openRepairFolderPicker((path) => {
		folderPath = path;
		pairs = null;
		byId("subocr-result").textContent = "";
		render();
	});
}

export function chooseSubtitleOcrSource(): void {
	openHdrSourcePicker((path) => {
		sourcePath = path;
		if (targetPath) void inspect();
		else render();
	});
}

export function clearSubtitleOcrSource(): void {
	sourcePath = "";
	if (targetPath) void inspect();
	else render();
}

export function chooseSubtitleOcrSourceFolder(): void {
	openRepairFolderPicker((path) => {
		sourceFolder = path;
		pairs = null;
		render();
	});
}

export function clearSubtitleOcrSourceFolder(): void {
	sourceFolder = "";
	pairs = null;
	render();
}

export async function matchSubtitleOcrFiles(): Promise<void> {
	setError("");
	const button = buttonById("subocr-match");
	button.disabled = true;
	try {
		const result = await fetchOcrPairs(folderPath, sourceFolder, inputById("subocr-recursive").checked);
		pairs = result.pairs;
		unmatchedSources = result.unmatchedSources.length;
		skippedPairs.clear();
	} catch (error) {
		setError(errorMessage(error));
	}
	button.disabled = false;
	render();
}

/** Matched pairs depend on the folders and on subfolders being included, so they are matched again. */
export function resetSubtitleOcrPairs(): void {
	pairs = null;
	render();
}

export function handleSubtitleOcrPairsChange(event: Event): void {
	const input = event.target as HTMLInputElement;
	const target = input.dataset?.subocrPair;
	if (!target) return;
	if (input.checked) skippedPairs.delete(target);
	else skippedPairs.add(target);
	updateQueueButton();
}

export function handleSubtitleOcrTracksChange(event: Event): void {
	const input = event.target as HTMLInputElement;
	const index = Number(input.dataset?.subocrTrack);
	if (!Number.isInteger(index)) return;
	if (input.checked) chosen.add(index);
	else chosen.delete(index);
	updateQueueButton();
}

export async function queueSubtitleOcr(): Promise<void> {
	const button = buttonById("subocr-queue");
	button.disabled = true;
	setError("");
	const removePictures = inputById("subocr-remove").checked;
	try {
		if (scope === "file") {
			await queueOcrJob(targetPath, [...chosen], removePictures, sourcePath || undefined);
			byId("subocr-result").textContent = `Queued OCR for ${fileName(targetPath)}.`;
		} else {
			const languages = inputById("subocr-languages")
				.value.split(",")
				.map((l) => l.trim())
				.filter(Boolean);
			if (sourceFolder && !pairs) throw new Error("Match the encodes with their originals first");
			const result = await queueOcrBatch({
				folder: folderPath,
				recursive: inputById("subocr-recursive").checked,
				languages,
				removePictures,
				...(sourceFolder ? { pairs: chosenPairs().map((p) => ({ targetPath: p.targetPath, sourcePath: p.sourcePath })) } : {}),
			});
			byId("subocr-result").textContent = `Queued ${result.jobIds.length} ${result.jobIds.length === 1 ? "file" : "files"}${
				result.skipped.length ? `, ${result.skipped.length} already have an unfinished job` : ""
			}.`;
		}
		await update();
	} catch (error) {
		setError(errorMessage(error));
	}
	updateQueueButton();
}
