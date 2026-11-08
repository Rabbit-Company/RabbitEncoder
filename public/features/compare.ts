import { authFetch, saveResponse } from "../api/client";
import { API } from "../config/api-base";
import { byId, buttonById, inputById } from "../shared/dom";
import { errorMessage } from "../shared/errors";
import { openPreviewReferencePicker } from "./repair";
import {
	chartGeometry,
	chartSvg,
	formatScore,
	frameAt,
	frameExtent,
	METRIC_GUIDES,
	METRIC_LABELS,
	METRICS,
	scoreSummary,
	seriesColor,
	tooltipHtml,
	type ChartGeometry,
	type FrameScores,
	type MeasureState,
	type MetricName,
	INTERVALS,
	intervalText,
} from "./compare-measure";

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
	frames: Array<{ timeSec: number; images: boolean[]; scores?: Array<FrameScores | null>; shifts?: number[] }>;
	scoreError?: string;
	measure?: MeasureState;
}

let rows: SourceRow[] = [];
let session: Session | null = null;
let frame = 0;
let source = 0;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
const imageUrls = new Map<string, Promise<string>>();
/** Measure choices, kept between comparisons. */
let measureInterval = "1";
const measureMetrics = new Set<MetricName>(METRICS);
let measureWithGrain = true;
let chartMetric: MetricName = "ssimulacra2";
let chartHover: number | null = null;
let chartGeo: ChartGeometry | null = null;
/** Frames in view when the graph is zoomed, null for all of it. */
let chartView: [number, number] | null = null;
/** Pointer position and view when a drag on the graph began, and whether it has moved enough to pan. */
let chartDrag: { x: number; view: [number, number]; moved: boolean } | null = null;
/** When the last drag ended, so the click that follows it does not capture a frame. */
let dragEndedAt = 0;
let capturing = false;

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
		stillStyle: byId<HTMLSelectElement>("compare-still-style").value,
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
		chartHover = null;
		chartView = null;
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
	if (next.status === "done") {
		renderViewer();
		renderMeasure();
	}
	stopPolling();
	if (running || next.measure?.status === "running") pollTimer = setTimeout(() => void poll(next.id), running ? 1000 : 1500);
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
		// The 8-bit view copy, as browsers show 16-bit PNGs with banding.
		url = authFetch(`${API}/api/compare/${session!.id}/image/${f}/${s}?view=1`).then(async (res) => {
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

function shiftText(shift: number): string {
	if (!shift) return "";
	return `moved ${shift > 0 ? "+" : ""}${shift} frame${Math.abs(shift) === 1 ? "" : "s"} here to match video 1`;
}

function renderViewer(): void {
	if (!session) return;
	const current = session.frames[frame]!;
	byId("compare-tabs").innerHTML = session.sources
		.map((src, i) => {
			const score = current.scores?.[i]?.ssimulacra2;
			const badge = score !== undefined ? ` <span class="compare-tab-score" title="SSIMULACRA2 against 1">${score.toFixed(1)}</span>` : "";
			return `<button class="btn btn-sm ${i === source ? "btn-primary" : "btn-ghost"}" type="button" data-compare-source="${i}" ${current.images[i] ? "" : "disabled"}>${i + 1} · ${escapeHtml(src.label)}${badge}</button>`;
		})
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
		shiftText(current.shifts?.[source] ?? 0),
	]
		.filter(Boolean)
		.join(" · ");
	byId("compare-source-info").textContent = info;
	const scores = current.scores?.[source];
	byId("compare-scores").textContent =
		source === 0
			? "Reference for the scores"
			: scores
				? `Against 1: ${scoreSummary(scores)}`
				: current.scores
					? "No score, the image differs in size from video 1"
					: "";
	const warnings = session.sources.map((s) => (s.warning ? `${s.label}: ${s.warning}` : "")).filter(Boolean);
	if (session.scoreError) warnings.push(`Scores: ${session.scoreError}`);
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
			link.dataset.frame = String(frame);
			link.dataset.source = String(source);
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

/** Saves the shown image as its 16-bit original, not the 8-bit copy on screen. */
export async function downloadCompareImage(event: MouseEvent): Promise<void> {
	event.preventDefault();
	const link = byId<HTMLAnchorElement>("compare-download");
	if (!session || link.dataset.frame === undefined) return;
	try {
		await saveResponse(await authFetch(`${API}/api/compare/${session.id}/image/${link.dataset.frame}/${link.dataset.source}`), link.download || "frame.png");
	} catch (error) {
		setError(errorMessage(error));
	}
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

/** The Measure panel: options, progress, the chart with one line per encode, and the summary table. */
function renderMeasure(): void {
	const host = byId("compare-measure");
	if (!session) return void (host.innerHTML = "");
	const m = session.measure;
	const running = m?.status === "running";
	const labels = session.sources.map((s, i) => `${i + 1} · ${s.label}`);
	const controls = `<div class="compare-measure-controls">
		<label>Sample <select class="select-input" id="compare-measure-interval" ${running ? "disabled" : ""}>${INTERVALS.map(([v, t]) => `<option value="${v}" ${v === measureInterval ? "selected" : ""}>${t}</option>`).join("")}</select></label>
		${METRICS.map((metric) => `<label class="compare-measure-metric"><input type="checkbox" data-measure-metric="${metric}" ${measureMetrics.has(metric) ? "checked" : ""} ${running ? "disabled" : ""}> ${METRIC_LABELS[metric]}</label>`).join("")}
		<label class="compare-measure-metric" title="On, AV1 videos are scored as a player shows them, with their film grain. Off, the grain is left out so the scores show only what compression lost."><input type="checkbox" id="compare-measure-grain" ${measureWithGrain ? "checked" : ""} ${running ? "disabled" : ""}> Score with film grain</label>
		${
			running
				? '<button class="btn btn-ghost btn-sm" type="button" data-measure-cancel>Cancel</button>'
				: `<button class="btn btn-primary btn-sm" type="button" data-measure-start ${measureMetrics.size ? "" : "disabled"}>${m ? "Measure again" : "Measure"}</button>`
		}
	</div>`;
	const head = `<div class="compare-measure-head"><strong>Measure the whole video</strong><span class="hdr-note">Scores every other video against video 1 over the stretch they share. Higher is better. Click the graph to capture that frame.</span></div>`;
	let body = "";
	if (m && running)
		body = `<div class="compare-progress-bar"><div style="width:${m.progress}%"></div></div><div class="repair-subtitle">${escapeHtml(m.detail || "Measuring")}... ${m.progress}%</div>`;
	if (m?.status === "error") body += `<div class="sub-preview-error">${escapeHtml(m.error || "Measuring failed")}</div>`;
	if (m?.status === "cancelled") body += '<div class="repair-subtitle">Measuring was cancelled.</div>';
	if (m) body += measureResult(m, labels);
	host.innerHTML = `${head}${controls}${body}`;
}

function measureResult(m: MeasureState, labels: string[]): string {
	const skipped = m.series
		.filter((s) => s.skipped)
		.map((s) => `<div class="compare-warnings">${escapeHtml(labels[s.source] ?? "")}: ${escapeHtml(s.skipped!)}</div>`)
		.join("");
	const measured = m.series.filter((s) => !s.skipped && Object.keys(s.values).length);
	if (!measured.length) return skipped;
	if (!m.metrics.includes(chartMetric)) chartMetric = m.metrics[0]!;
	const tabs = m.metrics
		.map(
			(metric) =>
				`<button class="btn btn-sm ${metric === chartMetric ? "btn-primary" : "btn-ghost"}" type="button" data-measure-chart="${metric}">${METRIC_LABELS[metric]}</button>`,
		)
		.join("");
	const zoom = `<span class="compare-measure-zoom">
		<button class="btn btn-ghost btn-sm" type="button" data-measure-zoom="out" title="Zoom out">&minus;</button>
		<button class="btn btn-ghost btn-sm" type="button" data-measure-zoom="in" title="Zoom in">+</button>
		<button class="btn btn-ghost btn-sm" type="button" data-measure-zoom="reset" title="Show the whole video" ${chartView ? "" : "disabled"}>Reset zoom</button>
	</span>`;
	const legend = measured
		.map(
			(s) =>
				`<span class="cm-legend-item"><span class="cm-key" style="background:${seriesColor(s.source)}"></span>${escapeHtml(labels[s.source] ?? "")}</span>`,
		)
		.join("");
	const width = Math.max(320, byId("compare-measure").clientWidth || 900);
	chartGeo = chartGeometry(m, chartMetric, width, chartView);
	const chart = chartGeo ? chartSvg(m, chartMetric, chartGeo, chartHover, labels) : "";
	const rows = measured
		.map((s) => {
			const cells = m.metrics.map((metric) => {
				const sum = s.summary[metric];
				if (!sum) return '<td class="cm-group-start">–</td><td>–</td><td>–</td>';
				const at = m.videoStart + sum.minFrame / m.fps;
				return `<td class="cm-group-start">${formatScore(metric, sum.mean)}</td><td>${formatScore(metric, sum.p5)}</td><td><button class="btn btn-ghost btn-sm" type="button" data-measure-capture="${at}" title="Capture this frame">${formatScore(metric, sum.min)} at ${formatTime(at)}</button></td>`;
			});
			return `<tr><th><span class="cm-key" style="background:${seriesColor(s.source)}"></span>${escapeHtml(labels[s.source] ?? "")}</th>${cells.join("")}</tr>`;
		})
		.join("");
	const samples = Math.max(...measured.map((s) => Math.max(...Object.values(s.values).map((v) => v?.length ?? 0))));
	return `${skipped}
		<div class="compare-measure-tabs">${tabs}<span class="hdr-note">${samples.toLocaleString()} frames, ${intervalText(m.interval)}, ${m.withGrain === false ? "without film grain" : "with film grain"}</span>${zoom}</div>
		<div class="hdr-note">Scroll on the graph to zoom, drag to move along it.</div>
		<div class="cm-legend">${legend}</div>
		<div class="cm-chart-wrap" id="compare-chart">${chart}<div class="cm-tip" id="compare-chart-tip" hidden></div></div>
		<table class="cm-table">
			<thead><tr><th rowspan="2">Video</th>${m.metrics.map((metric) => `<th colspan="3" class="cm-group cm-group-start">${METRIC_LABELS[metric]}</th>`).join("")}</tr>
			<tr>${m.metrics.map(() => '<th class="cm-group-start">Mean</th><th>5% low</th><th>Worst</th>').join("")}</tr></thead>
			<tbody>${rows}</tbody>
		</table>
		<div class="hdr-note">${METRIC_GUIDES[chartMetric]} 5% low is the score the worst 5% of measured frames fall below, which shows dips better than the mean.</div>`;
}

export async function startMeasureRun(): Promise<void> {
	if (!session) return;
	setError("");
	try {
		const res = await authFetch(`${API}/api/compare/${session.id}/measure`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				interval: measureInterval === "frame" ? "frame" : Number(measureInterval),
				metrics: METRICS.filter((m) => measureMetrics.has(m)),
				withGrain: measureWithGrain,
			}),
		});
		const data = await res.json();
		if (!res.ok) throw new Error(data.error || "Measuring failed to start");
		chartHover = null;
		chartView = null;
		loadSession(data);
	} catch (error) {
		setError(errorMessage(error));
	}
}

