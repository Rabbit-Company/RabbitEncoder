import { authFetch } from "../api/client";
import { API } from "../config/api-base";
import { byId, buttonById, inputById } from "../shared/dom";
import { errorMessage } from "../shared/errors";
import { openSubtitleFilePicker } from "./repair";
import type { RepairInspectionFile } from "../types";
import { editorFormat, effectiveEditorOffset, type SubtitleEditorCue, type SubtitleEditorEdit, type SubtitleEditorFormat } from "../../src/subtitles/editor";

interface LoadedTrack {
	format: SubtitleEditorFormat;
	cues: SubtitleEditorCue[];
	changes: Map<number, SubtitleEditorCue>;
	offsetMs: number;
	selected: number;
}
let file: (RepairInspectionFile & { fingerprint: string }) | null = null;
const tracks = new Map<number, LoadedTrack>();
let trackId = -1;
let generation = 0;
let previewGeneration = 0;
let previewAbort: AbortController | null = null;
let loadingAbort: AbortController | null = null;
let previewTimer: ReturnType<typeof setTimeout> | null = null;
let previewUrl = "";
let saving = false;
let invalid = false;
let manualLoop = false;

const video = () => byId<HTMLVideoElement>("subtitle-editor-video");
const current = () => tracks.get(trackId);
const effectiveCue = (track: LoadedTrack, index: number) => {
	const cue = track.cues[index];
	return cue ? track.changes.get(cue.id) || cue : undefined;
};
const select = (id: string) => byId<HTMLSelectElement>(id);

function setError(message: string): void {
	byId("subtitle-editor-error").textContent = message;
	byId("subtitle-editor-error").style.display = message ? "" : "none";
}
function status(message: string): void {
	byId("subtitle-editor-status").textContent = message;
}
function updateSave(): void {
	buttonById("subtitle-editor-save").disabled = saving || invalid || !file || ![...tracks.values()].some((track) => track.offsetMs || track.changes.size);
}
function editFor(id: number, track: LoadedTrack): SubtitleEditorEdit {
	return { trackId: id, offsetMs: track.offsetMs, cues: [...track.changes.values()] };
}
async function jsonRequest(route: string, body: unknown, signal?: AbortSignal): Promise<any> {
	const response = await authFetch(`${API}/api/subtitle-editor/${route}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});
	const data = await response.json();
	if (!response.ok) throw new Error(data.error || "Subtitle editor request failed");
	return data;
}

function stopPreview(): void {
	previewGeneration++;
	if (previewTimer) clearTimeout(previewTimer);
	previewTimer = null;
	previewAbort?.abort();
	previewAbort = null;
	video().pause();
}
function clearVideo(): void {
	video().removeAttribute("src");
	video().load();
	if (previewUrl) URL.revokeObjectURL(previewUrl);
	previewUrl = "";
}

export function openSubtitleEditor(): void {
	byId("subtitle-editor-modal").style.display = "";
	if (current()?.cues.length) schedulePreview();
	else if (file && trackId >= 0) void loadTrack(trackId);
}
export function closeSubtitleEditor(): void {
	if (saving) return;
	byId("subtitle-editor-modal").style.display = "none";
	generation++;
	loadingAbort?.abort();
	stopPreview();
	clearVideo();
}
export function pickSubtitleEditorFile(): void {
	if (saving) return;
	openSubtitleFilePicker(loadFile);
}
async function loadFile(path: string): Promise<void> {
	const version = ++generation;
	loadingAbort?.abort();
	loadingAbort = new AbortController();
	stopPreview();
	clearVideo();
	file = null;
	tracks.clear();
	trackId = -1;
	invalid = false;
	byId("subtitle-editor-workspace").style.display = "none";
	byId("subtitle-editor-file").textContent = path;
	byId("subtitle-editor-output").textContent = "";
	setError("");
	status("Inspecting MKV...");
	updateSave();
	try {
		const response = await authFetch(`${API}/api/subtitle-editor/inspect?${new URLSearchParams({ path })}`, { signal: loadingAbort.signal });
		const data = await response.json();
		if (!response.ok) throw new Error(data.error || "Could not inspect MKV");
		if (version !== generation) return;
		file = data;
		const options = select("subtitle-editor-track");
		options.replaceChildren();
		for (const track of file!.subtitles) {
			const option = new Option(`#${track.id} · ${track.language} · ${track.title || track.codec}`, String(track.id));
			option.disabled = !editorFormat(track.codecId);
			options.add(option);
		}
		const first = file!.subtitles.find((track) => editorFormat(track.codecId));
		if (!first) {
			status("No supported subtitles in this MKV.");
			return;
		}
		options.value = String(first.id);
		byId("subtitle-editor-workspace").style.display = "";
		await loadTrack(first.id);
	} catch (error) {
		if (version === generation) {
			setError(errorMessage(error));
			status("");
		}
	}
}

