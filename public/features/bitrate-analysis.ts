import ChartJS from "../vendor/chart.umd.min.js";
import type { AutoDenoiseAppliedRange, AutoDenoiseMetric, AutoDenoiseThresholds, BitrateAnalysisResult, Job, NoiseScenePoint } from "../types";
import { fetchBitrateAnalysis, fetchJobs, patchJobAutoThresholds } from "../api/client";
import { formatBitrate2 } from "./job-render";
import { buttonById, byId } from "../shared/dom";
import { errorMessage } from "../shared/errors";

interface ChartScale {
	min: number;
	max: number;
	getValueForPixel(pixel: number): number;
}

type ChartInstance = {
	destroy(): void;
	update(mode?: string): void;
	data: { datasets: any[] };
	options: { scales: { x: { min: number; max: number } } };
	scales: { x: ChartScale };
};
const Chart = ChartJS as unknown as new (ctx: CanvasRenderingContext2D, config: any) => ChartInstance;

const THRESHOLD_LEVELS = ["light", "medium", "heavy"] as const;
type ThresholdLevel = (typeof THRESHOLD_LEVELS)[number];

const THRESHOLD_COLORS: Record<ThresholdLevel, string> = {
	light: "#7fd88f",
	medium: "#e0a63e",
	heavy: "#e0605b",
};

function thresholdDatasetLabel(level: ThresholdLevel): string {
	return `${level[0]!.toUpperCase()}${level.slice(1)} threshold`;
}

const NO_DENOISE_COLOR = "#5b9dd9";
const APPLIED_LEVEL_COLORS: Record<"off" | ThresholdLevel, string> = {
	off: NO_DENOISE_COLOR,
	...THRESHOLD_COLORS,
};
const APPLIED_LEVEL_LABELS: Record<"off" | ThresholdLevel, string> = {
	off: "No denoise",
	light: "Light",
	medium: "Medium",
	heavy: "Heavy",
};

/** Which denoise level (if any) covers time `t`, per the applied plan. */
function appliedLevelAtTime(t: number, plan: AutoDenoiseAppliedRange[]): "off" | ThresholdLevel {
	for (const r of plan) {
		if (t >= r.start && t < r.end) return r.level;
	}
	return "off";
}

interface MetricDisplay {
	datasetLabel: string;
	axisLabel: string;
	modeNote: string;
	inputMin: number;
	inputMax: number;
	inputStep: number;
	/** y1 axis max, or undefined to let Chart.js auto-scale. */
	axisMax: number | undefined;
}

const METRIC_DISPLAY: Record<AutoDenoiseMetric, MetricDisplay> = {
	noise: {
		datasetLabel: "Peak noise (bitplane 4)",
		axisLabel: "Peak noise (bitplane 4)",
		modeNote: "Source bitrate vs. peak noise per scene (bitplane 4). Adjust thresholds below to preview denoise classification, then save to this job.",
		inputMin: 0,
		inputMax: 1,
		inputStep: 0.01,
		axisMax: 1,
	},
	bitrate: {
		datasetLabel: "Bitrate ratio (x median)",
		axisLabel: "Bitrate ratio (x median)",
		modeNote:
			"Source bitrate vs. each scene's own bitrate as a multiple of the file's median. Adjust thresholds below to preview denoise classification, then save to this job.",
		inputMin: 0,
		inputMax: 20,
		inputStep: 0.1,
		axisMax: undefined,
	},
};

let chartInstance: ChartInstance | null = null;
let currentJobId: string | null = null;
let currentJobFilename = "";
let currentMetric: AutoDenoiseMetric = "noise";
let currentThresholds: AutoDenoiseThresholds | null = null;
let currentDurationSec = 0;
let currentScenes: NoiseScenePoint[] = [];
let currentData: BitrateAnalysisResult | null = null;
let currentIsImported = false;

/** Aborts the in-flight fetch (if any) — the server ties ffmpeg's lifetime to the request's abort signal, so this also stops the backend analysis pass. */
let activeAbortController: AbortController | null = null;

function abortActiveRequest(): void {
	if (activeAbortController) {
		activeAbortController.abort();
		activeAbortController = null;
	}
}

// Current visible x-axis window, for zoom/pan.
let viewMin = 0;
let viewMax = 0;
const MIN_VIEW_SPAN_SEC = 1;

