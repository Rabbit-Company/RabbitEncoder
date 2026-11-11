import { authFetch } from "../api/client";
import { API } from "../config/api-base";
import { byId, buttonById, inputById } from "../shared/dom";
import { errorMessage } from "../shared/errors";
import { openSubtitleFilePicker } from "./repair";
import type { RepairInspectionFile } from "../types";
import {
	editSubtitleDocument,
	editorCueLines,
	editorCues,
	editorFormat,
	effectiveEditorOffset,
	type SubtitleEditorCue,
	type SubtitleEditorEdit,
	type SubtitleEditorFormat,
} from "../../src/subtitles/editor";

interface LoadedTrack {
	format: SubtitleEditorFormat;
	cues: SubtitleEditorCue[];
	changes: Map<number, SubtitleEditorCue>;
	offsetMs: number;
	selected: number;
	/** The extracted track, replaced by the raw view text once that is edited. */
	document?: string;
	documentEdited: boolean;
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
let rawView = false;
let rawBaseline = "";
let rawPending = false;

const video = () => byId<HTMLVideoElement>("subtitle-editor-video");
const current = () => tracks.get(trackId);
const effectiveCue = (track: LoadedTrack, index: number) => {
	const cue = track.cues[index];
	return cue ? track.changes.get(cue.id) || cue : undefined;
};
const select = (id: string) => byId<HTMLSelectElement>(id);
const rawArea = () => byId<HTMLTextAreaElement>("subtitle-editor-raw");
const showingRaw = () => rawView && !!current() && current()!.format !== "bitmap";
const VIDEO_STORAGE_KEY = "rabbit-subtitle-editor-video";
let videoEnabled = localStorage.getItem(VIDEO_STORAGE_KEY) !== "0";
const plainText = (text: string) => text.replace(/\{[^}]*\}/g, "").replace(/\\[Nn]/g, " ");

