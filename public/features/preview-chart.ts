import type { PreviewState } from "../types";
import {
	chartGeometry,
	chartSvg,
	frameAt,
	METRIC_GUIDES,
	METRIC_LABELS,
	seriesColor,
	tooltipHtml,
	type ChartGeometry,
	type MeasureState,
	type MetricName,
} from "./compare-measure";
import { escapeHtml } from "./job-render";
import { byId } from "../shared/dom";
import { formatTimestamp } from "./preview";

/** Chart choices, kept while the modal stays open between runs. */
let chartMetric: MetricName = "ssimulacra2";
/** Sample index to show, or null for every clip on one time axis. */
let chartClip: number | null = null;
let chartHover: number | null = null;
let chartGeo: ChartGeometry | null = null;
let chartData: { measure: MeasureState; labels: string[] } | null = null;
let renderedKey = "";
let lastState: PreviewState | null = null;

/**
 * Clips as the series of a Compare measure, so its chart draws them. Each clip
 * is its own series, numbered from 1 so its colour matches its legend entry.
 * One clip is placed at its time in the source, all clips start at 0:00.
 */
function chartMeasure(state: PreviewState, metric: MetricName): { measure: MeasureState; labels: string[] } {
	const scored = state.samples.filter((s) => s.scoreValues?.[metric]?.length);
	const shown = chartClip === null ? scored : scored.filter((s) => s.index === chartClip);
	const labels: string[] = [];
	for (const s of scored) labels[s.index + 1] = `Clip ${s.index + 1} · ${formatTimestamp(s.timestampSec)}`;
	const measure: MeasureState = {
		status: "done",
		progress: 100,
		interval: "frame",
		metrics: [metric],
		step: 1,
		fps: state.fps || 24,
		videoStart: chartClip === null ? 0 : (shown[0]?.timestampSec ?? 0),
		series: shown.map((s) => ({ source: s.index + 1, firstFrame: 0, values: { [metric]: s.scoreValues![metric]! }, summary: {} })),
	};
	return { measure, labels };
}

export function renderPreviewChart(state: PreviewState): void {
	lastState = state;
	const host = byId("preview-chart");
	const metrics = (state.metrics || []).filter((m) => state.samples.some((s) => s.scoreValues?.[m]?.length));
	if (!metrics.length) {
		host.style.display = "none";
		host.innerHTML = "";
		renderedKey = "";
		return;
	}
	if (!metrics.includes(chartMetric)) chartMetric = metrics[0]!;
	const scored = state.samples.filter((s) => s.scoreValues?.[chartMetric]?.length);
	if (chartClip !== null && !scored.some((s) => s.index === chartClip)) chartClip = null;

	host.style.display = "";
	// Less the padding, so the chart is drawn at the size it shows.
	const width = Math.max(320, (host.clientWidth || 928) - 28);
	const key = JSON.stringify([
		chartMetric,
		chartClip,
		width,
		metrics,
		state.metricsWithGrain,
		state.samples.map((s) => [s.index, ...metrics.map((m) => s.scoreValues?.[m]?.length ?? 0), s.scores?.[chartMetric]?.mean]),
	]);
	if (key === renderedKey) return;
	renderedKey = key;
	chartHover = null;

	chartData = chartMeasure(state, chartMetric);
	const { measure, labels } = chartData;
	chartGeo = chartGeometry(measure, chartMetric, width);
	const chart = chartGeo ? chartSvg(measure, chartMetric, chartGeo, null, labels) : "";

	const tabs = metrics
		.map(
			(metric) =>
				`<button class="btn btn-sm ${metric === chartMetric ? "btn-primary" : "btn-ghost"}" type="button" data-preview-chart-metric="${metric}">${METRIC_LABELS[metric]}</button>`,
		)
		.join("");
	const options = [
		`<option value="all" ${chartClip === null ? "selected" : ""}>All clips</option>`,
		...scored.map((s) => `<option value="${s.index}" ${chartClip === s.index ? "selected" : ""}>${escapeHtml(labels[s.index + 1]!)}</option>`),
	].join("");
	const legend = measure.series
		.map(
			(s) =>
				`<span class="cm-legend-item"><span class="cm-key" style="background:${seriesColor(s.source)}"></span>${escapeHtml(labels[s.source] ?? "")}</span>`,
		)
		.join("");
	const axis = chartClip === null ? "Time is measured from the start of each clip." : "Time is the clip's place in the source.";

	host.innerHTML = `
		<div class="compare-measure-tabs">${tabs}
			<select class="select-input preview-chart-clip" data-preview-chart-clip aria-label="Clip to show">${options}</select>
		</div>
		<div class="cm-legend">${legend}</div>
		<div class="cm-chart-wrap" id="preview-chart-plot">${chart}<div class="cm-tip" id="preview-chart-tip" hidden></div></div>
		<div class="hdr-note">${axis} ${METRIC_GUIDES[chartMetric]}</div>`;
}

export function handlePreviewChartClick(event: MouseEvent): void {
	const btn = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-preview-chart-metric]") : null;
	if (!btn || !lastState) return;
	chartMetric = btn.dataset.previewChartMetric as MetricName;
	renderPreviewChart(lastState);
}

export function handlePreviewChartChange(event: Event): void {
	const select = event.target;
	if (!(select instanceof HTMLSelectElement) || select.dataset.previewChartClip === undefined || !lastState) return;
	chartClip = select.value === "all" ? null : parseInt(select.value, 10);
	renderPreviewChart(lastState);
}

/** Crosshair and tooltip follow the pointer, snapped to the nearest frame. */
export function handlePreviewChartMove(event: MouseEvent): void {
	const svg = event.target instanceof Element ? event.target.closest<SVGSVGElement>(".cm-chart") : null;
	if (!chartData || !chartGeo || !svg) return void handlePreviewChartLeave();
	const { measure, labels } = chartData;
	const box = svg.getBoundingClientRect();
	const x = ((event.clientX - box.left) / box.width) * chartGeo.width;
	if (x < chartGeo.left - 4 || x > chartGeo.right + 4) return;
	const hovered = frameAt(chartGeo, measure, x);
	if (hovered === chartHover) return;
	chartHover = hovered;
	const tip = byId("preview-chart-tip");
	svg.outerHTML = chartSvg(measure, chartMetric, chartGeo, chartHover, labels);
	tip.innerHTML = tooltipHtml(measure, chartMetric, chartHover, labels, "");
	tip.hidden = false;
	const px =
		((chartGeo.left + ((chartHover - chartGeo.minFrame) / (chartGeo.maxFrame - chartGeo.minFrame)) * (chartGeo.right - chartGeo.left)) / chartGeo.width) *
		box.width;
	const flip = px > box.width * 0.65;
	tip.style.left = flip ? "" : `${px + 12}px`;
	tip.style.right = flip ? `${box.width - px + 12}px` : "";
}

export function handlePreviewChartLeave(): void {
	if (chartHover === null || !chartData || !chartGeo) return;
	chartHover = null;
	const svg = byId("preview-chart").querySelector(".cm-chart");
	if (svg) svg.outerHTML = chartSvg(chartData.measure, chartMetric, chartGeo, null, chartData.labels);
	const tip = document.getElementById("preview-chart-tip");
	if (tip) tip.hidden = true;
}

/** A new run starts on all clips again. */
export function resetPreviewChart(): void {
	chartClip = null;
	renderedKey = "";
}
