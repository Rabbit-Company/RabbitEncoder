import { authFetch } from "../api/client";
import { API } from "../config/api-base";
import { buttonById, byId, inputById } from "../shared/dom";
import { errorMessage } from "../shared/errors";
import { appState } from "../state";
import { escapeHtml } from "./job-render";
import { update } from "./polling";
import { openPreviewReferencePicker, openRepairFolderPicker } from "./repair";

interface SourcePair {
	targetPath: string;
	sourcePath: string;
	targetName: string;
	method: "episode" | "filename" | "single" | "none";
}

let selectedPaths: string[] = [];
let sourceSelection = "";
let sourceChoices: { path: string; name: string }[] = [];
let pairs: SourcePair[] = [];
let selectionVersion = 0;

function showError(message: string): void {
	const el = byId("library-queue-error");
	el.textContent = message;
	el.style.display = message ? "" : "none";
}

function duplicates(): Set<string> {
	const seen = new Set<string>();
	const repeated = new Set<string>();
	for (const pair of pairs) {
		if (!pair.sourcePath) continue;
		if (seen.has(pair.sourcePath)) repeated.add(pair.sourcePath);
		seen.add(pair.sourcePath);
	}
	return repeated;
}

function render(): void {
	byId("library-queue-source").textContent = sourceSelection || "No original selected";
	const duplicatePaths = duplicates();
	const mapped = pairs.filter((pair) => pair.sourcePath).length;
	byId("library-queue-pairs").innerHTML = pairs
		.map((pair, index) => {
			const choices = [
				`<option value="">No original — encode without FGS</option>`,
				...sourceChoices.map(
					(source) => `<option value="${escapeHtml(source.path)}" ${pair.sourcePath === source.path ? "selected" : ""}>${escapeHtml(source.name)}</option>`,
				),
			];
			return `<div class="repair-pair-row">
			<div class="repair-pair-target"><span class="repair-file-name" title="${escapeHtml(pair.targetPath)}">${escapeHtml(pair.targetName)}</span>
				<span class="repair-pair-method">${pair.method === "none" ? "Check this match" : `Matched by ${escapeHtml(pair.method)}`}</span></div>
			<div class="repair-pair-arrow" aria-hidden="true">←</div>
			<div class="repair-pair-source"><select class="select-input" data-library-pair-index="${index}" aria-label="Original for ${escapeHtml(pair.targetName)}">${choices.join("")}</select>
				${duplicatePaths.has(pair.sourcePath) && pair.sourcePath ? '<span class="repair-pair-warning">Original used twice</span>' : ""}</div>
		</div>`;
		})
		.join("");
	const toggle = inputById("library-queue-fgs") as HTMLInputElement;
	toggle.disabled = mapped === 0;
	if (mapped === 0) toggle.checked = false;
	byId<HTMLSelectElement>("library-queue-sampling").disabled = mapped === 0;
	byId<HTMLSelectElement>("library-queue-range").disabled = mapped === 0;
	byId("library-queue-summary").textContent = sourceSelection
		? `${mapped} of ${pairs.length} videos mapped to originals${duplicatePaths.size ? ` | ${duplicatePaths.size} duplicate source${duplicatePaths.size === 1 ? "" : "s"}` : ""}. Unmapped videos encode without automatic FGS.`
		: "Adding originals is optional. Without a mapping, videos encode without automatic FGS.";
	buttonById("library-queue-submit").disabled = duplicatePaths.size > 0;
}

export function openQueueSetup(paths: string[]): void {
	selectedPaths = [...paths];
	sourceSelection = "";
	sourceChoices = [];
	pairs = [];
	selectionVersion++;
	showError("");
	inputById("library-queue-fgs").checked = false;
	byId<HTMLSelectElement>("library-queue-sampling").value = appState.defaults?.filmGrainSampling ?? "all";
	byId<HTMLSelectElement>("library-queue-range").value = appState.defaults?.filmGrainRange ?? "representative";
	byId("library-queue-count").textContent = `${paths.length} selected file${paths.length === 1 ? " or folder" : "s or folders"}`;
	render();
	byId("library-queue-modal").style.display = "";
}

export function closeQueueSetup(): void {
	selectionVersion++;
	byId("library-queue-modal").style.display = "none";
}

export function closeQueueSetupIfOutside(event: MouseEvent): void {
	if (event.target === event.currentTarget) closeQueueSetup();
}

async function chooseSource(path: string): Promise<void> {
	const version = ++selectionVersion;
	sourceSelection = path;
	sourceChoices = [];
	pairs = [];
	showError("");
	byId("library-queue-summary").textContent = "Matching originals...";
	byId("library-queue-source").textContent = path;
	buttonById("library-queue-submit").disabled = true;
	try {
		const res = await authFetch(`${API}/api/library/source-pairs`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ paths: selectedPaths, sourcePath: path }),
		});
		const data = await res.json();
		if (!res.ok) throw new Error(data.error || "Failed to match originals");
		if (version !== selectionVersion) return;
		pairs = data.pairs;
		sourceChoices = data.sources;
		inputById("library-queue-fgs").checked = pairs.some((pair) => pair.sourcePath);
		render();
	} catch (error) {
		if (version !== selectionVersion) return;
		showError(errorMessage(error));
		sourceSelection = "";
		render();
	}
}

export function pickQueueOriginalFile(): void {
	openPreviewReferencePicker((path) => {
		void chooseSource(path);
	});
}

export function pickQueueOriginalFolder(): void {
	openRepairFolderPicker((path) => {
		void chooseSource(path);
	});
}

export function clearQueueOriginal(): void {
	selectionVersion++;
	sourceSelection = "";
	sourceChoices = [];
	pairs = [];
	showError("");
	render();
}

export function changeQueuePair(event: Event): void {
	const select = event.target;
	if (!(select instanceof HTMLSelectElement)) return;
	const index = Number(select.dataset.libraryPairIndex);
	if (!Number.isInteger(index) || !pairs[index]) return;
	pairs[index]!.sourcePath = select.value;
	render();
}

export async function submitQueueSetup(): Promise<void> {
	if (duplicates().size) return;
	const button = buttonById("library-queue-submit");
	button.disabled = true;
	showError("");
	const sourceMap = Object.fromEntries(pairs.filter((pair) => pair.sourcePath).map((pair) => [pair.targetPath, pair.sourcePath]));
	try {
		const res = await authFetch(`${API}/api/library/encode`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				paths: selectedPaths,
				sourceMap,
				autoFilmGrain: inputById("library-queue-fgs").checked,
				filmGrainSampling: byId<HTMLSelectElement>("library-queue-sampling").value,
				filmGrainRange: byId<HTMLSelectElement>("library-queue-range").value,
			}),
		});
		const data = await res.json();
		if (!res.ok) throw new Error(data.error || "Failed to queue videos");
		const notes: string[] = [];
		if (data.added) notes.push(`Queued ${data.added} video${data.added === 1 ? "" : "s"}`);
		if (data.skipped) notes.push(`${data.skipped} already queued`);
		if (data.alreadyEncoded) notes.push(`${data.alreadyEncoded} already encoded`);
		byId("library-note").textContent = notes.join(", ") || "No video files found to encode";
		closeQueueSetup();
		if (data.added) {
			byId("library-modal").style.display = "none";
			void update();
		}
	} catch (error) {
		showError(errorMessage(error));
		button.disabled = false;
	}
}