async function loadTrack(id: number): Promise<void> {
	if (!file) return;
	const version = ++generation;
	loadingAbort?.abort();
	loadingAbort = new AbortController();
	stopPreview();
	clearVideo();
	trackId = id;
	invalid = false;
	setError("");
	byId("subtitle-editor-cue-fields").style.display = "none";
	try {
		if (!tracks.has(id)) {
			status("Extracting subtitle cues...");
			const data = await jsonRequest("track", { path: file.path, fingerprint: file.fingerprint, trackId: id }, loadingAbort.signal);
			if (version !== generation) return;
			const cues: SubtitleEditorCue[] = data.cues;
			let selected = 0;
			const midpoint = file.durationSeconds * 500;
			for (let i = 1; i < cues.length; i++) if (Math.abs(cues[i]!.startMs - midpoint) < Math.abs(cues[selected]!.startMs - midpoint)) selected = i;
			tracks.set(id, { format: data.format, cues, changes: new Map(), offsetMs: 0, selected });
		}
		if (version !== generation) return;
		const track = current()!;
		inputById("subtitle-editor-offset").value = String(track.offsetMs);
		byId("subtitle-editor-format-hint").textContent =
			track.format === "bitmap"
				? "Bitmap subtitles use a track delay. Text and individual image cue times cannot be edited."
				: `${track.format.toUpperCase()} cue times are rewritten directly. ${track.format !== "srt" ? "ASS styles and override tags are preserved. Use \\N for line breaks. Offsets are rounded to the nearest 10 ms." : ""}`;
		const cues = select("subtitle-editor-cues");
		cues.replaceChildren();
		track.cues.forEach((cue, i) =>
			cues.add(new Option(`${i + 1} · ${(cue.startMs / 1000).toFixed(2)}s · ${cue.text.replace(/\{[^}]*\}/g, "").slice(0, 90)}`, String(i))),
		);
		if (!track.cues.length) {
			status("This subtitle track has no cues.");
			updateSave();
			return;
		}
		byId("subtitle-editor-cue-fields").style.display = "";
		renderCue();
	} catch (error) {
		if (version === generation) {
			setError(errorMessage(error));
			status("");
		}
	}
}

function loopFromCue(): void {
	const track = current();
	const cue = track && effectiveCue(track, track.selected);
	if (!track || !cue || !file) return;
	const before = Number(inputById("subtitle-editor-before").value);
	const after = Number(inputById("subtitle-editor-after").value);
	if (!Number.isFinite(before) || before < 0 || before > 60 || !Number.isFinite(after) || after < 0 || after > 60)
		throw new Error("Loop padding must be between 0 and 60 seconds");
	const offset = effectiveEditorOffset(track.offsetMs, track.format);
	const start = Math.max(0, (cue.startMs + offset) / 1000 - before);
	const end = Math.min(file.durationSeconds || Infinity, (cue.endMs + offset) / 1000 + after);
	inputById("subtitle-editor-loop-start").value = start.toFixed(3);
	inputById("subtitle-editor-loop-duration").value = Math.max(0.1, Math.min(120, end - start)).toFixed(3);
}
function renderCue(): void {
	const track = current()!;
	const cue = effectiveCue(track, track.selected)!;
	select("subtitle-editor-cues").value = String(track.selected);
	inputById("subtitle-editor-cue-start").value = String(cue.startMs / 1000);
	inputById("subtitle-editor-cue-end").value = String(cue.endMs / 1000);
	byId<HTMLTextAreaElement>("subtitle-editor-text").value = cue.text;
	for (const id of ["subtitle-editor-cue-start", "subtitle-editor-cue-end", "subtitle-editor-text"])
		(byId(id) as HTMLInputElement).disabled = track.format === "bitmap";
	buttonById("subtitle-editor-previous").disabled = track.selected === 0;
	buttonById("subtitle-editor-next").disabled = track.selected === track.cues.length - 1;
	byId("subtitle-editor-cue-label").textContent = `Cue ${track.selected + 1} of ${track.cues.length}${cue.style ? ` · ${cue.style}` : ""}`;
	manualLoop = false;
	invalid = false;
	try {
		loopFromCue();
		schedulePreview();
	} catch (error) {
		setError(errorMessage(error));
	}
	updateSave();
}

