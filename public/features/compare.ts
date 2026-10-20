import { authFetch, saveResponse } from "../api/client";
import { API } from "../config/api-base";
import { byId, buttonById, inputById } from "../shared/dom";
import { errorMessage } from "../shared/errors";
import { openPreviewReferencePicker } from "./repair";

interface SourceRow {
	path: string;
	label: string;
	/** Typed offset in ms, empty for automatic. */
	offset: string;
	/** Colour tag overrides, empty for the file's own tags. */
	range: "" | "limited" | "full";
	matrix: "" | "709" | "601" | "2020";
}

interface SessionSource {
	path: string;
	label: string;
	offsetMs: number;
	offsetFrom: "first" | "auto" | "manual" | "none";
	confidence?: number;
	width?: number;
	height?: number;
	fps?: number;
	hdr?: boolean;
	outputWidth?: number;
	outputHeight?: number;
	pictureShiftFrames?: number;
	colourOverride?: string;
	warning?: string;
}

interface Session {
	id: string;
	status: "aligning" | "capturing" | "done" | "error" | "cancelled";
	progress: number;
	detail?: string;
	error?: string;
	sources: SessionSource[];
	frames: Array<{ timeSec: number; images: boolean[] }>;
}

let rows: SourceRow[] = [];
let session: Session | null = null;
let frame = 0;
let source = 0;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
const imageUrls = new Map<string, Promise<string>>();

function setError(message: string): void {
	const el = byId("compare-error");
	el.textContent = message;
	el.style.display = message ? "" : "none";
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

/** Release group from a file name: "[Group] Show - 01.mkv" or "Show.S01E01.1080p-GROUP.mkv". */
export function releaseLabel(fileName: string): string {
	const stem = fileName.replace(/\.[a-z0-9]{2,4}$/i, "");
	const lead = /^\[([^\]]+)\]/.exec(stem)?.[1];
	if (lead) return lead.slice(0, 40);
	const tail = /-([A-Za-z0-9][\w.]{1,30})$/.exec(stem.replace(/\s*\[[^\]]*\]\s*$/g, ""))?.[1];
	return (tail || stem).slice(0, 40);
}

/** Seconds from "1:23:45.5", "12:05", "75.25" or "75". */
export function parseTimestamp(text: string): number | null {
	const parts = text.trim().split(":");
	if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
	return parts.reduce((sum, p) => sum * 60 + Number(p), 0);
}

function formatTime(sec: number): string {
	const h = Math.floor(sec / 3600);
	const m = Math.floor(sec / 60) % 60;
	const s = (sec % 60).toFixed(3).padStart(6, "0");
	return `${h ? `${h}:${String(m).padStart(2, "0")}` : m}:${s}`;
}

function renderRows(): void {
	const host = byId("compare-sources");
	host.innerHTML = rows
		.map(
			(row, i) => `<div class="compare-source-row" data-index="${i}">
				<span class="compare-source-key">${i + 1}</span>
				<input class="lang-filter-input compare-label" data-field="label" value="${escapeHtml(row.label)}" maxlength="40" aria-label="Label" />
				<span class="compare-source-file" title="${escapeHtml(row.path)}">${escapeHtml(row.path.split("/").pop() || row.path)}</span>
				${
					i === 0
						? '<span class="compare-offset-note">Reference</span>'
						: `<input class="lang-filter-input compare-offset" data-field="offset" value="${escapeHtml(row.offset)}" placeholder="auto (ms)" inputmode="numeric" aria-label="Offset in ms" title="Offset in ms. Leave empty to align by audio." />`
				}
				<select class="select-input compare-colour" data-field="range" aria-label="Range" title="Range. Auto uses the file's tag. Override only when colours look washed out or crushed.">
					${[
						["", "Range: auto"],
						["limited", "Limited"],
						["full", "Full"],
					]
						.map(([v, t]) => `<option value="${v}" ${row.range === v ? "selected" : ""}>${t}</option>`)
						.join("")}
				</select>
				<select class="select-input compare-colour" data-field="matrix" aria-label="Matrix" title="Colour matrix. Auto uses the file's tag. Override only when colours are tinted.">
					${[
						["", "Matrix: auto"],
						["709", "BT.709"],
						["601", "BT.601"],
						["2020", "BT.2020"],
					]
						.map(([v, t]) => `<option value="${v}" ${row.matrix === v ? "selected" : ""}>${t}</option>`)
						.join("")}
				</select>
				<button class="btn btn-ghost btn-sm" type="button" data-compare-remove="${i}">Remove</button>
			</div>`,
		)
		.join("");
	buttonById("compare-start").disabled = rows.length < 2;
}

