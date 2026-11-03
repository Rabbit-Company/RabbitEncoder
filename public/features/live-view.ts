import ChartJS from "../vendor/chart.umd.min.js";
import type { JobLiveView, JobTelemetry, TelemetryPass, TelemetryZone } from "../types";
import { fetchJobLive, fetchJobs } from "../api/client";
import { escapeHtml, formatDuration, isActive, renderSteps } from "./job-render";
import { humanFileSize } from "./library";
import { byId, inputById } from "../shared/dom";
import { errorMessage } from "../shared/errors";

type ChartInstance = {
	destroy(): void;
	update(mode?: string): void;
	data: { datasets: { data: unknown[] }[] };
	options: { scales: { x: { min?: number; max?: number } } };
	scales: { x?: { getValueForPixel(pixel: number): number } };
};
const Chart = ChartJS as unknown as new (ctx: CanvasRenderingContext2D, config: any) => ChartInstance;

const POLL_MS = 2000;
/** How often a view following the queue looks for the next job to start. */
const FOLLOW_MS = 5000;
/** Narrowest time window a zoom goes to, in seconds. */
const MIN_VIEW_SECONDS = 5;
/** Seconds the current bitrate is averaged over. */
const RECENT_SECONDS = 5;

const COLORS = { final: "#5b9dd9", fast: "#8a8f98", predicted: "#e0a63e", cap: "#e0605b", crf: "#7fd88f", score: "#b48ead" };

type Point = { x: number; y: number | null };

let jobId: string | null = null;
let controller: AbortController | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let telemetry: JobTelemetry | null = null;
let version = 0;
let bitrateChart: ChartInstance | null = null;
let crfChart: ChartInstance | null = null;
/** The time window both charts show, or null for the whole video, which grows with the encode. */
let zoom: { min: number; max: number } | null = null;
let duration = 0;
let chartListeners: AbortController | null = null;
/** The follow checkbox is set from the first job's status, on when it is encoding. */
let followDecided = false;