function formatCueTime(ms: number, precise = false): string {
	const clamped = Math.max(0, ms);
	const total = Math.floor(clamped / 1000);
	const pad = (n: number) => String(n).padStart(2, "0");
	const hours = Math.floor(total / 3600);
	const clock = `${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}${precise ? `.${pad(Math.floor((clamped % 1000) / 10))}` : ""}`;
	return hours ? `${hours}:${clock}` : clock;
}
function parseCueTime(value: string): number | null {
	const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(value.trim());
	if (!match) return null;
	const [, hours = "0", minutes, seconds, fraction = ""] = match;
	return (Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000 + Number(fraction.padEnd(3, "0"));
}

function setError(message: string): void {
	byId("subtitle-editor-error").textContent = message;
	byId("subtitle-editor-error").style.display = message ? "" : "none";
}
function status(message: string): void {
	byId("subtitle-editor-status").textContent = message;
}
function updateSave(): void {
	buttonById("subtitle-editor-save").disabled =
		saving || invalid || !file || !(rawPending || [...tracks.values()].some((track) => track.offsetMs || track.changes.size || track.documentEdited));
}
function editFor(id: number, track: LoadedTrack): SubtitleEditorEdit {
	return { trackId: id, offsetMs: track.offsetMs, cues: [...track.changes.values()], ...(track.documentEdited ? { document: track.document } : {}) };
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
async function loadFile(path: string, restore?: { trackId: number; selected: number }): Promise<void> {
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
		const restored = restore && file!.subtitles.find((track) => track.id === restore.trackId && editorFormat(track.codecId));
		const chosen = restored || first;
		options.value = String(chosen.id);
		byId("subtitle-editor-workspace").style.display = "";
		await loadTrack(chosen.id, restored ? restore.selected : undefined);
	} catch (error) {
		if (version === generation) {
			setError(errorMessage(error));
			status("");
		}
	}
}

async function loadTrack(id: number, initialCue?: number): Promise<void> {
	if (!file) return;
	const version = ++generation;
	loadingAbort?.abort();
	loadingAbort = new AbortController();
	stopPreview();
	clearVideo();
	trackId = id;
	invalid = false;
	setError("");
	applyView();
	try {
		if (!tracks.has(id)) {
			status("Extracting subtitle cues...");
			const data = await jsonRequest("track", { path: file.path, fingerprint: file.fingerprint, trackId: id }, loadingAbort.signal);
			if (version !== generation) return;
			const cues: SubtitleEditorCue[] = data.cues;
			let selected = 0;
			const midpoint = file.durationSeconds * 500;
			if (initialCue !== undefined && cues.length) selected = Math.min(initialCue, cues.length - 1);
			else for (let i = 1; i < cues.length; i++) if (Math.abs(cues[i]!.startMs - midpoint) < Math.abs(cues[selected]!.startMs - midpoint)) selected = i;
			tracks.set(id, { format: data.format, cues, changes: new Map(), offsetMs: 0, selected, document: data.document, documentEdited: false });
		}
		if (version !== generation) return;
		const track = current()!;
		inputById("subtitle-editor-offset").value = String(track.offsetMs);
		byId("subtitle-editor-format-hint").textContent =
			track.format === "bitmap"
				? "Bitmap subtitles use a track delay. Text and individual image cue times cannot be edited."
				: `${track.format.toUpperCase()} cue times are rewritten directly. ${track.format !== "srt" ? "ASS styles and override tags are preserved. Use \\N for line breaks. Offsets are rounded to the nearest 10 ms." : ""}`;
		renderCueList(track);
		if (showingRaw()) {
			showRaw(track);
			if (track.cues.length) {
				manualLoop = false;
				loopFromCue();
				schedulePreview();
			} else status("This subtitle track has no cues.");
			updateSave();
			return;
		}
		applyView();
		if (!track.cues.length) {
			status("This subtitle track has no cues.");
			updateSave();
			return;
		}
		renderCue();
	} catch (error) {
		if (version === generation) {
			setError(errorMessage(error));
			status("");
		}
	}
}

function renderCueList(track: LoadedTrack): void {
	const cues = select("subtitle-editor-cues");
	cues.replaceChildren();
	track.cues.forEach((cue, i) =>
		cues.add(new Option(`${i + 1} · ${formatCueTime(cue.startMs)} · ${cue.name ? `${cue.name}: ` : ""}${plainText(cue.text).slice(0, 90)}`, String(i))),
	);
}
function applyView(): void {
	const track = current();
	const raw = showingRaw();
	const hasCues = !!track?.cues.length;
	byId("subtitle-editor-view-tabs").style.display = track && track.format !== "bitmap" ? "" : "none";
	byId("subtitle-editor-view-cues").setAttribute("aria-pressed", String(!raw));
	byId("subtitle-editor-view-raw").setAttribute("aria-pressed", String(raw));
	byId("subtitle-editor-cue-fields").style.display = !raw && hasCues ? "" : "none";
	byId("subtitle-editor-raw-fields").style.display = raw ? "" : "none";
	inputById("subtitle-editor-offset").disabled = raw;
	inputById("subtitle-editor-video-toggle").checked = videoEnabled;
	video().style.display = videoEnabled ? "" : "none";
	byId("subtitle-editor-loop").style.display = videoEnabled && hasCues ? "" : "none";
}

/** Fills the raw view with the track as it would be saved now. */
function showRaw(track: LoadedTrack): void {
	const text = editSubtitleDocument(track.document || "", track.format, editFor(trackId, track));
	rawArea().value = text;
	rawBaseline = text;
	rawPending = false;
	applyView();
	const line = editorCueLines(text, track.format)[track.selected];
	if (line !== undefined) scrollRawToLine(line);
}
function scrollRawToLine(line: number): void {
	const area = rawArea();
	let index = 0;
	for (let i = 0; i < line; i++) {
		const next = area.value.indexOf("\n", index);
		if (next < 0) break;
		index = next + 1;
	}
	area.focus({ preventScroll: true });
	area.setSelectionRange(index, index);
	const lineHeight = parseFloat(getComputedStyle(area).lineHeight) || 18;
	area.scrollTop = Math.max(0, line * lineHeight - area.clientHeight / 3);
	area.scrollLeft = 0;
}
function selectCueAtCursor(track: LoadedTrack): void {
	const area = rawArea();
	const line = area.value.slice(0, area.selectionStart).split("\n").length - 1;
	const lines = editorCueLines(area.value, track.format);
	let selected = 0;
	for (let i = 0; i < lines.length && i < track.cues.length; i++) if (lines[i]! <= line) selected = i;
	track.selected = Math.min(selected, Math.max(0, track.cues.length - 1));
}
/** Makes the raw view text the track's document. Cue edits and the offset are already baked into it. */
function commitRaw(): boolean {
	const track = current();
	if (!track || !showingRaw()) return true;
	const text = rawArea().value;
	if (text !== rawBaseline) {
		let cues: SubtitleEditorCue[];
		try {
			editSubtitleDocument(text, track.format, { trackId, offsetMs: 0, cues: [] });
			cues = editorCues(text, track.format);
		} catch (error) {
			invalid = true;
			stopPreview();
			setError(`The raw file cannot be read: ${errorMessage(error)}`);
			updateSave();
			return false;
		}
		track.document = text;
		track.documentEdited = true;
		track.changes.clear();
		track.offsetMs = 0;
		track.cues = cues;
		inputById("subtitle-editor-offset").value = "0";
		rawBaseline = text;
		renderCueList(track);
		applyView();
	}
	rawPending = false;
	invalid = false;
	setError("");
	selectCueAtCursor(track);
	updateSave();
	return true;
}
function setRawView(enabled: boolean): void {
	const track = current();
	if (!track || enabled === showingRaw()) return;
	if (enabled) {
		if (!captureCue()) return;
		try {
			rawView = true;
			showRaw(track);
		} catch (error) {
			rawView = false;
			applyView();
			setError(errorMessage(error));
		}
		return;
	}
	if (!commitRaw()) return;
	rawView = false;
	applyView();
	if (track.cues.length) renderCue();
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
function renderCueLabel(): void {
	const track = current()!;
	const cue = effectiveCue(track, track.selected)!;
	byId("subtitle-editor-cue-label").textContent =
		`Cue ${track.selected + 1} of ${track.cues.length} · ${formatCueTime(cue.startMs, true)} to ${formatCueTime(cue.endMs, true)}${cue.style ? ` · ${cue.style}` : ""}${cue.name ? ` · Speaker: ${cue.name}` : ""}`;
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
	renderCueLabel();
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
	if (!track || showingRaw()) return true;
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
	if (!videoEnabled) {
		status("Video preview is off.");
		return;
	}
	status("Updating preview...");
	previewTimer = setTimeout(() => void refreshPreview(), 500);
}
async function refreshPreview(): Promise<void> {
	const track = current();
	if (showingRaw() && track) {
		if (!commitRaw()) return;
		try {
			if (!manualLoop) loopFromCue();
		} catch (error) {
			setError(errorMessage(error));
			return;
		}
	}
	if (!file || !track || !track.cues.length || invalid || !videoEnabled) return;
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

function findCue(): void {
	const track = current();
	const query = inputById("subtitle-editor-find").value.trim();
	if (!track || !track.cues.length || !query) return;
	const timeMs = parseCueTime(query);
	if (timeMs !== null) {
		const offset = effectiveEditorOffset(track.offsetMs, track.format);
		const distance = (index: number) => {
			const cue = effectiveCue(track, index)!;
			return Math.max(0, cue.startMs + offset - (timeMs + 999), timeMs - (cue.endMs + offset));
		};
		let best = 0;
		for (let i = 1; i < track.cues.length; i++) if (distance(i) < distance(best)) best = i;
		navigate(best);
		return;
	}
	const needle = query.toLocaleLowerCase();
	for (let step = 1; step <= track.cues.length; step++) {
		const index = (track.selected + step) % track.cues.length;
		const cue = effectiveCue(track, index)!;
		if (`${cue.name} ${plainText(cue.text)}`.toLocaleLowerCase().includes(needle)) {
			navigate(index);
			return;
		}
	}
	status(`No cue contains "${query}".`);
}

function setVideoEnabled(enabled: boolean): void {
	videoEnabled = enabled;
	localStorage.setItem(VIDEO_STORAGE_KEY, enabled ? "1" : "0");
	applyView();
	if (!enabled) {
		stopPreview();
		clearVideo();
	}
	if (current()?.cues.length && !invalid) schedulePreview();
}
async function save(): Promise<void> {
	if (!file || saving || !commitRaw() || !captureCue()) return;
	const edits = [...tracks.entries()]
		.filter(([, track]) => track.offsetMs || track.changes.size || track.documentEdited)
		.map(([id, track]) => editFor(id, track));
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
		const replaceTarget = select("subtitle-editor-save-mode").value === "existing";
		const data = await jsonRequest("save", { path: file.path, fingerprint: file.fingerprint, edits, replaceTarget });
		if (data.replaced) {
			// The file on disk changed, so reopen it to pick up the saved tracks and new fingerprint.
			saving = false;
			await loadFile(file.path, { trackId, selected: current()?.selected ?? 0 });
		}
		byId("subtitle-editor-output").textContent = data.replaced ? `Replaced: ${data.outputPath}` : `Saved: ${data.outputPath}`;
		status(`${data.replaced ? "Replaced after verification" : "Saved"}. Video and audio were copied unchanged.`);
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
		if (!commitRaw() || !captureCue()) {
			select("subtitle-editor-track").value = String(trackId);
			return;
		}
		void loadTrack(Number(select("subtitle-editor-track").value));
	});
	select("subtitle-editor-cues").addEventListener("change", () => navigate(Number(select("subtitle-editor-cues").value)));
	byId("subtitle-editor-previous").addEventListener("click", () => navigate((current()?.selected || 0) - 1));
	byId("subtitle-editor-next").addEventListener("click", () => navigate((current()?.selected || 0) + 1));
	byId("subtitle-editor-find-btn").addEventListener("click", findCue);
	byId("subtitle-editor-find").addEventListener("keydown", (event) => {
		if (event.key !== "Enter") return;
		event.preventDefault();
		findCue();
	});
	applyView();
	byId("subtitle-editor-view-cues").addEventListener("click", () => setRawView(false));
	byId("subtitle-editor-view-raw").addEventListener("click", () => setRawView(true));
	byId("subtitle-editor-raw").addEventListener("input", () => {
		rawPending = true;
		updateSave();
		schedulePreview();
	});
	byId("subtitle-editor-video-toggle").addEventListener("change", () => setVideoEnabled(inputById("subtitle-editor-video-toggle").checked));
	for (const id of ["subtitle-editor-cue-start", "subtitle-editor-cue-end", "subtitle-editor-text"])
		byId(id).addEventListener("input", () => {
			if (!captureCue()) return;
			renderCueLabel();
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
