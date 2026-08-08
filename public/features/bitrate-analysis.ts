import ChartJS from "../vendor/chart.umd.min.js";
import type { AutoDenoiseThresholds, BitrateAnalysisResult, Job, NoiseScenePoint } from "../types";
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

let chartInstance: ChartInstance | null = null;
let currentJobId: string | null = null;
let currentThresholds: AutoDenoiseThresholds | null = null;
let currentDurationSec = 0;
let currentScenes: NoiseScenePoint[] = [];

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

export async function openBitrateAnalysis(jobId: string): Promise<void> {
	currentJobId = jobId;

	const jobs = await fetchJobs();
	const job = jobs.find((j) => j.id === jobId);
	if (!job) return;

	byId("bitrate-modal-title").textContent = `Bitrate Analysis — ${job.filename}`;
	byId("bitrate-modal").style.display = "";
	byId("bitrate-loading").style.display = "";
	byId("bitrate-error").style.display = "none";
	byId("bitrate-content").style.display = "none";
	byId("bitrate-stats").innerHTML = "";
	buttonById("bitrate-save-btn").style.display = "none";

	if (chartInstance) {
		chartInstance.destroy();
		chartInstance = null;
	}

	try {
		const data = await fetchBitrateAnalysis(jobId);
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
		renderBitrateAnalysis(job, data);
	} catch (e) {
		byId("bitrate-loading").style.display = "none";
		byId("bitrate-error").textContent = `Failed: ${errorMessage(e)}`;
		byId("bitrate-error").style.display = "";
	}
}

export function closeBitrateAnalysis(): void {
	byId("bitrate-modal").style.display = "none";
	if (chartInstance) {
		chartInstance.destroy();
		chartInstance = null;
	}
	currentJobId = null;
	currentThresholds = null;
	currentScenes = [];
}

export function closeBitrateAnalysisIfOutside(e: MouseEvent): void {
	if (e.target === e.currentTarget) closeBitrateAnalysis();
}

function renderBitrateAnalysis(job: Job, data: BitrateAnalysisResult): void {
	currentDurationSec = data.durationSec || 0;
	viewMin = 0;
	viewMax = currentDurationSec;

	const isSource = data.mode === "source";
	const thresholdsWrap = byId("bitrate-thresholds");
	const modeNote = byId("bitrate-mode-note");
	const saveBtn = buttonById("bitrate-save-btn");

	const datasets: any[] = [
		{
			label: isSource ? "Source bitrate" : "Encoded bitrate",
			data: data.bitrate.map((p) => ({ x: p.t, y: p.kbps / 1000 })),
			borderColor: "#5b9dd9",
			backgroundColor: "transparent",
			borderWidth: 1.5,
			pointRadius: 0,
			yAxisID: "y",
			tension: 0.15,
		},
	];

	renderBitrateStats(data.bitrate);

	const hasNoise = isSource && !!data.noise && data.noise.scenes.length > 0;

	if (hasNoise) {
		currentThresholds = { ...data.thresholds! };
		currentScenes = data.noise!.scenes;
		thresholdsWrap.style.display = "";
		modeNote.textContent = "Source bitrate vs. noise (Y bitplane-4). Adjust thresholds below to preview denoise classification, then save to this job.";

		const noisePoints: { x: number; y: number }[] = [];
		for (const sc of data.noise!.scenes) {
			noisePoints.push({ x: sc.start, y: sc.median });
			noisePoints.push({ x: sc.end, y: sc.median });
		}
		datasets.push({
			label: "Noise (Y bitplane-4)",
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

		renderThresholdInputs(byId("bitrate-thresholds-grid"), currentThresholds);
	} else {
		currentThresholds = null;
		currentScenes = [];
		thresholdsWrap.style.display = "none";
		modeNote.textContent = isSource
			? "Source bitrate over time. Noise analysis was unavailable for this file."
			: "Encoded output bitrate over time. The source was already cleaned up, so only the finished file can be shown.";
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
					? { position: "right", title: { display: true, text: "Noise (Y bitplane-4)" }, min: 0, max: 1, grid: { drawOnChartArea: false } }
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

	saveBtn.style.display = hasNoise && job.status === "queued" ? "" : "none";

	setupZoomAndPan(canvas);
	updateZoomButtonState();
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

function renderThresholdInputs(container: HTMLElement, thresholds: AutoDenoiseThresholds): void {
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
		input.step = "0.01";
		input.min = "0";
		input.max = "1";
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
			const v = Math.max(0, Math.min(1, Number(input.value) || 0));
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

/** Recompute, from the current scene medians + thresholds, how much runtime each denoise level would cover. */
function updateThresholdStats(): void {
	if (!currentThresholds || currentScenes.length === 0) return;

	const seconds: Record<ThresholdLevel, number> = { light: 0, medium: 0, heavy: 0 };
	for (const sc of currentScenes) {
		const level = classifyNoise(sc.median, currentThresholds);
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
		await patchJobAutoThresholds(currentJobId, currentThresholds);
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