function fmtTime(sec: number): string {
	const s = Math.max(0, Math.round(sec));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const r = s % 60;
	const pad = (n: number) => String(n).padStart(2, "0");
	return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

function resetModalChrome(): void {
	byId("bitrate-modal").style.display = "";
	byId("bitrate-loading").style.display = "";
	byId("bitrate-error").style.display = "none";
	byId("bitrate-content").style.display = "none";
	byId("bitrate-stats").innerHTML = "";
	buttonById("bitrate-save-btn").style.display = "none";
	buttonById("bitrate-download-btn").style.display = "none";
	buttonById("bitrate-refresh-btn").style.display = "none";

	if (chartInstance) {
		chartInstance.destroy();
		chartInstance = null;
	}
}

export async function openBitrateAnalysis(jobId: string, opts: { refresh?: boolean } = {}): Promise<void> {
	abortActiveRequest();
	currentJobId = jobId;
	currentIsImported = false;

	const jobs = await fetchJobs();
	const job = jobs.find((j) => j.id === jobId);
	if (!job) return;

	byId("bitrate-modal-title").textContent = `Bitrate Analysis — ${job.filename}`;
	resetModalChrome();
	currentJobFilename = job.filename;

	const controller = new AbortController();
	activeAbortController = controller;

	try {
		const data = await fetchBitrateAnalysis(jobId, { signal: controller.signal, refresh: opts.refresh });
		if (controller.signal.aborted) return;
		byId("bitrate-loading").style.display = "none";

		if (data.error) {
			byId("bitrate-error").textContent = data.error;
			byId("bitrate-error").style.display = "";
			return;
		}

		if (data.bitrate.length === 0 && !data.noise) {
			byId("bitrate-error").textContent = "No packets found — the file may be empty or unreadable.";
			byId("bitrate-error").style.display = "";
			return;
		}

		byId("bitrate-content").style.display = "";
		buttonById("bitrate-refresh-btn").style.display = "";
		renderBitrateAnalysis(job, data);
	} catch (e) {
		if (controller.signal.aborted) return; // modal was closed — not a real error
		byId("bitrate-loading").style.display = "none";
		byId("bitrate-error").textContent = `Failed: ${errorMessage(e)}`;
		byId("bitrate-error").style.display = "";
	} finally {
		if (activeAbortController === controller) activeAbortController = null;
	}
}

export async function handleBitrateRefresh(): Promise<void> {
	if (!currentJobId || currentIsImported) return;
	await openBitrateAnalysis(currentJobId, { refresh: true });
}

/**
 * Load a previously-downloaded `.bitrate-analysis.json` (from the "Download
 * data" button) and render it directly — no job or server round-trip needed.
 * Lets you keep looking at an episode's analysis after the job that produced
 * it is long gone (queue restart, job removed, etc.).
 */
export async function openBitrateAnalysisImport(file: File): Promise<void> {
	abortActiveRequest();
	currentJobId = null;
	currentIsImported = true;

	const label = file.name.replace(/\.bitrate-analysis\.json$/i, "").replace(/\.json$/i, "");
	byId("bitrate-modal-title").textContent = `Bitrate Analysis — ${label} (imported)`;
	resetModalChrome();

	try {
		const text = await file.text();
		const parsed = JSON.parse(text);

		if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.bitrate)) {
			throw new Error("Not a recognized bitrate-analysis file.");
		}

		let metric: AutoDenoiseMetric;
		if (parsed.metric === "bitrate" || parsed.metric === "noise") {
			metric = parsed.metric;
		} else {
			const heavy = parsed.thresholds?.heavy;
			metric = typeof heavy === "number" && heavy > 1 ? "bitrate" : "noise";
		}

		const data: BitrateAnalysisResult = {
			mode: parsed.mode === "encoded" ? "encoded" : "source",
			durationSec: Number(parsed.durationSec) || 0,
			bitrate: parsed.bitrate,
			noise: parsed.noise ?? null,
			metric,
			thresholds: parsed.thresholds ?? undefined,
			appliedPlan: parsed.appliedPlan ?? null,
		};
		currentJobFilename = typeof parsed.filename === "string" && parsed.filename ? parsed.filename : label;

		byId("bitrate-loading").style.display = "none";
		byId("bitrate-content").style.display = "";
		buttonById("bitrate-download-btn").style.display = data.bitrate.length > 0 ? "" : "none";
		renderBitrateAnalysis(null, data);
	} catch (e) {
		byId("bitrate-loading").style.display = "none";
		byId("bitrate-error").textContent = `Failed to import: ${errorMessage(e)}`;
		byId("bitrate-error").style.display = "";
	}
}