function captureCue(): boolean {
	const track = current();
	if (!track) return true;
	const offsetInput = inputById("subtitle-editor-offset");
	const offset = Number(offsetInput.value);
	if (!offsetInput.value || !Number.isFinite(offset) || Math.abs(offset) > 86_400_000) {
		invalid = true;
		stopPreview();
		setError("Offset must be within ±86400000 milliseconds.");
		updateSave();
		return false;
	}
	track.offsetMs = Math.round(offset);
	const original = track?.cues[track.selected];
	if (!original || track.format === "bitmap") {
		invalid = false;
		updateSave();
		return true;
	}
	const startMs = Number(inputById("subtitle-editor-cue-start").value) * 1000;
	const endMs = Number(inputById("subtitle-editor-cue-end").value) * 1000;
	const text = byId<HTMLTextAreaElement>("subtitle-editor-text").value;
	if (original.startMs === startMs && original.endMs === endMs && original.text === text) {
		track.changes.delete(original.id);
		invalid = false;
		updateSave();
		return true;
	}
	const existingZeroDuration = track.format !== "srt" && startMs === original.startMs && endMs === original.endMs && endMs === startMs;
	if (
		!inputById("subtitle-editor-cue-start").value ||
		!inputById("subtitle-editor-cue-end").value ||
		!Number.isFinite(startMs) ||
		startMs < 0 ||
		!Number.isFinite(endMs) ||
		(endMs <= startMs && !existingZeroDuration) ||
		endMs > 86_400_000 ||
		(track.format === "srt" && /\n\s*\n/.test(text))
	) {
		invalid = true;
		setError("Cue end must follow its start (0 to 86400 seconds). SRT cues cannot contain blank lines.");
		stopPreview();
		updateSave();
		return false;
	}
	invalid = false;
	track.changes.set(original.id, { ...original, startMs, endMs, text });
	updateSave();
	return true;
}

function schedulePreview(): void {
	stopPreview();
	status("Updating preview...");
	previewTimer = setTimeout(() => void refreshPreview(), 500);
}
async function refreshPreview(): Promise<void> {
	const track = current();
	if (!file || !track || !track.cues.length || invalid) return;
	const version = ++previewGeneration;
	previewAbort?.abort();
	previewAbort = new AbortController();
	const startSeconds = Number(inputById("subtitle-editor-loop-start").value);
	const durationSeconds = Number(inputById("subtitle-editor-loop-duration").value);
	if (!Number.isFinite(startSeconds) || startSeconds < 0 || !Number.isFinite(durationSeconds) || durationSeconds < 0.1 || durationSeconds > 120) {
		setError("Loop start must be nonnegative. Duration must be 0.1 to 120 seconds.");
		status("");
		return;
	}
	setError("");
	status("Rendering preview...");
	try {
		const response = await authFetch(`${API}/api/subtitle-editor/preview`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			signal: previewAbort.signal,
			body: JSON.stringify({ path: file.path, fingerprint: file.fingerprint, edit: editFor(trackId, track), startSeconds, durationSeconds }),
		});
		if (!response.ok) {
			const data = await response.json();
			throw new Error(data.error || "Preview failed");
		}
		const blob = await response.blob();
		if (version !== previewGeneration) return;
		clearVideo();
		previewUrl = URL.createObjectURL(blob);
		video().src = previewUrl;
		const offset = effectiveEditorOffset(track.offsetMs, track.format);
		status(
			`Loop ${startSeconds.toFixed(2)}s to ${(startSeconds + durationSeconds).toFixed(2)}s · offset ${offset > 0 ? "+" : ""}${offset} ms${offset !== track.offsetMs ? ` (rounded from ${track.offsetMs} ms)` : ""}`,
		);
		await video()
			.play()
			.catch(() => status("Preview ready. Press play to start the loop."));
	} catch (error) {
		if (version === previewGeneration) {
			setError(errorMessage(error));
			status("");
		}
	}
}