async function cancelMeasureRun(): Promise<void> {
	if (!session) return;
	await authFetch(`${API}/api/compare/${session.id}/measure`, { method: "DELETE" }).catch(() => {});
	await poll(session.id);
}

/** Captures the moment from every video and shows it, or shows the frame already captured there. */
async function captureAt(timeSec: number): Promise<void> {
	if (!session || capturing) return;
	capturing = true;
	setError("");
	byId("compare-frame-label").textContent = `Capturing ${formatTime(timeSec)}...`;
	try {
		const res = await authFetch(`${API}/api/compare/${session.id}/frames`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ timeSec }),
		});
		const data = await res.json();
		if (!res.ok) throw new Error(data.error || "Capture failed");
		session = data.session;
		frame = data.frame;
		const shown = session!.frames[frame]!.images;
		if (!shown[source]) source = Math.max(0, shown.indexOf(true));
		renderViewer();
		renderMeasure();
		byId("compare-image").scrollIntoView({ behavior: "smooth", block: "center" });
	} catch (error) {
		setError(errorMessage(error));
		renderViewer();
	} finally {
		capturing = false;
	}
}

export function handleCompareMeasureClick(event: MouseEvent): void {
	const target = event.target instanceof Element ? event.target : null;
	if (!target || !session) return;
	if (target.closest("[data-measure-start]")) return void startMeasureRun();
	if (target.closest("[data-measure-cancel]")) return void cancelMeasureRun();
	const tab = target.closest<HTMLElement>("[data-measure-chart]");
	if (tab) {
		chartMetric = tab.dataset.measureChart as MetricName;
		chartHover = null;
		return renderMeasure();
	}
	const zoom = target.closest<HTMLElement>("[data-measure-zoom]");
	if (zoom) {
		const how = zoom.dataset.measureZoom;
		if (how === "reset") setChartView(null);
		else zoomChart(how === "in" ? 0.6 : 1 / 0.6, 0.5);
		return;
	}
	const capture = target.closest<HTMLElement>("[data-measure-capture]");
	if (capture) return void captureAt(Number(capture.dataset.measureCapture));
	if (target.closest(".cm-chart") && chartHover !== null && session.measure && Date.now() - dragEndedAt > 300)
		void captureAt(session.measure.videoStart + chartHover / session.measure.fps);
}

