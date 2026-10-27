import { authFetch, fetchSelectionSeries, prepareSelectionSeriesNotes, type SelectionSeries } from "../api/client";
import { API } from "../config/api-base";
import { TRANSLATE_PROVIDER_LABELS } from "../config/options";
import { buttonById, byId, inputById } from "../shared/dom";
import { errorMessage } from "../shared/errors";
import { appState } from "../state";
import { update } from "./polling";
import { openSeriesNotesModal } from "./series-notes-modal";
import { openRepairFolderPicker, openTranslateTargetPicker } from "./repair";

const STORAGE_KEY = "rabbit-library-translate";

let selectedPaths: string[] = [];
/** Bumped on every open, so a slow reply from an earlier selection is ignored. */
let notesLoad = 0;

interface LastChoice {
	source: string;
	type: string;
	targets: string;
	references?: string;
	download?: boolean;
	aiFallback?: boolean;
	extraLanguages?: number;
}

function loadLastChoice(): Partial<LastChoice> {
	try {
		return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
	} catch {
		return {};
	}
}

function saveLastChoice(choice: LastChoice): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
	} catch {}
}

function showError(message: string): void {
	const el = byId("library-translate-error");
	el.textContent = message;
	el.style.display = message ? "" : "none";
}

function parseLanguages(value: string): string[] {
	return value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

function hasAiProvider(): boolean {
	const d = appState.defaults;
	return !!d?.translateBaseUrl?.trim() && !!d?.translateModel?.trim();
}

function hasOpenSubtitles(): boolean {
	return !!appState.defaults?.openSubtitlesUsername?.trim() && !!appState.defaults?.openSubtitlesPassword;
}

/** Describes what the batch will use and allows queueing only when it can do something. */
function renderSources(): void {
	const d = appState.defaults;
	const download = inputById("library-translate-download");
	const ai = inputById("library-translate-ai-fallback");
	const downloadHint = byId("library-translate-download-hint");
	download.disabled = !hasOpenSubtitles();
	if (download.disabled) download.checked = false;
	byId<HTMLSelectElement>("library-translate-extra").disabled = !download.checked;
	downloadHint.textContent = hasOpenSubtitles()
		? "Missing languages are downloaded, synced to each video and rated. A subtitle below the minimum rating is not used."
		: "Log in with your OpenSubtitles.com account under Settings, Subtitle handling, Subtitle download to download subtitles first.";

	const el = byId("library-translate-ai");
	if (!ai.checked) el.textContent = "Languages without a good subtitle are left out.";
	else if (!hasAiProvider()) el.textContent = "No AI provider is set up yet. Add one under Settings, Subtitle handling, Subtitle translation.";
	else
		el.textContent = `Uses ${d!.translateModel} at ${d!.translateBaseUrl} (${TRANSLATE_PROVIDER_LABELS[d!.translateProvider ?? "openai"]}). Change it under Settings, Subtitle translation.`;

	const ready = (download.checked && hasOpenSubtitles()) || ai.checked;
	buttonById("library-translate-submit").disabled = !ready || (ai.checked && !hasAiProvider()) || selectedPaths.length === 0;
}

export function handleTranslateSourcesChange(): void {
	renderSources();
}

function seriesRow(series: SelectionSeries): HTMLElement {
	const row = document.createElement("div");
	row.className = "series-notes-row";
	const title = document.createElement("div");
	title.className = "series-notes-row-title";
	title.textContent = `${series.title} (${series.files} file${series.files === 1 ? "" : "s"})`;
	const status = document.createElement("span");
	const button = document.createElement("button");
	button.className = "btn btn-ghost btn-sm";

	if (series.episodes > 0) {
		status.className = "series-notes-row-status ready";
		status.textContent = `Notes from ${series.episodes} episode${series.episodes === 1 ? "" : "s"}`;
		button.textContent = "Edit";
		button.onclick = () => void openSeriesNotesModal(series.key, () => void loadSeriesNotes());
	} else {
		status.className = "series-notes-row-status missing";
		status.textContent = "No notes yet";
		button.textContent = "Prepare";
		button.onclick = async () => {
			button.disabled = true;
			button.textContent = "Preparing...";
			status.className = "series-notes-row-status";
			status.textContent = "Reading the first episode";
			const r = await prepareSelectionSeriesNotes(
				series.firstFile,
				inputById("library-translate-source").value.trim(),
				byId<HTMLSelectElement>("library-translate-type").value,
				parseLanguages(inputById("library-translate-references").value),
			);
			if (!r.ok) {
				button.disabled = false;
				button.textContent = "Prepare";
				status.className = "series-notes-row-status failed";
				status.textContent = r.error || "Prepare failed";
				return;
			}
			void openSeriesNotesModal(r.key ?? series.key, () => void loadSeriesNotes());
			void loadSeriesNotes();
		};
	}

	row.append(title, status, button);
	return row;
}

async function loadSeriesNotes(): Promise<void> {
	const load = ++notesLoad;
	const section = byId("library-translate-notes");
	const list = byId("library-translate-notes-list");
	try {
		const data = await fetchSelectionSeries(selectedPaths);
		if (load !== notesLoad) return;
		if (!data.enabled || data.series.length === 0) {
			section.style.display = "none";
			return;
		}
		list.replaceChildren(...data.series.map(seriesRow));
		section.style.display = "";
	} catch {
		if (load === notesLoad) section.style.display = "none";
	}
}

export function openTranslateSetup(paths: string[], fileCount: number | null): void {
	selectedPaths = [...paths];
	byId("library-translate-pick").style.display = "none";
	const last = loadLastChoice();
	const defaultTargets = appState.defaults?.translateTargetLanguages?.join(", ") ?? "";
	inputById("library-translate-source").value = last.source || "eng";
	byId<HTMLSelectElement>("library-translate-type").value = last.type || "full";
	inputById("library-translate-targets").value = last.targets || defaultTargets;
	inputById("library-translate-references").value = last.references ?? appState.defaults?.translateReferenceLanguages?.join(", ") ?? "";
	byId("library-translate-count").textContent =
		fileCount === null ? "Selected videos will be counted when queued" : `${fileCount} video${fileCount === 1 ? "" : "s"} selected`;
	inputById("library-translate-download").checked = last.download ?? appState.defaults?.subtitleDownloadBeforeTranslate !== false;
	inputById("library-translate-ai-fallback").checked = last.aiFallback ?? appState.defaults?.subtitleDownloadAiFallback !== false;
	byId<HTMLSelectElement>("library-translate-extra").value = String(last.extraLanguages ?? appState.defaults?.subtitleDownloadExtraLanguages ?? 0);
	showError("");
	renderSources();
	byId("library-translate-notes").style.display = "none";
	byId("library-translate-modal").style.display = "";
	inputById("library-translate-targets").focus();
	void loadSeriesNotes();
}

const escapeHtml = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Shows the chosen video or folder of the Subtitles menu entry. */
function renderPicked(kind: "video" | "folder" | null): void {
	const path = selectedPaths[0];
	byId("library-translate-pick-selection").innerHTML = path
		? `<span class="repair-file-name" title="${escapeHtml(path)}">${escapeHtml(path.slice(path.lastIndexOf("/") + 1))}</span><span class="repair-file-folder">${escapeHtml(path)}</span>`
		: '<span class="repair-file-empty">No video or folder selected</span>';
	byId("library-translate-count").textContent = !path
		? "Choose a video or a folder"
		: kind === "video"
			? "1 video selected"
			: "Videos in the folder and its subfolders are counted when queued";
	renderSources();
	if (path) void loadSeriesNotes();
	else byId("library-translate-notes").style.display = "none";
}

/** The same window, opened from the Subtitles menu for any video or folder Rabbit can reach. */
export function openTranslateTool(): void {
	openTranslateSetup([], null);
	byId("library-translate-pick").style.display = "";
	renderPicked(null);
}

export function chooseTranslateVideo(): void {
	openTranslateTargetPicker((path) => {
		selectedPaths = [path];
		renderPicked("video");
	});
}

export function chooseTranslateFolder(): void {
	openRepairFolderPicker((path) => {
		selectedPaths = [path];
		renderPicked("folder");
	});
}

export function closeTranslateSetup(): void {
	byId("library-translate-modal").style.display = "none";
}

export function closeTranslateSetupIfOutside(event: MouseEvent): void {
	if (event.target === event.currentTarget) closeTranslateSetup();
}

export async function submitTranslateSetup(): Promise<void> {
	const button = buttonById("library-translate-submit");
	const choice: LastChoice = {
		source: inputById("library-translate-source").value.trim(),
		type: byId<HTMLSelectElement>("library-translate-type").value,
		targets: inputById("library-translate-targets").value.trim(),
		references: inputById("library-translate-references").value.trim(),
		download: inputById("library-translate-download").checked,
		aiFallback: inputById("library-translate-ai-fallback").checked,
		extraLanguages: Number(byId<HTMLSelectElement>("library-translate-extra").value),
	};
	const targetLanguages = parseLanguages(choice.targets);
	if (!choice.source) return showError("Enter the language to translate from");
	if (!targetLanguages.length) return showError("Enter at least one language to translate to");

	button.disabled = true;
	showError("");
	try {
		const res = await authFetch(`${API}/api/library/translate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				paths: selectedPaths,
				sourceLanguage: choice.source,
				sourceType: choice.type,
				targetLanguages,
				referenceLanguages: parseLanguages(choice.references ?? ""),
				download: choice.download,
				aiFallback: choice.aiFallback,
				extraLanguages: choice.download ? choice.extraLanguages : 0,
			}),
		});
		const data = await res.json();
		if (!res.ok) throw new Error(data.error || "Failed to queue translations");
		saveLastChoice(choice);
		const notes: string[] = [];
		if (data.added) notes.push(`Queued ${data.added} translation${data.added === 1 ? "" : "s"}`);
		if (data.skipped) notes.push(`${data.skipped} already queued`);
		byId("library-note").textContent = notes.join(", ") || "No video files found to translate";
		closeTranslateSetup();
		if (data.added) {
			byId("library-modal").style.display = "none";
			void update();
		}
	} catch (error) {
		showError(errorMessage(error));
	} finally {
		button.disabled = false;
	}
}