export function closeBitrateAnalysis(): void {
	abortActiveRequest();
	byId("bitrate-modal").style.display = "none";
	if (chartInstance) {
		chartInstance.destroy();
		chartInstance = null;
	}
	currentJobId = null;
	currentJobFilename = "";
	currentMetric = "noise";
	currentThresholds = null;
	currentScenes = [];
	currentData = null;
	currentIsImported = false;
}

export function closeBitrateAnalysisIfOutside(e: MouseEvent): void {
	if (e.target === e.currentTarget) closeBitrateAnalysis();
}

function renderBitrateAnalysis(job: Job | null, data: BitrateAnalysisResult): void {
	currentData = data;
	currentDurationSec = data.durationSec || 0;
	viewMin = 0;
	viewMax = currentDurationSec;

	const isSource = data.mode === "source";
	const thresholdsWrap = byId("bitrate-thresholds");
	const modeNote = byId("bitrate-mode-note");
	const saveBtn = buttonById("bitrate-save-btn");
	const legendWrap = byId("bitrate-applied-legend");

	const appliedPlan = !isSource ? (data.appliedPlan ?? null) : null;

	const bitrateDataset: any = {
		label: isSource ? "Source bitrate" : "Encoded bitrate",
		data: data.bitrate.map((p) => ({ x: p.t, y: p.kbps / 1000 })),
		borderColor: NO_DENOISE_COLOR,
		backgroundColor: "transparent",
		borderWidth: 1.5,
		pointRadius: 0,
		yAxisID: "y",
		tension: 0.15,
	};

	if (appliedPlan && appliedPlan.length > 0) {
		bitrateDataset.segment = {
			borderColor: (ctx: any) => {
				const mid = ((ctx.p0.parsed.x as number) + (ctx.p1.parsed.x as number)) / 2;
				return APPLIED_LEVEL_COLORS[appliedLevelAtTime(mid, appliedPlan)];
			},
		};
	}

	const datasets: any[] = [bitrateDataset];

	renderAppliedLegend(legendWrap, appliedPlan);
	renderBitrateStats(data.bitrate);

	const hasNoise = isSource && !!data.noise && data.noise.scenes.length > 0;

	currentMetric = data.metric ?? "noise";
	const display = METRIC_DISPLAY[currentMetric];

	if (hasNoise) {
		currentThresholds = { ...data.thresholds! };
		currentScenes = data.noise!.scenes;
		thresholdsWrap.style.display = "";
		modeNote.textContent = display.modeNote;

		const noisePoints: { x: number; y: number }[] = [];
		for (const sc of data.noise!.scenes) {
			noisePoints.push({ x: sc.start, y: sc.value });
			noisePoints.push({ x: sc.end, y: sc.value });
		}
		datasets.push({
			label: display.datasetLabel,
			data: noisePoints,
			borderColor: "#c792ea",
			backgroundColor: "transparent",
			borderWidth: 1.5,
			pointRadius: 0,
			yAxisID: "y1",
			tension: 0,
		});

		for (const level of THRESHOLD_LEVELS) {
			datasets.push(buildThresholdDataset(level, currentThresholds[level]));
		}

		renderThresholdInputs(byId("bitrate-thresholds-grid"), currentThresholds, display);
	} else {
		currentThresholds = null;
		currentScenes = [];
		thresholdsWrap.style.display = "none";
		if (isSource) {
			modeNote.textContent = "Source bitrate over time. Noise analysis was unavailable for this file.";
		} else if (appliedPlan && appliedPlan.length > 0) {
			modeNote.textContent = "Encoded output bitrate over time, colored by the auto-denoise level actually applied at each point.";
		} else {
			modeNote.textContent = "Encoded output bitrate over time. The source was already cleaned up, so only the finished file can be shown.";
		}
	}

	const canvas = byId<HTMLCanvasElement>("bitrate-canvas");
	const ctx = canvas.getContext("2d")!;

	chartInstance = new Chart(ctx, {
		type: "line",
		data: { datasets },
		options: {
			responsive: true,
			maintainAspectRatio: false,
			animation: false,
			interaction: { mode: "nearest", axis: "x", intersect: false },
			scales: {
				x: {
					type: "linear",
					title: { display: true, text: "Time" },
					ticks: { callback: (v: number) => fmtTime(v) },
					min: viewMin,
					max: viewMax || undefined,
				},
				y: {
					position: "left",
					title: { display: true, text: "Bitrate (Mbps)" },
					beginAtZero: true,
				},
				y1: hasNoise
					? { position: "right", title: { display: true, text: display.axisLabel }, min: 0, max: display.axisMax, grid: { drawOnChartArea: false } }
					: { display: false },
			},
			plugins: {
				legend: { display: true, labels: { boxWidth: 12 } },
				tooltip: {
					callbacks: {
						title: (items: any[]) => (items[0] ? fmtTime(items[0].parsed.x) : ""),
					},
				},
			},
		},
	});

	saveBtn.style.display = hasNoise && job?.status === "queued" ? "" : "none";
	buttonById("bitrate-download-btn").style.display = data.bitrate.length > 0 ? "" : "none";

	setupZoomAndPan(canvas);
	updateZoomButtonState();
}

