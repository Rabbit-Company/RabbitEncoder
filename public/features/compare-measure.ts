export type MetricName = "ssimulacra2" | "xpsnr" | "vmaf";
export const METRICS: MetricName[] = ["ssimulacra2", "xpsnr", "vmaf"];
export type FrameScores = Partial<Record<MetricName, number>>;

export interface MetricSummary {
	mean: number;
	p5: number;
	min: number;
	minFrame: number;
	count: number;
}

export interface MeasureSeries {
	source: number;
	firstFrame: number;
	values: Partial<Record<MetricName, Array<number | null>>>;
	summary: Partial<Record<MetricName, MetricSummary>>;
	skipped?: string;
}

export interface MeasureState {
	status: "running" | "done" | "error" | "cancelled";
	progress: number;
	detail?: string;
	error?: string;
	interval: "frame" | number;
	metrics: MetricName[];
	withGrain?: boolean;
	step: number;
	fps: number;
	videoStart: number;
	series: MeasureSeries[];
}

export const METRIC_LABELS: Record<MetricName, string> = { ssimulacra2: "SSIMULACRA2", xpsnr: "XPSNR", vmaf: "VMAF" };
/** How to read each metric, shown under the chart for the one picked. */
export const METRIC_GUIDES: Record<MetricName, string> = {
	ssimulacra2:
		"SSIMULACRA2 follows what people see, from 100 for identical pictures down. Above 90 is visually lossless, 80 very good, 70 good, below 50 clearly degraded.",
	xpsnr:
		"XPSNR is a PSNR in dB weighted by how visible each error is, 100 for identical pictures. As a rough guide, above 45 dB is near transparent, 40 to 45 very good, 35 to 40 good, below 30 clearly degraded. It is best for ranking encodes of the same source.",
	vmaf: "VMAF predicts how a viewer rates the video at TV distance, up to about 100. Above 95 is indistinguishable for most viewers, 90 high quality, 80 good, below 70 visibly worse. It can miss banding and fine detail loss that SSIMULACRA2 catches.",
};

/** How often the whole video is sampled, as select values and labels. */
export const INTERVALS: Array<[string, string]> = [
	["frame", "Every frame"],
	["0.25", "4 per second"],
	["0.5", "2 per second"],
	["1", "1 per second"],
	["2", "Every 2 seconds"],
	["5", "Every 5 seconds"],
	["10", "Every 10 seconds"],
];

export function intervalText(interval: "frame" | number): string {
	return INTERVALS.find(([v]) => v === String(interval))?.[1].toLowerCase() ?? `every ${interval} s`;
}

const UNITS: Record<MetricName, string> = { ssimulacra2: "", xpsnr: " dB", vmaf: "" };

/** Categorical slots stepped for the dark surface, by source number, so an encode keeps its colour. */
const SERIES_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9"];

export function seriesColor(source: number): string {
	return SERIES_COLORS[(source - 1) % SERIES_COLORS.length]!;
}

export function formatScore(metric: MetricName, value: number): string {
	return `${value.toFixed(metric === "xpsnr" ? 2 : 1)}${UNITS[metric]}`;
}

export function scoreSummary(scores: FrameScores): string {
	return METRICS.filter((m) => scores[m] !== undefined)
		.map((m) => `${METRIC_LABELS[m]} ${formatScore(m, scores[m]!)}`)
		.join(" · ");
}

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