function renderMode(): void {
	const mode = byId<HTMLSelectElement>("compare-mode").value;
	byId("compare-count-group").style.display = mode === "manual" ? "none" : "";
	byId("compare-timestamps-group").style.display = mode === "manual" ? "" : "none";
}

function showFooter(step: "setup" | "running" | "result"): void {
	buttonById("compare-start").style.display = step === "setup" ? "" : "none";
	buttonById("compare-cancel").style.display = step === "running" ? "" : "none";
	buttonById("compare-new").style.display = step === "result" ? "" : "none";
	buttonById("compare-delete").style.display = step === "result" ? "" : "none";
}

export async function deleteCurrentCompare(): Promise<void> {
	if (!session || !confirm(`Delete this comparison of ${session.sources.map((s) => s.label).join(" vs ")}?`)) return;
	try {
		const res = await authFetch(`${API}/api/compare/${session.id}`, { method: "DELETE" });
		if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Delete failed");
		showSetup();
	} catch (error) {
		setError(errorMessage(error));
	}
}

export async function clearRecentCompares(): Promise<void> {
	const count = byId<HTMLSelectElement>("compare-recent").options.length - 1;
	if (!confirm(`Delete all ${count} saved comparison${count === 1 ? "" : "s"} and their images?`)) return;
	try {
		const res = await authFetch(`${API}/api/compare`, { method: "DELETE" });
		if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Clear failed");
		setError("");
		await loadRecent();
	} catch (error) {
		setError(errorMessage(error));
	}
}

function showSetup(): void {
	stopPolling();
	session = null;
	setError("");
	byId("compare-setup").style.display = "";
	byId("compare-viewer").style.display = "none";
	byId("compare-progress").style.display = "none";
	showFooter("setup");
	renderRows();
	renderMode();
	void loadRecent();
}

async function loadRecent(): Promise<void> {
	try {
		const res = await authFetch(`${API}/api/compare`);
		const data = (await res.json()) as { sessions?: Array<{ id: string; createdAt: number; status: string; labels: string[]; frames: number }> };
		const done = (data.sessions ?? []).filter((s) => s.status === "done");
		const select = byId<HTMLSelectElement>("compare-recent");
		select.replaceChildren(
			new Option("Open a previous comparison...", ""),
			...done.map((s) => new Option(`${new Date(s.createdAt).toLocaleString()} · ${s.labels.join(" vs ")} · ${s.frames} frames`, s.id)),
		);
		byId("compare-recent-group").style.display = done.length ? "" : "none";
	} catch {
		byId("compare-recent-group").style.display = "none";
	}
}

export async function openRecentCompare(): Promise<void> {
	const id = byId<HTMLSelectElement>("compare-recent").value;
	if (!id) return;
	setError("");
	try {
		const res = await authFetch(`${API}/api/compare/${id}`);
		const data = await res.json();
		if (!res.ok) throw new Error(data.error || "Comparison not found");
		loadSession(data);
	} catch (error) {
		setError(errorMessage(error));
	}
}

export function openCompare(): void {
	byId("compare-modal").style.display = "";
	if (!session) showSetup();
}

export function closeCompare(): void {
	byId("compare-modal").style.display = "none";
	stopPolling();
}

export function closeCompareIfOutside(event: MouseEvent): void {
	if (event.target === event.currentTarget) closeCompare();
}

export function addCompareSource(): void {
	openPreviewReferencePicker((path) => {
		if (rows.some((r) => r.path === path)) return;
		rows.push({ path, label: releaseLabel(path.split("/").pop() || path), offset: "", range: "", matrix: "" });
		renderRows();
	});
}

export function handleCompareSourcesInput(event: Event): void {
	const input = event.target as HTMLInputElement;
	const index = Number(input.closest<HTMLElement>("[data-index]")?.dataset.index);
	const row = rows[index];
	if (!row) return;
	if (input.dataset.field === "label") row.label = input.value;
	if (input.dataset.field === "offset") row.offset = input.value;
	if (input.dataset.field === "range") row.range = input.value as SourceRow["range"];
	if (input.dataset.field === "matrix") row.matrix = input.value as SourceRow["matrix"];
}