/** Shortest stretch the graph zooms to: ten samples, and at least two seconds. */
function minimumSpan(m: MeasureState): number {
	return Math.max(10 * m.step, Math.round(2 * m.fps));
}

/** Shows `view` of the graph, kept inside the measured frames, or all of it. */
function setChartView(view: [number, number] | null): void {
	const m = session?.measure;
	const extent = m ? frameExtent(m, chartMetric) : null;
	if (!m || !extent) return;
	if (view) {
		const span = Math.min(extent[1] - extent[0], Math.max(minimumSpan(m), view[1] - view[0]));
		const start = Math.min(Math.max(extent[0], view[0]), extent[1] - span);
		view = [start, start + span];
		if (view[0] <= extent[0] && view[1] >= extent[1]) view = null;
	}
	chartView = view;
	chartHover = null;
	renderMeasure();
}

/** Zooms by `factor` around a point given as a share of the plot width. */
function zoomChart(factor: number, at: number): void {
	const m = session?.measure;
	const extent = m ? frameExtent(m, chartMetric) : null;
	if (!m || !extent) return;
	const [lo, hi] = chartView ?? extent;
	const span = (hi - lo) * factor;
	const center = lo + (hi - lo) * at;
	setChartView([center - span * at, center + span * (1 - at)]);
}