function clock(sec: number): string {
	const h = Math.floor(sec / 3600);
	const m = Math.floor(sec / 60) % 60;
	const s = Math.floor(sec % 60);
	return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export interface ChartGeometry {
	width: number;
	height: number;
	left: number;
	right: number;
	top: number;
	bottom: number;
	minFrame: number;
	maxFrame: number;
	low: number;
	high: number;
}

/** Taller on wider screens, so the lines are not squashed. */
const chartHeight = (width: number) => Math.round(Math.min(440, Math.max(300, width * 0.28)));
const PAD = { left: 44, right: 12, top: 12, bottom: 28 };

/** Even steps that cover the range, such as 10 or 25. */
function niceStep(span: number, target: number): number {
	const raw = span / Math.max(1, target);
	const magnitude = 10 ** Math.floor(Math.log10(raw || 1));
	return [1, 2, 2.5, 5, 10].map((k) => k * magnitude).find((k) => k >= raw) ?? raw;
}

/** First and last measured frame over every line of the metric. */
export function frameExtent(measure: MeasureState, metric: MetricName): [number, number] | null {
	let minFrame = Infinity;
	let maxFrame = -Infinity;
	for (const s of measure.series) {
		const values = s.values[metric];
		if (!values?.length) continue;
		minFrame = Math.min(minFrame, s.firstFrame);
		maxFrame = Math.max(maxFrame, s.firstFrame + (values.length - 1) * measure.step);
	}
	return Number.isFinite(minFrame) ? [minFrame, Math.max(maxFrame, minFrame + 1)] : null;
}

/** Layout of the chart over `view`, a stretch of frames, or over everything. The score axis fits the frames in view. */
export function chartGeometry(measure: MeasureState, metric: MetricName, width: number, view?: [number, number] | null): ChartGeometry | null {
	const extent = frameExtent(measure, metric);
	if (!extent) return null;
	const [minFrame, maxFrame] = view ?? extent;
	let low = Infinity;
	let high = -Infinity;
	for (const s of measure.series) {
		(s.values[metric] ?? []).forEach((v, n) => {
			const frame = s.firstFrame + n * measure.step;
			if (v === null || frame < minFrame || frame > maxFrame) return;
			if (v < low) low = v;
			if (v > high) high = v;
		});
	}
	if (!Number.isFinite(low)) return null;
	const step = niceStep(Math.max(1, high - low), 6);
	low = Math.floor(low / step) * step;
	high = Math.ceil(high / step) * step;
	if (metric !== "xpsnr") high = Math.min(high, 100);
	if (high <= low) high = low + step;
	const height = chartHeight(width);
	return {
		width,
		height,
		left: PAD.left,
		right: width - PAD.right,
		top: PAD.top,
		bottom: height - PAD.bottom,
		minFrame,
		maxFrame: Math.max(maxFrame, minFrame + 1),
		low,
		high,
	};
}

const xOf = (g: ChartGeometry, frame: number) => g.left + ((frame - g.minFrame) / (g.maxFrame - g.minFrame)) * (g.right - g.left);
const yOf = (g: ChartGeometry, value: number) => g.bottom - ((value - g.low) / (g.high - g.low)) * (g.bottom - g.top);

/** Frame under a horizontal position of the chart, snapped to a sample. */
export function frameAt(g: ChartGeometry, measure: MeasureState, x: number): number {
	const t = Math.min(1, Math.max(0, (x - g.left) / (g.right - g.left)));
	const frame = g.minFrame + t * (g.maxFrame - g.minFrame);
	return g.minFrame + Math.round((frame - g.minFrame) / measure.step) * measure.step;
}

/**
 * Points of one line. Past two samples per pixel each pixel keeps its lowest
 * and highest score, so a dip of a single frame still shows.
 */
function linePoints(g: ChartGeometry, measure: MeasureState, s: MeasureSeries, metric: MetricName): string {
	const values = s.values[metric] ?? [];
	const pixels = Math.max(1, Math.round(g.right - g.left));
	const out: string[] = [];
	const point = (frame: number, v: number) => `${xOf(g, frame).toFixed(1)},${yOf(g, v).toFixed(1)}`;
	// One sample beyond each edge, so the line runs to the edge of the plot.
	const inView = (frame: number) => frame >= g.minFrame - measure.step && frame <= g.maxFrame + measure.step;
	const visible = (g.maxFrame - g.minFrame) / measure.step + 1;
	if (visible <= pixels * 2) {
		values.forEach((v, n) => {
			const frame = s.firstFrame + n * measure.step;
			if (v !== null && inView(frame)) out.push(point(frame, v));
		});
		return out.join(" ");
	}
	let bucket = -1;
	let lo: [number, number] | null = null;
	let hi: [number, number] | null = null;
	const flush = () => {
		if (!lo || !hi) return;
		const [a, b] = lo[0] <= hi[0] ? [lo, hi] : [hi, lo];
		out.push(point(a[0], a[1]), point(b[0], b[1]));
	};
	values.forEach((v, n) => {
		if (v === null) return;
		const frame = s.firstFrame + n * measure.step;
		if (frame < g.minFrame - measure.step || frame > g.maxFrame + measure.step) return;
		const px = Math.floor(xOf(g, frame) - g.left);
		if (px !== bucket) {
			flush();
			bucket = px;
			lo = hi = null;
		}
		if (!lo || v < lo[1]) lo = [frame, v];
		if (!hi || v > hi[1]) hi = [frame, v];
	});
	flush();
	return out.join(" ");
}

export function valueAt(measure: MeasureState, s: MeasureSeries, metric: MetricName, frame: number): number | null {
	const n = (frame - s.firstFrame) / measure.step;
	return Number.isInteger(n) ? (s.values[metric]?.[n] ?? null) : null;
}

/** The chart as SVG: hairline grid, time axis, one 2px line per encode, and the hover crosshair. */
export function chartSvg(measure: MeasureState, metric: MetricName, g: ChartGeometry, hoverFrame: number | null, labels: string[]): string {
	const yStep = niceStep(g.high - g.low, 6);
	const grid: string[] = [];
	for (let v = g.low; v <= g.high + 1e-9; v += yStep) {
		const y = yOf(g, v).toFixed(1);
		grid.push(`<line class="cm-grid" x1="${g.left}" x2="${g.right}" y1="${y}" y2="${y}"/>`);
		grid.push(`<text class="cm-axis" x="${g.left - 6}" y="${y}" text-anchor="end" dominant-baseline="middle">${Number(v.toFixed(2))}</text>`);
	}
	const seconds = (g.maxFrame - g.minFrame) / measure.fps;
	const xStep = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].find((k) => seconds / k <= 7) ?? 3600;
	const startSec = measure.videoStart + g.minFrame / measure.fps;
	for (let t = Math.ceil(startSec / xStep) * xStep; t <= measure.videoStart + g.maxFrame / measure.fps; t += xStep) {
		const x = xOf(g, (t - measure.videoStart) * measure.fps).toFixed(1);
		grid.push(`<text class="cm-axis" x="${x}" y="${g.bottom + 18}" text-anchor="middle">${clock(t)}</text>`);
	}
	const lines = measure.series
		.filter((s) => s.values[metric]?.length)
		.map(
			(s) =>
				`<polyline class="cm-line" clip-path="url(#cm-plot)" stroke="${seriesColor(s.source)}" points="${linePoints(g, measure, s, metric)}"><title>${escapeHtml(labels[s.source] ?? "")}</title></polyline>`,
		);
	let hover = "";
	if (hoverFrame !== null) {
		const x = xOf(g, hoverFrame).toFixed(1);
		hover = `<line class="cm-crosshair" x1="${x}" x2="${x}" y1="${g.top}" y2="${g.bottom}"/>`;
		for (const s of measure.series) {
			const v = valueAt(measure, s, metric, hoverFrame);
			if (v !== null) hover += `<circle class="cm-dot" cx="${x}" cy="${yOf(g, v).toFixed(1)}" r="4" fill="${seriesColor(s.source)}"/>`;
		}
	}
	return `<svg class="cm-chart" width="${g.width}" height="${g.height}" viewBox="0 0 ${g.width} ${g.height}" role="img" aria-label="${METRIC_LABELS[metric]} per frame">
		<defs><clipPath id="cm-plot"><rect x="${g.left}" y="${g.top - 2}" width="${g.right - g.left}" height="${g.bottom - g.top + 4}"/></clipPath></defs>
		<line class="cm-baseline" x1="${g.left}" x2="${g.right}" y1="${g.bottom}" y2="${g.bottom}"/>
		${grid.join("")}${lines.join("")}${hover}
		<rect class="cm-hit" x="${g.left}" y="${g.top}" width="${g.right - g.left}" height="${g.bottom - g.top}"/>
	</svg>`;
}

export function tooltipHtml(measure: MeasureState, metric: MetricName, frame: number, labels: string[], hint = "Click to capture this frame"): string {
	const time = measure.videoStart + frame / measure.fps;
	const rows = measure.series
		.map((s) => {
			const v = valueAt(measure, s, metric, frame);
			return v === null
				? ""
				: `<div class="cm-tip-row"><span class="cm-key" style="background:${seriesColor(s.source)}"></span><span>${escapeHtml(labels[s.source] ?? "")}</span><strong>${formatScore(metric, v)}</strong></div>`;
		})
		.join("");
	return `<div class="cm-tip-head">${clock(time)}.${String(Math.round((time % 1) * 1000)).padStart(3, "0")} · frame ${frame}</div>${rows}${hint ? `<div class="cm-tip-hint">${hint}</div>` : ""}`;
}