export function handleCompareSourcesClick(event: MouseEvent): void {
	const button = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-compare-remove]") : null;
	if (!button) return;
	rows.splice(Number(button.dataset.compareRemove), 1);
	renderRows();
}

export function handleCompareModeChange(): void {
	renderMode();
}

export async function startCompareRun(): Promise<void> {
	setError("");
	const mode = byId<HTMLSelectElement>("compare-mode").value;
	const body: Record<string, unknown> = {
		mode,
		align: inputById("compare-align").checked,
		sources: rows.map((row, i) => {
			const offset = row.offset.trim();
			return {
				path: row.path,
				label: row.label.trim(),
				offsetMs: i > 0 && offset ? Number(offset) : undefined,
				range: row.range || undefined,
				matrix: row.matrix || undefined,
			};
		}),
	};
	if (rows.slice(1).some((r) => r.offset.trim() && !Number.isFinite(Number(r.offset.trim()))))
		return setError("Offsets must be whole milliseconds, like -7300.");
	if (mode === "manual") {
		const texts = inputById("compare-timestamps")
			.value.split(/[,\s]+/)
			.filter(Boolean);
		const times = texts.map(parseTimestamp);
		if (!texts.length || times.some((t) => t === null)) return setError("Enter timestamps like 1:23, 12:05.5 or 754.");
		body.timestamps = times;
	} else body.count = Number(inputById("compare-count").value);

	const button = buttonById("compare-start");
	button.disabled = true;
	try {
		const res = await authFetch(`${API}/api/compare`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
		const data = await res.json();
		if (!res.ok) throw new Error(data.error || "Comparison failed to start");
		loadSession(data);
	} catch (error) {
		setError(errorMessage(error));
	} finally {
		button.disabled = rows.length < 2;
	}
}

function stopPolling(): void {
	if (pollTimer) clearTimeout(pollTimer);
	pollTimer = null;
}

function loadSession(next: Session): void {
	if (session?.id !== next.id) {
		for (const url of imageUrls.values()) void url.then(URL.revokeObjectURL, () => {});
		imageUrls.clear();
		frame = 0;
		source = 0;
	}
	session = next;
	byId("compare-setup").style.display = "none";
	const running = next.status === "aligning" || next.status === "capturing";
	showFooter(running ? "running" : "result");
	byId("compare-progress").style.display = running ? "" : "none";
	byId("compare-progress-text").textContent = `${next.detail || "Working"}... ${next.progress}%`;
	byId<HTMLElement>("compare-progress-fill").style.width = `${next.progress}%`;
	if (next.status === "error") setError(next.error || "Comparison failed");
	if (next.status === "cancelled") setError("Comparison cancelled");
	byId("compare-viewer").style.display = next.status === "done" ? "" : "none";
	if (next.status === "done") renderViewer();
	stopPolling();
	if (running) pollTimer = setTimeout(() => void poll(next.id), 1000);
}

async function poll(id: string): Promise<void> {
	try {
		const res = await authFetch(`${API}/api/compare/${id}`);
		const data = await res.json();
		if (!res.ok) throw new Error(data.error || "Comparison not found");
		if (byId("compare-modal").style.display !== "none") loadSession(data);
	} catch (error) {
		setError(errorMessage(error));
	}
}

export async function cancelCompareRun(): Promise<void> {
	if (!session) return;
	await authFetch(`${API}/api/compare/${session.id}`, { method: "DELETE" }).catch(() => {});
	showSetup();
}

function imageUrl(f: number, s: number): Promise<string> {
	const key = `${f}_${s}`;
	let url = imageUrls.get(key);
	if (!url) {
		url = authFetch(`${API}/api/compare/${session!.id}/image/${f}/${s}`).then(async (res) => {
			if (!res.ok) throw new Error("Image not available");
			return URL.createObjectURL(await res.blob());
		});
		imageUrls.set(key, url);
	}
	return url;
}

function offsetText(src: SessionSource): string {
	if (src.offsetFrom === "first") return "reference";
	const ms = `${src.offsetMs > 0 ? "+" : ""}${src.offsetMs} ms`;
	if (src.offsetFrom === "auto") {
		const shift = src.pictureShiftFrames
			? `, picture check ${src.pictureShiftFrames > 0 ? "+" : ""}${src.pictureShiftFrames} frame${Math.abs(src.pictureShiftFrames) === 1 ? "" : "s"}`
			: "";
		return `${ms} (audio match ${Math.round((src.confidence ?? 0) * 100)}%${shift})`;
	}
	if (src.offsetFrom === "manual") return `${ms} (manual)`;
	return "not aligned";
}

function renderViewer(): void {
	if (!session) return;
	const current = session.frames[frame]!;
	byId("compare-tabs").innerHTML = session.sources
		.map(
			(src, i) =>
				`<button class="btn btn-sm ${i === source ? "btn-primary" : "btn-ghost"}" type="button" data-compare-source="${i}" ${current.images[i] ? "" : "disabled"}>${i + 1} · ${escapeHtml(src.label)}</button>`,
		)
		.join("");
	const src = session.sources[source]!;
	byId("compare-frame-label").textContent = `Frame ${frame + 1} of ${session.frames.length} · ${formatTime(current.timeSec)}`;
	buttonById("compare-prev").disabled = frame === 0;
	buttonById("compare-next").disabled = frame === session.frames.length - 1;
	const size = src.outputWidth ? `${src.width}×${src.height} upscaled to ${src.outputWidth}×${src.outputHeight}` : `${src.width}×${src.height}`;
	const info = [
		size,
		src.fps ? `${src.fps} fps` : "",
		src.hdr ? "HDR, tone mapped" : "",
		src.colourOverride ? `set to ${src.colourOverride}` : "",
		`offset ${offsetText(src)}`,
	]
		.filter(Boolean)
		.join(" · ");
	byId("compare-source-info").textContent = info;
	const warnings = session.sources.map((s) => (s.warning ? `${s.label}: ${s.warning}` : "")).filter(Boolean);
	byId("compare-warnings").textContent = warnings.join("\n");
	byId("compare-warnings").style.display = warnings.length ? "" : "none";

	const img = byId<HTMLImageElement>("compare-image");
	const wanted = `${frame}_${source}`;
	img.dataset.wanted = wanted;
	if (!current.images[source]) {
		img.removeAttribute("src");
		return;
	}
	void imageUrl(frame, source)
		.then((url) => {
			if (img.dataset.wanted !== wanted) return;
			img.src = url;
			const link = byId<HTMLAnchorElement>("compare-download");
			link.href = url;
			const digits = Math.max(2, String(session!.frames.length).length);
			const label = src.label.replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^_+|_+$/g, "") || "source";
			link.download = `${String(frame + 1).padStart(digits, "0")}_${source + 1}_${label}.png`;
		})
		.catch((error) => setError(errorMessage(error)));
	// Fetch the other sources of this frame in the background, so switching is instant.
	session.sources.forEach((_, i) => current.images[i] && void imageUrl(frame, i).catch(() => {}));
}