/** Show/hide the "which color = which denoise level" key, only when we have an applied plan to show. */
function renderAppliedLegend(container: HTMLElement, plan: AutoDenoiseAppliedRange[] | null): void {
	if (!plan || plan.length === 0) {
		container.style.display = "none";
		container.innerHTML = "";
		return;
	}

	container.innerHTML = "";
	for (const level of ["off", ...THRESHOLD_LEVELS] as const) {
		const item = document.createElement("span");
		item.className = "bitrate-legend-item";
		const dot = document.createElement("span");
		dot.className = "bitrate-legend-dot";
		dot.style.background = APPLIED_LEVEL_COLORS[level];
		item.appendChild(dot);
		item.appendChild(document.createTextNode(APPLIED_LEVEL_LABELS[level]));
		container.appendChild(item);
	}
	container.style.display = "";
}

export function handleBitrateDownload(): void {
	if (!currentData) return;

	const payload = {
		filename: currentJobFilename,
		mode: currentData.mode,
		durationSec: currentData.durationSec,
		bitrate: currentData.bitrate,
		noise: currentData.noise,
		metric: currentMetric,
		thresholds: currentData.thresholds ?? null,
		appliedPlan: currentData.appliedPlan ?? null,
	};

	const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
	const url = URL.createObjectURL(blob);
	const safeName = (currentJobFilename || "bitrate-analysis").replace(/\.[^/.]+$/, "");
	const a = document.createElement("a");
	a.href = url;
	a.download = `${safeName}.bitrate-analysis.json`;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}

function renderBitrateStats(bitrate: { t: number; kbps: number }[]): void {
	const container = byId("bitrate-stats");
	if (bitrate.length === 0) {
		container.innerHTML = "";
		return;
	}

	let min = Infinity;
	let max = -Infinity;
	let sum = 0;
	for (const p of bitrate) {
		if (p.kbps < min) min = p.kbps;
		if (p.kbps > max) max = p.kbps;
		sum += p.kbps;
	}
	const avg = sum / bitrate.length;

	const stat = (label: string, kbps: number) =>
		`<div class="bitrate-stat"><span class="bitrate-stat-label">${label}</span><span class="bitrate-stat-value">${formatBitrate2(Math.round(kbps))}</span></div>`;

	container.innerHTML = stat("Min", min) + stat("Avg", avg) + stat("Max", max);
}

function buildThresholdDataset(level: ThresholdLevel, value: number) {
	return {
		label: thresholdDatasetLabel(level),
		data: [
			{ x: 0, y: value },
			{ x: currentDurationSec, y: value },
		],
		borderColor: THRESHOLD_COLORS[level],
		backgroundColor: "transparent",
		borderDash: [6, 4],
		borderWidth: 1.5,
		pointRadius: 0,
		yAxisID: "y1",
		tension: 0,
	};
}