function fmtTime(sec: number): string {
	const s = Math.max(0, Math.round(sec));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const pad = (n: number) => String(n).padStart(2, "0");
	return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

const mbps = (kbps: number) => `${(kbps / 1000).toFixed(2)} Mb/s`;

/** Mb/s of each second of a pass. */
function passPoints(pass: TelemetryPass, fps: number): Point[] {
	return pass.bytes.map((bytes, second) => {
		const frames = pass.frames[second] ?? 0;
		return { x: second, y: frames ? (bytes * 8) / 1e6 / (frames / fps) : null };
	});
}

/** A flat step for every scene. */
function zonePoints(zones: TelemetryZone[], fps: number, value: (zone: TelemetryZone) => number): Point[] {
	return zones.flatMap((zone) => [
		{ x: zone.start / fps, y: value(zone) },
		{ x: zone.end / fps, y: value(zone) },
	]);
}

/** Average kb/s over a stretch of a pass's seconds. */
function passKbps(pass: TelemetryPass, fps: number, from = 0, to = pass.bytes.length): number {
	let bytes = 0;
	let frames = 0;
	for (let i = Math.max(0, from); i < to; i++) {
		bytes += pass.bytes[i] ?? 0;
		frames += pass.frames[i] ?? 0;
	}
	return frames ? (bytes * 8) / 1000 / (frames / fps) : 0;
}

/** The highest bitrate over any `RECENT_SECONDS` of a pass, and where it starts. */
function passPeak(pass: TelemetryPass, fps: number): { kbps: number; at: number } {
	let peak = { kbps: 0, at: 0 };
	for (let i = 0; i + RECENT_SECONDS <= pass.bytes.length; i++) {
		const kbps = passKbps(pass, fps, i, i + RECENT_SECONDS);
		if (kbps > peak.kbps) peak = { kbps, at: i };
	}
	return peak;
}

function stat(label: string, value: string, title = ""): string {
	return `<span class="bitrate-stat"${title ? ` title="${escapeHtml(title)}"` : ""}><span class="bitrate-stat-label">${escapeHtml(label)}</span><span class="bitrate-stat-value">${escapeHtml(value)}</span></span>`;
}

function renderStats(view: JobLiveView): void {
	const end = view.finishedAt ?? (isActive(view.status) ? Date.now() : undefined);
	const parts = [stat("Stage", view.currentStage || view.status)];
	if (view.startedAt && end) parts.push(stat("Elapsed", formatDuration(end - view.startedAt)));
	const t = telemetry;
	if (view.encodedFileSize) parts.push(stat("Size", view.encodedFileSize));
	else if (isActive(view.status) && t?.final?.done) {
		// What the final pass wrote so far, scaled to all of its frames.
		const written = t.final.bytes.reduce((sum, bytes) => sum + bytes, 0);
		parts.push(
			stat("Estimated video", humanFileSize(written / (t.final.done / t.final.total)), "Grows or shrinks as the final pass reaches harder or easier scenes"),
		);
		if (view.estimatedFinalSize) parts.push(stat("Estimated total", view.estimatedFinalSize, "Video, audio and the rest of the file"));
	} else if (isActive(view.status) && !t?.zones?.length && t?.fast?.done && t.fastShare) {
		const written = t.fast.bytes.reduce((sum, bytes) => sum + bytes, 0);
		parts.push(
			stat(
				"Rough video size",
				humanFileSize((written / (t.fast.done / t.fast.total)) * t.fastShare),
				"From the fast pass so far at the base CRF. Rabbit Boost then moves each scene's CRF, so the final size can land well off this",
			),
		);
	} else if (isActive(view.status) && t?.zones?.length) {
		const bytes = t.zones.reduce((sum, z) => sum + (z.predictedKbps * 1000 * ((z.end - z.start) / t.fps)) / 8, 0);
		parts.push(stat("Predicted video", humanFileSize(bytes), "From the fast pass and each scene's CRF, before the final pass starts"));
	} else if (view.estimatedFinalSize) parts.push(stat("Estimated size", view.estimatedFinalSize));

	const warnings: string[] = [];
	if (t?.final?.done) {
		const pass = t.final;
		parts.push(stat("Final pass", `${pass.done} / ${pass.total} frames`));
		parts.push(stat("Average", mbps(passKbps(pass, t.fps))));
		if (isActive(view.status)) parts.push(stat("Last 5 s", mbps(passKbps(pass, t.fps, pass.bytes.length - RECENT_SECONDS))));
		const peak = passPeak(pass, t.fps);
		if (peak.kbps) parts.push(stat("Peak 5 s", `${mbps(peak.kbps)} at ${fmtTime(peak.at)}`));
		if (t.maxKbps > 0 && peak.kbps > t.maxKbps)
			warnings.push(`The final pass went over the ${mbps(t.maxKbps)} cap for 5 seconds at ${fmtTime(peak.at)}, ${mbps(peak.kbps)}.`);
	}
	if (t?.zones?.length) {
		const zones = t.zones;
		const crfs = zones.map((z) => z.crf);
		parts.push(stat("Scenes", String(zones.length)));
		parts.push(stat("CRF", `${Math.min(...crfs)}–${Math.max(...crfs)}${t.baseCrf !== undefined ? `, base ${t.baseCrf}` : ""}`));
		const frames = zones.reduce((sum, z) => sum + z.end - z.start, 0);
		const predicted = frames ? zones.reduce((sum, z) => sum + z.predictedKbps * (z.end - z.start), 0) / frames : 0;
		parts.push(stat("Predicted", mbps(predicted), "The final pass's expected average, from the fast pass and each scene's CRF"));
		const top = zones.reduce((a, b) => (b.predictedKbps > a.predictedKbps ? b : a));
		parts.push(stat("Predicted peak", `${mbps(top.predictedKbps)} at ${fmtTime(top.start / t.fps)}`, "The scene expected to take the most bitrate"));
		const capped = zones.filter((z) => z.capped).length;
		if (t.maxKbps > 0) parts.push(stat("Capped", `${capped} at ${mbps(t.maxKbps)}`));
		if (t.maxKbps > 0 && top.predictedKbps > t.maxKbps)
			warnings.push(`A scene at ${fmtTime(top.start / t.fps)} is expected to take ${mbps(top.predictedKbps)}, over the ${mbps(t.maxKbps)} cap.`);
	}
	byId("live-stats").innerHTML = parts.join("");

	const warning = byId("live-warning");
	if (view.error) warnings.unshift(view.error);
	warning.textContent = warnings.join(" ");
	warning.style.display = warnings.length ? "" : "none";
}

function axisOptions(yTitle: string, y1Title?: string) {
	return {
		x: { type: "linear", title: { display: true, text: "Time" }, ticks: { callback: (v: number) => fmtTime(v) }, min: 0 },
		y: { position: "left", title: { display: true, text: yTitle }, beginAtZero: true },
		y1: y1Title ? { position: "right", title: { display: true, text: y1Title }, grid: { drawOnChartArea: false } } : { display: false },
	};
}

function charts(): ChartInstance[] {
	return [bitrateChart, crfChart].filter((chart): chart is ChartInstance => !!chart);
}

function applyView(): void {
	for (const chart of charts()) {
		chart.options.scales.x.min = zoom?.min ?? 0;
		chart.options.scales.x.max = zoom?.max ?? (duration || undefined);
		chart.update("none");
	}
	const reset = byId<HTMLButtonElement>("live-zoom-reset-btn");
	reset.disabled = !zoom;
}

function setView(min: number, max: number): void {
	const span = Math.min(duration, max - min);
	min = Math.max(0, Math.min(min, duration - span));
	zoom = span >= duration - 0.001 ? null : { min, max: min + span };
	applyView();
}

/** Zoom by `factor` around the point `at` of the way across the window. */
function zoomBy(factor: number, at = 0.5): void {
	if (!duration) return;
	const min = zoom?.min ?? 0;
	const span = (zoom?.max ?? duration) - min;
	const next = Math.max(Math.min(MIN_VIEW_SECONDS, duration), Math.min(duration, span * factor));
	const center = min + span * at;
	setView(center - next * at, center - next * at + next);
}

function followZoom(canvas: HTMLCanvasElement, chart: () => ChartInstance | null): void {
	const signal = chartListeners!.signal;
	canvas.addEventListener(
		"wheel",
		(e) => {
			const scale = chart()?.scales.x;
			if (!scale || !duration) return;
			e.preventDefault();
			const min = zoom?.min ?? 0;
			const span = (zoom?.max ?? duration) - min;
			const at = (scale.getValueForPixel(e.clientX - canvas.getBoundingClientRect().left) - min) / span;
			zoomBy(e.deltaY > 0 ? 1.15 : 1 / 1.15, Math.max(0, Math.min(1, at)));
		},
		{ signal, passive: false },
	);
	canvas.addEventListener(
		"mousedown",
		(e) => {
			const scale = chart()?.scales.x;
			if (!scale || !zoom) return;
			const startX = e.clientX;
			const start = zoom;
			const perPixel = scale.getValueForPixel(1) - scale.getValueForPixel(0);
			canvas.style.cursor = "grabbing";
			const drag = new AbortController();
			window.addEventListener("mousemove", (move) => setView(start.min - (move.clientX - startX) * perPixel, start.max - (move.clientX - startX) * perPixel), {
				signal: drag.signal,
			});
			window.addEventListener(
				"mouseup",
				() => {
					drag.abort();
					canvas.style.cursor = "";
				},
				{ signal: drag.signal },
			);
			signal.addEventListener("abort", () => drag.abort(), { once: true, signal: drag.signal });
		},
		{ signal },
	);
	canvas.addEventListener("dblclick", () => setView(0, duration), { signal });
}

function makeChart(canvasId: string, datasets: any[], scales: any, label: (item: any) => string): ChartInstance {
	const canvas = byId<HTMLCanvasElement>(canvasId);
	const ctx = canvas.getContext("2d")!;
	const chart = new Chart(ctx, {
		type: "line",
		data: { datasets },
		options: {
			responsive: true,
			maintainAspectRatio: false,
			animation: false,
			parsing: false,
			interaction: { mode: "nearest", axis: "x", intersect: false },
			scales,
			plugins: {
				legend: { display: true, labels: { boxWidth: 12 } },
				tooltip: { callbacks: { title: (items: any[]) => (items[0] ? fmtTime(items[0].parsed.x) : ""), label } },
			},
		},
	});
	followZoom(canvas, () => chart);
	return chart;
}

const line = (label: string, color: string, extra: object = {}) => ({
	label,
	data: [] as Point[],
	borderColor: color,
	backgroundColor: color,
	borderWidth: 1.5,
	pointRadius: 0,
	spanGaps: false,
	...extra,
});

function renderCharts(): void {
	const t = telemetry;
	const hasData = !!t && (!!t.fast?.done || !!t.final?.done || !!t.zones?.length);
	byId("live-charts").style.display = hasData ? "" : "none";
	byId("live-note").style.display = t?.rabbitBoost ? "none" : "";
	if (!t || !hasData) return;

	duration = Math.max(t.final?.total ?? 0, t.fast?.total ?? 0, t.zones?.at(-1)?.end ?? 0) / t.fps;
	if (zoom && zoom.max > duration) zoom = null;
	chartListeners ??= new AbortController();
	if (!bitrateChart) {
		bitrateChart = makeChart(
			"live-bitrate-canvas",
			[
				line("Final pass", COLORS.final),
				line("Fast pass", COLORS.fast, { borderDash: [4, 3], borderWidth: 1 }),
				line("Predicted per scene", COLORS.predicted),
				line("Max bitrate", COLORS.cap, { borderDash: [6, 4] }),
			],
			axisOptions("Bitrate (Mb/s)"),
			(item: any) => `${item.dataset.label}: ${item.parsed.y?.toFixed(2)} Mb/s`,
		);
	}
	const bitrate = bitrateChart.data.datasets;
	bitrate[0]!.data = t.final ? passPoints(t.final, t.fps) : [];
	bitrate[1]!.data = t.fast ? passPoints(t.fast, t.fps) : [];
	bitrate[2]!.data = t.zones ? zonePoints(t.zones, t.fps, (z) => z.predictedKbps / 1000) : [];
	bitrate[3]!.data =
		t.maxKbps > 0 && duration > 0
			? [
					{ x: 0, y: t.maxKbps / 1000 },
					{ x: duration, y: t.maxKbps / 1000 },
				]
			: [];

	byId("live-crf-wrap").style.display = t.zones?.length ? "" : "none";
	if (!t.zones?.length) return applyView();
	if (!crfChart) {
		crfChart = makeChart(
			"live-crf-canvas",
			[line("CRF", COLORS.crf), line("SSIMULACRA2 (15th percentile)", COLORS.score, { yAxisID: "y1", borderWidth: 1 })],
			axisOptions("CRF", "SSIMULACRA2"),
			(item: any) => `${item.dataset.label}: ${item.parsed.y?.toFixed(2)}`,
		);
	}
	const crf = crfChart.data.datasets;
	crf[0]!.data = zonePoints(t.zones, t.fps, (z) => z.crf);
	crf[1]!.data = zonePoints(t.zones, t.fps, (z) => z.score);
	applyView();
}

async function poll(): Promise<void> {
	if (!jobId) return;
	const id = jobId;
	controller = new AbortController();
	try {
		const view = await fetchJobLive(id, version, controller.signal);
		if (id !== jobId) return;
		controller = null;
		if (view.telemetry) {
			// A new run of the job starts without data, and without the last run's zoom.
			if (!view.telemetry.fast && !view.telemetry.final && !view.telemetry.zones) zoom = null;
			telemetry = view.telemetry;
			version = view.telemetryVersion;
		} else if (view.telemetryVersion === 0) {
			telemetry = null;
		}
		byId("live-modal-title").textContent = `Live View: ${view.filename}`;
		byId("live-loading").style.display = "none";
		byId("live-error").style.display = "none";
		byId("live-content").style.display = "";
		renderStats(view);
		renderCharts();
		byId("live-steps").innerHTML = renderSteps(view.steps, true);
		if (!followDecided) {
			followDecided = true;
			inputById("live-follow").checked = isActive(view.status);
		}
		if (isActive(view.status) || view.status === "queued") timer = setTimeout(poll, POLL_MS);
		else if (following()) timer = setTimeout(findNextJob, POLL_MS);
	} catch (e) {
		if (controller?.signal.aborted || id !== jobId) return;
		controller = null;
		byId("live-loading").style.display = "none";
		byId("live-error").textContent = `Failed: ${errorMessage(e)}`;
		byId("live-error").style.display = "";
		timer = setTimeout(poll, POLL_MS * 2);
	}
}

const following = () => inputById("live-follow").checked;

/** Once the job shown is over, switch to the job encoding now, or look again later. */
async function findNextJob(): Promise<void> {
	const shown = jobId;
	timer = null;
	if (!shown || !following()) return;
	try {
		const next = (await fetchJobs()).find((job) => job.id !== shown && isActive(job.status));
		if (shown !== jobId || !following()) return;
		if (next) return showJob(next.id);
	} catch {}
	if (shown === jobId && following()) timer = setTimeout(findNextJob, FOLLOW_MS);
}

/** Start or stop following the queue. A finished job starts looking for the next one right away. */
export function toggleLiveFollow(): void {
	if (following() && jobId && !timer && !controller) void findNextJob();
}

function showJob(id: string): void {
	resetView();
	jobId = id;
	byId("live-modal-title").textContent = "Live View";
	byId("live-loading").style.display = "";
	byId("live-content").style.display = "none";
	void poll();
}

export function openLiveView(id: string): void {
	closeLiveView();
	followDecided = false;
	byId("live-modal").style.display = "";
	showJob(id);
}

function resetView(): void {
	jobId = null;
	controller?.abort();
	controller = null;
	if (timer) clearTimeout(timer);
	timer = null;
	telemetry = null;
	version = 0;
	zoom = null;
	duration = 0;
	chartListeners?.abort();
	chartListeners = null;
	bitrateChart?.destroy();
	crfChart?.destroy();
	bitrateChart = null;
	crfChart = null;
}

export function closeLiveView(): void {
	resetView();
	byId("live-modal").style.display = "none";
}

export function zoomLiveView(direction: "in" | "out" | "reset"): void {
	if (direction === "reset") setView(0, duration);
	else zoomBy(direction === "in" ? 0.7 : 1 / 0.7);
}

export function closeLiveViewIfOutside(e: MouseEvent): void {
	if (e.target === e.currentTarget) closeLiveView();
}