/** Share of the plot width under the pointer. */
function plotShare(svg: Element, clientX: number): number {
	if (!chartGeo) return 0.5;
	const box = svg.getBoundingClientRect();
	const x = ((clientX - box.left) / box.width) * chartGeo.width;
	return Math.min(1, Math.max(0, (x - chartGeo.left) / (chartGeo.right - chartGeo.left)));
}

export function handleCompareMeasureWheel(event: WheelEvent): void {
	const svg = event.target instanceof Element ? event.target.closest(".cm-chart") : null;
	if (!svg || !session?.measure) return;
	event.preventDefault();
	zoomChart(event.deltaY > 0 ? 1.2 : 1 / 1.2, plotShare(svg, event.clientX));
}

export function handleCompareMeasureDown(event: MouseEvent): void {
	const svg = event.target instanceof Element ? event.target.closest(".cm-chart") : null;
	const m = session?.measure;
	const extent = m ? frameExtent(m, chartMetric) : null;
	if (!svg || !extent || event.button !== 0) return;
	chartDrag = { x: event.clientX, view: chartView ?? extent, moved: false };
	event.preventDefault();
}

/** Drags the zoomed graph along. A drag that barely moved is a click, which captures the frame. */
export function handleCompareMeasureDrag(event: MouseEvent): void {
	if (!chartDrag || !chartGeo) return;
	const dx = event.clientX - chartDrag.x;
	if (!chartDrag.moved && Math.abs(dx) < 4) return;
	chartDrag.moved = true;
	const svg = byId("compare-measure").querySelector(".cm-chart");
	if (!svg) return;
	const plotPixels = ((chartGeo.right - chartGeo.left) / chartGeo.width) * svg.getBoundingClientRect().width;
	const [lo, hi] = chartDrag.view;
	const shift = (dx / plotPixels) * (hi - lo);
	setChartView([lo - shift, hi - shift]);
}