function renderThresholdInputs(container: HTMLElement, thresholds: AutoDenoiseThresholds, display: MetricDisplay): void {
	container.innerHTML = "";
	const grid = document.createElement("div");
	grid.className = "auto-threshold-grid";

	for (const level of THRESHOLD_LEVELS) {
		const row = document.createElement("label");
		row.className = "auto-threshold-row";
		const span = document.createElement("span");
		span.textContent = level;
		const input = document.createElement("input");
		input.type = "number";
		input.step = String(display.inputStep);
		input.min = String(display.inputMin);
		input.max = String(display.inputMax);
		input.value = String(thresholds[level]);
		const pct = document.createElement("span");
		pct.className = "auto-threshold-pct";
		pct.id = `bitrate-threshold-pct-${level}`;

		// Only preview-update the chart while typing; don't rewrite the field's
		// text (that fights the user mid-keystroke, e.g. typing "0." then "4").
		// The value is clamped and normalized once the field loses focus.
		input.oninput = () => {
			const parsed = Number(input.value);
			const v = Number.isFinite(parsed) ? parsed : 0;
			thresholds[level] = v;
			updateThresholdLine(level, v);
			updateThresholdStats();
		};
		input.onblur = () => {
			const v = Math.max(display.inputMin, Math.min(display.inputMax, Number(input.value) || 0));
			thresholds[level] = v;
			input.value = String(v);
			updateThresholdLine(level, v);
			updateThresholdStats();
		};

		row.appendChild(span);
		row.appendChild(input);
		row.appendChild(pct);
		grid.appendChild(row);
	}

	container.appendChild(grid);

	const summary = document.createElement("div");
	summary.id = "bitrate-thresholds-summary";
	summary.className = "bitrate-thresholds-summary";
	container.appendChild(summary);

	updateThresholdStats();
}

function updateThresholdLine(level: ThresholdLevel, value: number): void {
	if (!chartInstance) return;
	const label = thresholdDatasetLabel(level);
	const ds = chartInstance.data.datasets.find((d) => d.label === label);
	if (!ds) return;
	ds.data = [
		{ x: 0, y: value },
		{ x: currentDurationSec, y: value },
	];
	chartInstance.update("none");
}

function classifyNoise(value: number, t: AutoDenoiseThresholds): "off" | ThresholdLevel {
	if (value < t.light) return "off";
	if (value < t.medium) return "light";
	if (value < t.heavy) return "medium";
	return "heavy";
}

function fmtDurationFromSeconds(sec: number): string {
	const total = Math.round(sec);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h > 0) return `${h}h ${m}m ${s}s`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

/** Recompute, from the current per-scene peak noise values + thresholds, how much runtime each denoise level would cover. */
function updateThresholdStats(): void {
	if (!currentThresholds || currentScenes.length === 0) return;

	const seconds: Record<ThresholdLevel, number> = { light: 0, medium: 0, heavy: 0 };
	for (const sc of currentScenes) {
		const level = classifyNoise(sc.value, currentThresholds);
		if (level === "off") continue;
		seconds[level] += sc.end - sc.start;
	}

	for (const level of THRESHOLD_LEVELS) {
		const el = document.getElementById(`bitrate-threshold-pct-${level}`);
		if (!el) continue;
		const pct = currentDurationSec > 0 ? (100 * seconds[level]) / currentDurationSec : 0;
		el.textContent = `${pct.toFixed(1)}%`;
	}

	const total = seconds.light + seconds.medium + seconds.heavy;
	const totalPct = currentDurationSec > 0 ? (100 * total) / currentDurationSec : 0;
	const summaryEl = document.getElementById("bitrate-thresholds-summary");
	if (summaryEl) {
		summaryEl.textContent = `Total denoised: ${totalPct.toFixed(1)}% (${fmtDurationFromSeconds(total)} of ${fmtDurationFromSeconds(currentDurationSec)})`;
	}
}

export async function handleBitrateSaveThresholds(): Promise<void> {
	if (!currentJobId || !currentThresholds) return;
	const btn = buttonById("bitrate-save-btn");
	const prevText = btn.textContent || "Save to job";
	btn.disabled = true;
	btn.textContent = "Saving…";
	try {
		await patchJobAutoThresholds(currentJobId, currentMetric, currentThresholds);
		btn.textContent = "Saved";
	} catch (e) {
		btn.textContent = "Save failed";
		console.error("Failed to save auto-denoise thresholds:", e);
	} finally {
		setTimeout(() => {
			btn.textContent = prevText;
			btn.disabled = false;
		}, 1200);
	}
}