function navigate(index: number): void {
	const track = current();
	if (!track || !captureCue()) {
		if (track) select("subtitle-editor-cues").value = String(track.selected);
		return;
	}
	track.selected = Math.max(0, Math.min(track.cues.length - 1, index));
	renderCue();
}
async function save(): Promise<void> {
	if (!file || saving || !captureCue()) return;
	const edits = [...tracks.entries()].filter(([, track]) => track.offsetMs || track.changes.size).map(([id, track]) => editFor(id, track));
	if (!edits.length) return;
	saving = true;
	stopPreview();
	updateSave();
	byId<HTMLFieldSetElement>("subtitle-editor-controls").disabled = true;
	buttonById("subtitle-editor-pick").disabled = true;
	buttonById("subtitle-editor-close").disabled = true;
	setError("");
	status("Saving subtitle changes and verifying MKV...");
	try {
		const data = await jsonRequest("save", { path: file.path, fingerprint: file.fingerprint, edits });
		byId("subtitle-editor-output").textContent = `Saved: ${data.outputPath}`;
		status("Saved. Video and audio were copied unchanged.");
	} catch (error) {
		setError(errorMessage(error));
		status("");
	} finally {
		saving = false;
		byId<HTMLFieldSetElement>("subtitle-editor-controls").disabled = false;
		buttonById("subtitle-editor-pick").disabled = false;
		buttonById("subtitle-editor-close").disabled = false;
		updateSave();
	}
}

export function initSubtitleEditor(): void {
	byId("open-subtitle-editor-btn").addEventListener("click", openSubtitleEditor);
	byId("subtitle-editor-close").addEventListener("click", closeSubtitleEditor);
	byId("subtitle-editor-modal").addEventListener("click", (event) => {
		if (event.target === event.currentTarget) closeSubtitleEditor();
	});
	byId("subtitle-editor-pick").addEventListener("click", pickSubtitleEditorFile);
	byId("subtitle-editor-save").addEventListener("click", save);
	select("subtitle-editor-track").addEventListener("change", () => {
		if (!captureCue()) {
			select("subtitle-editor-track").value = String(trackId);
			return;
		}
		void loadTrack(Number(select("subtitle-editor-track").value));
	});
	select("subtitle-editor-cues").addEventListener("change", () => navigate(Number(select("subtitle-editor-cues").value)));
	byId("subtitle-editor-previous").addEventListener("click", () => navigate((current()?.selected || 0) - 1));
	byId("subtitle-editor-next").addEventListener("click", () => navigate((current()?.selected || 0) + 1));
	for (const id of ["subtitle-editor-cue-start", "subtitle-editor-cue-end", "subtitle-editor-text"])
		byId(id).addEventListener("input", () => {
			if (!captureCue()) return;
			try {
				if (!manualLoop) loopFromCue();
				schedulePreview();
			} catch (error) {
				setError(errorMessage(error));
			}
		});
	byId("subtitle-editor-offset").addEventListener("input", () => {
		const track = current();
		if (!track) return;
		const value = Number(inputById("subtitle-editor-offset").value);
		if (!inputById("subtitle-editor-offset").value || !Number.isFinite(value) || Math.abs(value) > 86_400_000) {
			invalid = true;
			stopPreview();
			setError("Offset must be within ±86400000 milliseconds.");
			updateSave();
			return;
		}
		track.offsetMs = Math.round(value);
		if (!captureCue()) return;
		invalid = false;
		updateSave();
		try {
			if (!manualLoop) loopFromCue();
			schedulePreview();
		} catch (error) {
			setError(errorMessage(error));
		}
	});
	for (const id of ["subtitle-editor-before", "subtitle-editor-after"])
		byId(id).addEventListener("change", () => {
			manualLoop = false;
			try {
				loopFromCue();
				schedulePreview();
			} catch (error) {
				setError(errorMessage(error));
			}
		});
	for (const id of ["subtitle-editor-loop-start", "subtitle-editor-loop-duration"])
		byId(id).addEventListener("change", () => {
			manualLoop = true;
			schedulePreview();
		});
	byId("subtitle-editor-cue-loop").addEventListener("click", () => {
		manualLoop = false;
		try {
			loopFromCue();
			schedulePreview();
		} catch (error) {
			setError(errorMessage(error));
		}
	});
	document.addEventListener("keydown", (event) => {
		if (byId("subtitle-editor-modal").style.display === "none" || byId("repair-picker-modal").style.display !== "none") return;
		if (event.key === "Escape") {
			closeSubtitleEditor();
			return;
		}
		if (saving || (event.target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(event.target.tagName))) return;
		if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
			event.preventDefault();
			navigate((current()?.selected || 0) + (event.key === "ArrowLeft" ? -1 : 1));
		}
	});
}