export function handleCompareMeasureUp(): void {
	if (!chartDrag) return;
	if (chartDrag.moved) dragEndedAt = Date.now();
	chartDrag = null;
}

export function handleCompareMeasureChange(event: Event): void {
	const input = event.target as HTMLInputElement;
	if (input.id === "compare-measure-interval") measureInterval = input.value;
	if (input.id === "compare-measure-grain") measureWithGrain = input.checked;
	const metric = input.dataset.measureMetric as MetricName | undefined;
	if (metric) {
		if (input.checked) measureMetrics.add(metric);
		else measureMetrics.delete(metric);
		renderMeasure();
	}
}

/** Crosshair and tooltip follow the pointer, snapped to the nearest measured frame. */
export function handleCompareMeasureMove(event: MouseEvent): void {
	if (chartDrag?.moved) return;
	const m = session?.measure;
	const svg = event.target instanceof Element ? event.target.closest<SVGSVGElement>(".cm-chart") : null;
	if (!m || !chartGeo || !svg) return void (chartHover !== null && handleCompareMeasureLeave());
	const box = svg.getBoundingClientRect();
	const x = ((event.clientX - box.left) / box.width) * chartGeo.width;
	if (x < chartGeo.left - 4 || x > chartGeo.right + 4) return;
	const hovered = frameAt(chartGeo, m, x);
	if (hovered === chartHover) return;
	chartHover = hovered;
	const labels = session!.sources.map((s, i) => `${i + 1} · ${s.label}`);
	const wrap = byId("compare-chart");
	const tip = byId("compare-chart-tip");
	wrap.querySelector("svg")!.outerHTML = chartSvg(m, chartMetric, chartGeo, chartHover, labels);
	tip.innerHTML = tooltipHtml(m, chartMetric, chartHover, labels);
	tip.hidden = false;
	const px =
		((chartGeo.left + ((chartHover - chartGeo.minFrame) / (chartGeo.maxFrame - chartGeo.minFrame)) * (chartGeo.right - chartGeo.left)) / chartGeo.width) *
		box.width;
	const flip = px > box.width * 0.65;
	tip.style.left = flip ? "" : `${px + 12}px`;
	tip.style.right = flip ? `${box.width - px + 12}px` : "";
}

export function handleCompareMeasureLeave(): void {
	if (chartHover === null || !session?.measure || !chartGeo) return;
	chartHover = null;
	const labels = session.sources.map((s, i) => `${i + 1} · ${s.label}`);
	const svg = byId("compare-measure").querySelector(".cm-chart");
	if (svg) svg.outerHTML = chartSvg(session.measure, chartMetric, chartGeo, null, labels);
	const tip = document.getElementById("compare-chart-tip");
	if (tip) tip.hidden = true;
}
