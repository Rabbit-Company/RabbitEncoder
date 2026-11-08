import type { BitrateAnalysisResult, EncodeMeasurement, EncodeMetric, JobTelemetry } from "../types";
import { cancelJobMeasurement, fetchJobMeasurement, startJobMeasurement } from "../api/client";
import { byId } from "../shared/dom";
import { errorMessage } from "../shared/errors";
import { formatScore, INTERVALS, intervalText, METRIC_GUIDES, METRIC_LABELS, METRICS } from "./compare-measure";

/** What the bitrate modal lends this report: its time charts share one zoom. */
export interface ReportHost {
	makeChart(
		canvasId: string,
		datasets: any[],
		scales: any,
		label: (item: any) => string,
		extra?: object,
	): { data: { datasets: any[] }; options: any; update(mode?: string): void };
	zoomAround(sec: number): void;
	/** The measurement changed, so an export takes it along. */
	onMeasurement(m: EncodeMeasurement | null): void;
}

type QualityChart = ReturnType<ReportHost["makeChart"]>;

const POLL_MS = 1000;
const COLORS = { crf: "#7fd88f", score: "#b48ead", capped: "#e0605b", quality: "#5b9dd9" };

let host: ReportHost | null = null;
let jobId: string | null = null;
let canMeasure = false;
let measurement: EncodeMeasurement | null = null;
let qualityChart: QualityChart | null = null;
let chartMetric: EncodeMetric = "ssimulacra2";
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollController: AbortController | null = null;
let actionError = "";
let interval = "1";
const metrics = new Set<EncodeMetric>(["ssimulacra2"]);
let withGrain = true;

const escapeHtml = (value: string): string =>
	value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");

