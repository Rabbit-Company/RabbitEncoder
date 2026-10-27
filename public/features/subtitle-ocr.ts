import { fetchOcrTracks, queueOcrBatch, queueOcrJob, type OcrTrackInfo } from "../api/client";
import { buttonById, byId, inputById } from "../shared/dom";
import { errorMessage } from "../shared/errors";
import { appState } from "../state";
import { update } from "./polling";
import { openRepairFolderPicker, openSubtitleOcrPicker } from "./repair";
import { renderRadioPills } from "./settings-controls";

type Scope = "file" | "folder";

let scope: Scope = "file";
let targetPath = "";
let folderPath = "";
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
		container.innerHTML = '<div class="lang-filter-hint">This video has no PGS picture subtitles.</div>';
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
	container.innerHTML = `<div class="setting-group"><label>Picture subtitle tracks</label>${rows}</div>`;
}

function updateQueueButton(): void {
	const ready = configured() && (scope === "file" ? !!targetPath && chosen.size > 0 : !!folderPath);
	buttonById("subocr-queue").disabled = !ready;
}

function render(): void {
	byId("subocr-setup").style.display = configured() ? "none" : "";
	byId("subocr-file-choice").style.display = scope === "file" ? "" : "none";
	byId("subocr-folder-choice").style.display = scope === "folder" ? "" : "none";
	byId("subocr-folder-options").style.display = scope === "folder" ? "" : "none";
	byId("subocr-target-selection").innerHTML = selection(targetPath, "No video selected");
	byId("subocr-folder-selection").innerHTML = selection(folderPath, "No folder selected");
	renderTracks();
	updateQueueButton();
}

async function inspect(): Promise<void> {
	const current = ++inspectRun;
	tracks = null;
	chosen.clear();
	setError("");
	render();
	try {
		const result = await fetchOcrTracks(targetPath);
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
		byId("subocr-result").textContent = "";
		render();
	});
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
			await queueOcrJob(targetPath, [...chosen], removePictures);
			byId("subocr-result").textContent = `Queued OCR for ${fileName(targetPath)}.`;
		} else {
			const languages = inputById("subocr-languages")
				.value.split(",")
				.map((l) => l.trim())
				.filter(Boolean);
			const result = await queueOcrBatch({ folder: folderPath, recursive: inputById("subocr-recursive").checked, languages, removePictures });
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