function selectSource(i: number): void {
	if (!session || !session.frames[frame]?.images[i]) return;
	source = i;
	renderViewer();
}

function selectFrame(f: number): void {
	if (!session || f < 0 || f >= session.frames.length) return;
	frame = f;
	if (!session.frames[f]!.images[source]) source = Math.max(0, session.frames[f]!.images.indexOf(true));
	renderViewer();
}

export async function downloadAllCompare(): Promise<void> {
	if (!session) return;
	const button = buttonById("compare-download-all");
	button.disabled = true;
	button.textContent = "Preparing...";
	try {
		await saveResponse(await authFetch(`${API}/api/compare/${session.id}/download`), "comparison.zip");
	} catch (error) {
		setError(errorMessage(error));
	} finally {
		button.disabled = false;
		button.textContent = "Download all";
	}
}

export function handleCompareTabsClick(event: MouseEvent): void {
	const button = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-compare-source]") : null;
	if (button) selectSource(Number(button.dataset.compareSource));
}

export function compareNextFrame(): void {
	selectFrame(frame + 1);
}

export function comparePrevFrame(): void {
	selectFrame(frame - 1);
}

export function newCompare(): void {
	showSetup();
}

/** 1 to 9 pick a source, arrows move between frames. */
export function handleCompareKey(event: KeyboardEvent): void {
	if (byId("compare-modal").style.display === "none" || byId("compare-viewer").style.display === "none") return;
	if (event.target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) return;
	if (/^[1-9]$/.test(event.key)) selectSource(Number(event.key) - 1);
	else if (event.key === "ArrowRight") selectFrame(frame + 1);
	else if (event.key === "ArrowLeft") selectFrame(frame - 1);
	else return;
	event.preventDefault();
}