function fmtTime(sec: number): string {
	const s = Math.max(0, Math.round(sec));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const pad = (n: number) => String(n).padStart(2, "0");
	return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

const mbps = (kbps: number) => `${(kbps / 1000).toFixed(2)} Mb/s`;

function stopPolling(): void {
	if (pollTimer) clearTimeout(pollTimer);
	pollTimer = null;
	pollController?.abort();
	pollController = null;
}

/** Forget the shown report. The host destroys the charts. */
export function resetEncodeReport(): void {
	stopPolling();
	host = null;
	jobId = null;
	canMeasure = false;
	measurement = null;
	qualityChart = null;
	actionError = "";
	byId("bitrate-crf-wrap").style.display = "none";
	byId("bitrate-quality").style.display = "none";
	byId("bitrate-quality-wrap").style.display = "none";
	byId("bitrate-quality-head").innerHTML = "";
	byId("bitrate-quality-summary").innerHTML = "";
}

/** Stats of the scene CRFs, for the stats row above the charts. */
export function telemetryStats(t: JobTelemetry | null | undefined): Array<[string, string, string?]> {
	if (!t?.zones?.length) return [];
	const crfs = t.zones.map((z) => z.crf);
	const stats: Array<[string, string, string?]> = [
		["Scenes", String(t.zones.length)],
		["CRF", `${Math.min(...crfs)}–${Math.max(...crfs)}${t.baseCrf !== undefined ? `, base ${t.baseCrf}` : ""}`],
	];
	if (t.maxKbps > 0)
		stats.push(["Capped", `${t.zones.filter((z) => z.capped).length} at ${mbps(t.maxKbps)}`, "Scenes whose CRF was raised to stay under the max bitrate"]);
	return stats;
}

/** Draws the scene CRF chart and the quality panel for what `data` holds. */
export function renderEncodeReport(reportHost: ReportHost, id: string | null, data: BitrateAnalysisResult): void {
	stopPolling();
	host = reportHost;
	jobId = id;
	canMeasure = !!id && data.mode === "encoded" && !!data.canMeasure;
	measurement = data.measurement ?? null;
	qualityChart = null;
	actionError = "";
	renderCrfChart(data.telemetry);
	renderQuality();
	if (measurement?.status === "running") schedulePoll();
}

function renderCrfChart(t: JobTelemetry | null | undefined): void {
	const wrap = byId("bitrate-crf-wrap");
	if (!host || !t?.zones?.length) {
		wrap.style.display = "none";
		return;
	}
	wrap.style.display = "";
	const zones = t.zones;
	const step = (value: (z: (typeof zones)[number]) => number) =>
		zones.flatMap((z) => [
			{ x: z.start / t.fps, y: value(z) },
			{ x: z.end / t.fps, y: value(z) },
		]);
	const line = (label: string, color: string, extra: object = {}) => ({
		label,
		borderColor: color,
		backgroundColor: color,
		borderWidth: 1.5,
		pointRadius: 0,
		...extra,
	});
	host.makeChart(
		"bitrate-crf-canvas",
		[
			{ ...line("CRF", COLORS.crf), data: step((z) => z.crf) },
			{ ...line("Fast pass SSIMULACRA2 (15th percentile)", COLORS.score, { borderWidth: 1, yAxisID: "y1" }), data: step((z) => z.score) },
			{
				...line("Capped by max bitrate", COLORS.capped, { showLine: false, pointRadius: 3 }),
				data: zones.filter((z) => z.capped).map((z) => ({ x: (z.start + z.end) / 2 / t.fps, y: z.crf })),
			},
		],
		{
			y: { position: "left", title: { display: true, text: "CRF" } },
			y1: { position: "right", title: { display: true, text: "SSIMULACRA2" }, grid: { drawOnChartArea: false } },
		},
		(item: any) => `${item.dataset.label}: ${Number(item.parsed.y).toFixed(2)}`,
	);
}

function qualityPoints(m: EncodeMeasurement, metric: EncodeMetric): { x: number; y: number }[] {
	const out: { x: number; y: number }[] = [];
	(m.values[metric] ?? []).forEach((v, n) => {
		if (v !== null) out.push({ x: (m.firstFrame + n * m.step) / m.fps, y: v });
	});
	return out;
}

function showQualityChart(m: EncodeMeasurement): void {
	if (!host) return;
	if (!m.metrics.includes(chartMetric)) chartMetric = m.metrics[0]!;
	byId("bitrate-quality-wrap").style.display = "";
	const label = METRIC_LABELS[chartMetric];
	if (!qualityChart) {
		qualityChart = host.makeChart(
			"bitrate-quality-canvas",
			[{ label, data: qualityPoints(m, chartMetric), borderColor: COLORS.quality, backgroundColor: COLORS.quality, borderWidth: 1, pointRadius: 0 }],
			{ y: { position: "left", title: { display: true, text: label } } },
			(item: any) => `${METRIC_LABELS[chartMetric]}: ${formatScore(chartMetric, Number(item.parsed.y))}`,
			// Every frame of a film is far more points than pixels, so each pixel keeps its lowest and highest score.
			{ parsing: false, normalized: true, plugins: { decimation: { enabled: true, algorithm: "min-max" } } },
		);
		return;
	}
	const dataset = qualityChart.data.datasets[0]!;
	dataset.label = label;
	dataset.data = qualityPoints(m, chartMetric);
	qualityChart.options.scales.y.title.text = label;
	qualityChart.update("none");
}

function controlsHtml(running: boolean): string {
	const disabled = running ? "disabled" : "";
	return `<div class="compare-measure-controls">
		<label>Sample <select class="select-input" data-quality-field="interval" ${disabled}>${INTERVALS.map(([v, t]) => `<option value="${v}" ${v === interval ? "selected" : ""}>${t}</option>`).join("")}</select></label>
		${METRICS.map((metric) => `<label class="compare-measure-metric"><input type="checkbox" data-quality-metric="${metric}" ${metrics.has(metric) ? "checked" : ""} ${disabled}> ${METRIC_LABELS[metric]}</label>`).join("")}
		<label class="compare-measure-metric" title="On, an AV1 encode is scored as a player shows it, with its film grain. Off, the grain is left out so the scores show only what compression lost."><input type="checkbox" data-quality-field="withGrain" ${withGrain ? "checked" : ""} ${disabled}> Score with film grain</label>
		${
			running
				? '<button class="btn btn-ghost btn-sm" type="button" data-quality-action="cancel">Cancel</button>'
				: `<button class="btn btn-primary btn-sm" type="button" data-quality-action="start" ${metrics.size ? "" : "disabled"}>${measurement ? "Measure again" : "Measure"}</button>`
		}
	</div>`;
}

function renderQuality(): void {
	const section = byId("bitrate-quality");
	const m = measurement;
	if (!canMeasure && m?.status !== "done") {
		section.style.display = "none";
		return;
	}
	section.style.display = "";
	const running = m?.status === "running";
	let head = `<div class="compare-measure-head"><strong>Quality against the source</strong><span class="hdr-note">${
		canMeasure
			? "Scores the encode against its source over the whole video, with the crop the encode got. Higher is better. A long film takes a while, so sample less often for a quicker look."
			: "Measured against the source when this encode was finished."
	}</span></div>`;
	if (canMeasure) head += controlsHtml(running);
	if (running)
		head += `<div class="compare-progress-bar"><div style="width:${m!.progress}%"></div></div><div class="repair-subtitle">${escapeHtml(m!.detail || "Measuring")}... ${m!.progress}%</div>`;
	if (m?.status === "error") head += `<div class="sub-preview-error">${escapeHtml(m.error || "Measuring failed")}</div>`;
	if (m?.status === "cancelled") head += '<div class="repair-subtitle">Measuring was cancelled.</div>';
	if (actionError) head += `<div class="sub-preview-error">${escapeHtml(actionError)}</div>`;

	const done = m?.status === "done" && m.metrics.some((metric) => m.values[metric]?.length);
	if (done) {
		if (!m.metrics.includes(chartMetric)) chartMetric = m.metrics[0]!;
		const samples = Math.max(...m.metrics.map((metric) => m.values[metric]?.length ?? 0));
		const tabs = m.metrics
			.map(
				(metric) =>
					`<button class="btn btn-sm ${metric === chartMetric ? "btn-primary" : "btn-ghost"}" type="button" data-quality-chart="${metric}">${METRIC_LABELS[metric]}</button>`,
			)
			.join("");
		head += `<div class="compare-measure-tabs">${tabs}<span class="hdr-note">${samples.toLocaleString()} frames, ${intervalText(m.interval)}, ${m.withGrain === false ? "without film grain" : "with film grain"}</span></div>`;
	}
	const headEl = byId("bitrate-quality-head");
	headEl.innerHTML = head;
	headEl.onclick = handleClick;
	headEl.onchange = handleChange;

	const summary = byId("bitrate-quality-summary");
	if (!done) {
		byId("bitrate-quality-wrap").style.display = "none";
		summary.innerHTML = "";
		return;
	}
	showQualityChart(m);
	const rows = m.metrics
		.map((metric) => {
			const sum = m.summary[metric];
			if (!sum) return "";
			const at = sum.minFrame / m.fps;
			return `<tr><th>${METRIC_LABELS[metric]}</th><td>${formatScore(metric, sum.mean)}</td><td>${formatScore(metric, sum.p5)}</td><td><button class="btn btn-ghost btn-sm" type="button" data-quality-zoom="${at}" title="Zoom the charts to this moment">${formatScore(metric, sum.min)} at ${fmtTime(at)}</button></td></tr>`;
		})
		.join("");
	summary.innerHTML = `<table class="cm-table">
			<thead><tr><th>Metric</th><th>Mean</th><th>5% low</th><th>Worst</th></tr></thead>
			<tbody>${rows}</tbody>
		</table>
		<div class="hdr-note">${METRIC_GUIDES[chartMetric]} 5% low is the score the worst 5% of measured frames fall below, which shows dips better than the mean.</div>`;
	summary.onclick = handleClick;
}

function setMeasurement(m: EncodeMeasurement | null): void {
	measurement = m;
	host?.onMeasurement(m?.status === "done" ? m : null);
	renderQuality();
}

function schedulePoll(): void {
	stopPolling();
	const id = jobId;
	pollTimer = setTimeout(async () => {
		pollTimer = null;
		if (!id || id !== jobId) return;
		pollController = new AbortController();
		try {
			const m = await fetchJobMeasurement(id, pollController.signal);
			if (id !== jobId) return;
			setMeasurement(m);
			if (m?.status === "running") schedulePoll();
		} catch (error) {
			if (pollController?.signal.aborted || id !== jobId) return;
			actionError = errorMessage(error);
			renderQuality();
			schedulePoll();
		} finally {
			pollController = null;
		}
	}, POLL_MS);
}

async function startMeasuring(): Promise<void> {
	if (!jobId || !metrics.size) return;
	const id = jobId;
	actionError = "";
	try {
		const m = await startJobMeasurement(id, {
			interval: interval === "frame" ? "frame" : Number(interval),
			metrics: METRICS.filter((metric) => metrics.has(metric)),
			withGrain,
		});
		if (id !== jobId) return;
		setMeasurement(m);
		schedulePoll();
	} catch (error) {
		if (id !== jobId) return;
		actionError = errorMessage(error);
		renderQuality();
	}
}

function handleClick(event: MouseEvent): void {
	const target = event.target instanceof Element ? event.target : null;
	if (!target) return;
	const action = target.closest<HTMLElement>("[data-quality-action]")?.dataset.qualityAction;
	if (action === "start") return void startMeasuring();
	if (action === "cancel" && jobId) return void cancelJobMeasurement(jobId).catch(() => {});
	const tab = target.closest<HTMLElement>("[data-quality-chart]")?.dataset.qualityChart as EncodeMetric | undefined;
	if (tab) {
		chartMetric = tab;
		return renderQuality();
	}
	const zoom = target.closest<HTMLElement>("[data-quality-zoom]")?.dataset.qualityZoom;
	if (zoom !== undefined) host?.zoomAround(Number(zoom));
}

function handleChange(event: Event): void {
	const input = event.target as HTMLInputElement | HTMLSelectElement;
	const metric = input.dataset.qualityMetric as EncodeMetric | undefined;
	if (metric) {
		if ((input as HTMLInputElement).checked) metrics.add(metric);
		else metrics.delete(metric);
	} else if (input.dataset.qualityField === "interval") interval = input.value;
	else if (input.dataset.qualityField === "withGrain") withGrain = (input as HTMLInputElement).checked;
	renderQuality();
}