// Zoom and pan
function setView(min: number, max: number): void {
	viewMin = Math.max(0, min);
	viewMax = Math.min(currentDurationSec, max);
	if (!chartInstance) return;
	chartInstance.options.scales.x.min = viewMin;
	chartInstance.options.scales.x.max = viewMax;
	chartInstance.update("none");
	updateZoomButtonState();
}

function zoomBy(factor: number, centerFrac = 0.5): void {
	const span = viewMax - viewMin;
	const maxSpan = currentDurationSec || span;
	const newSpan = Math.max(MIN_VIEW_SPAN_SEC, Math.min(maxSpan, span * factor));
	const center = viewMin + span * centerFrac;

	let newMin = center - newSpan * centerFrac;
	let newMax = center + newSpan * (1 - centerFrac);

	if (newMin < 0) {
		newMax -= newMin;
		newMin = 0;
	}
	if (newMax > currentDurationSec) {
		newMin -= newMax - currentDurationSec;
		newMax = currentDurationSec;
	}
	setView(Math.max(0, newMin), Math.min(currentDurationSec, newMax));
}

function updateZoomButtonState(): void {
	const resetBtn = document.getElementById("bitrate-zoom-reset-btn") as HTMLButtonElement | null;
	if (resetBtn) resetBtn.disabled = viewMin <= 0.001 && viewMax >= currentDurationSec - 0.001;
}

let dragStartClientX: number | null = null;
let dragStartView: [number, number] | null = null;

function setupZoomAndPan(canvas: HTMLCanvasElement): void {
	const zoomInBtn = document.getElementById("bitrate-zoom-in-btn") as HTMLButtonElement | null;
	const zoomOutBtn = document.getElementById("bitrate-zoom-out-btn") as HTMLButtonElement | null;
	const resetBtn = document.getElementById("bitrate-zoom-reset-btn") as HTMLButtonElement | null;

	if (zoomInBtn) zoomInBtn.onclick = () => zoomBy(0.7);
	if (zoomOutBtn) zoomOutBtn.onclick = () => zoomBy(1 / 0.7);
	if (resetBtn) resetBtn.onclick = () => setView(0, currentDurationSec);

	canvas.onwheel = (e: WheelEvent) => {
		if (!chartInstance) return;
		e.preventDefault();
		const rect = canvas.getBoundingClientRect();
		const xScale = chartInstance.scales.x;
		let centerFrac = 0.5;
		if (xScale) {
			const dataX = xScale.getValueForPixel(e.clientX - rect.left);
			const span = viewMax - viewMin || 1;
			centerFrac = Math.max(0, Math.min(1, (dataX - viewMin) / span));
		}
		zoomBy(e.deltaY > 0 ? 1.15 : 1 / 1.15, centerFrac);
	};

	canvas.onmousedown = (e: MouseEvent) => {
		dragStartClientX = e.clientX;
		dragStartView = [viewMin, viewMax];
		canvas.style.cursor = "grabbing";
	};

	// Assigned via property (not addEventListener) so re-opening the modal
	// replaces the previous handler instead of stacking another one.
	window.onmousemove = (e: MouseEvent) => {
		if (dragStartClientX === null || !dragStartView || !chartInstance) return;
		const xScale = chartInstance.scales.x;
		if (!xScale) return;
		const pixelDelta = e.clientX - dragStartClientX;
		const dataPerPixel = xScale.getValueForPixel(1) - xScale.getValueForPixel(0);
		const dataDelta = pixelDelta * dataPerPixel;

		let newMin = dragStartView[0] - dataDelta;
		let newMax = dragStartView[1] - dataDelta;
		const span = newMax - newMin;
		if (newMin < 0) {
			newMin = 0;
			newMax = span;
		}
		if (newMax > currentDurationSec) {
			newMax = currentDurationSec;
			newMin = currentDurationSec - span;
		}
		setView(newMin, newMax);
	};

	window.onmouseup = () => {
		dragStartClientX = null;
		dragStartView = null;
		canvas.style.cursor = "";
	};
}
