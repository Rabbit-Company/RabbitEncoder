import type { BenchmarkMode, BenchmarkResult, BenchmarkState, SystemStats } from "../ui/models";
import { cancelBenchmarkRun, fetchBenchmark, fetchSystemStats, startBenchmarkRun } from "../api/client";
import { PARAM_LEVELS } from "../config/options";
import { escapeHtml } from "./job-render";
import { buttonById, byId } from "../shared/dom";
import { errorMessage } from "../shared/errors";
import { appState } from "../state";

export function formatElapsed(ms: number): string {
	const total = Math.floor(ms / 1000);
	const m = Math.floor(total / 60);
	const s = total % 60;
	return `${m}:${String(s).padStart(2, "0")}`;
}

export function classifySpeedup(x?: number | null): string {
	if (x === null || x === undefined || isNaN(x)) return "";
	if (x >= 2) return "speedup-good";
	if (x >= 1.2) return "speedup-meh";
	return "speedup-bad";
}

export function fmtBytes(n?: number | null): string {
	if (n == null) return "N/A";
	const u = ["B", "KiB", "MiB", "GiB", "TiB"];
	let i = 0;
	while (n >= 1024 && i < u.length - 1) {
		n /= 1024;
		i++;
	}
	return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}
export function fmtRate(bps?: number | null): string {
	if (bps == null) return "N/A";
	return `${fmtBytes(bps)}/s`;
}
export function pctClass(p?: number | null): "ok" | "warn" | "crit" {
	if (p == null) return "ok";
	if (p >= 90) return "crit";
	if (p >= 75) return "warn";
	return "ok";
}

export function sysMeter(percent?: number | null): string {
	const cls = pctClass(percent);
	const w = percent == null ? 0 : Math.min(100, percent);
	return `<span class="sysbar-meter"><span class="sysbar-meter-fill ${cls}" style="width:${w}%"></span></span>`;
}

export function sysPill(key: string, value: string, percent?: number | null, title?: string): string {
	return `
		<div class="sysbar-stat" title="${escapeHtml(title || "")}">
			<span class="sysbar-key">${key}</span>
			<span class="sysbar-val ${pctClass(percent)}">${value}</span>
			${sysMeter(percent)}
		</div>`;
}

export function renderSysBar(s: SystemStats): void {
	const bar = byId("sysbar");
	if (!bar) return;

	let html = `<span class="sysbar-lead" aria-hidden="true">
		<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h4l3 8 4-16 3 8h4"/></svg>
	</span>`;

	const cpuTitle = `${s.cpuName ? s.cpuName + ", " : ""}${s.cpuCount} threads${s.loadAvg ? ", load " + s.loadAvg[0]?.toFixed(2) : ""}`;
	html += sysPill("CPU", s.cpuUsagePercent == null ? "N/A" : `${Math.round(s.cpuUsagePercent)}%`, s.cpuUsagePercent, cpuTitle);

	if (s.mem) {
		html += sysPill("RAM", `${Math.round(s.mem.usedPercent)}%`, s.mem.usedPercent, `${fmtBytes(s.mem.usedBytes)} / ${fmtBytes(s.mem.totalBytes)} used`);
	}
	if (s.disk) {
		html += sysPill(
			"DISK",
			`${Math.round(s.disk.usedPercent)}%`,
			s.disk.usedPercent,
			`${fmtBytes(s.disk.availableBytes)} free of ${fmtBytes(s.disk.totalBytes)} (${s.disk.path})`,
		);
	}
	if (s.gpu && s.gpu.utilizationPercent != null) {
		const vram = s.gpu.memTotalBytes ? `, VRAM ${fmtBytes(s.gpu.memUsedBytes)} / ${fmtBytes(s.gpu.memTotalBytes)}` : "";
		html += sysPill("GPU", `${Math.round(s.gpu.utilizationPercent)}%`, s.gpu.utilizationPercent, `${s.gpu.name || "GPU"}${vram}`);
	}
	if (s.net) {
		html += `
			<div class="sysbar-net">
				<span><span class="sysbar-net-label">↓</span> ${fmtRate(s.net.rxBytesPerSec)}</span>
				<span><span class="sysbar-net-label">↑</span> ${fmtRate(s.net.txBytesPerSec)}</span>
			</div>`;
	}

	bar.innerHTML = html;
	document.documentElement.style.setProperty("--sysbar-h", `${bar.offsetHeight}px`);
}

export async function tickSystem() {
	try {
		renderSysBar(await fetchSystemStats());
	} catch (e) {
		if (errorMessage(e) !== "Unauthorized") console.error("System poll error:", e);
	}
}

export function startSystemPolling() {
	stopSystemPolling();
	tickSystem();
	appState.systemPollTimer = setInterval(tickSystem, 2000);
}

export function stopSystemPolling() {
	if (appState.systemPollTimer) clearInterval(appState.systemPollTimer);
	appState.systemPollTimer = null;
}

const BENCHMARK_MODE_LABELS: Record<BenchmarkMode, string> = {
	cpu: "CPU nlmeans",
	opencl: "OpenCL nlmeans",
	vulkan: "Vulkan nlmeans",
	"avd-nlmeans": "AVD NLMeans",
	"avd-nlmeans-hq": "AVD NLMeans-HQ",
	"avd-nl4d": "AVD NL4D",
};
const BENCHMARK_MODES = Object.keys(BENCHMARK_MODE_LABELS) as BenchmarkMode[];
const BENCHMARK_MODES_STORAGE_KEY = "benchmarkModes";

function loadSelectedBenchmarkModes(): Set<BenchmarkMode> {
	try {
		const saved = JSON.parse(localStorage.getItem(BENCHMARK_MODES_STORAGE_KEY) || "null");
		if (Array.isArray(saved)) {
			const valid = BENCHMARK_MODES.filter((m) => saved.includes(m));
			if (valid.length > 0) return new Set(valid);
		}
	} catch {}
	return new Set(BENCHMARK_MODES);
}

const selectedBenchmarkModes = loadSelectedBenchmarkModes();

/** Checkbox per engine. Engines this machine cannot run are still listed, the run just skips them. */
export function renderBenchmarkModes(state: BenchmarkState): void {
	const container = byId("benchmark-modes");
	const running = state.status === "running";
	container.innerHTML = "";

	for (const mode of BENCHMARK_MODES) {
		const unavailable = mode.startsWith("avd-") && state.avdAvailable === false;
		const label = document.createElement("label");
		label.className = "radio-pill";
		if (unavailable) label.title = "av-denoise found no usable GPU on this machine";

		const input = document.createElement("input");
		input.type = "checkbox";
		input.checked = selectedBenchmarkModes.has(mode) && !unavailable;
		input.disabled = running || unavailable;
		input.onchange = () => {
			if (input.checked) selectedBenchmarkModes.add(mode);
			else selectedBenchmarkModes.delete(mode);
			try {
				localStorage.setItem(BENCHMARK_MODES_STORAGE_KEY, JSON.stringify([...selectedBenchmarkModes]));
			} catch {}
		};

		const text = document.createElement("span");
		text.textContent = BENCHMARK_MODE_LABELS[mode];
		label.appendChild(input);
		label.appendChild(text);
		container.appendChild(label);
	}
}

export function renderBenchmarkResults(state: BenchmarkState): void {
	const container = byId("benchmark-results");
	const levels = PARAM_LEVELS;

	if (state.results.length === 0 && state.status !== "completed") {
		container.style.display = "none";
		return;
	}

	const byMode = new Map<BenchmarkMode, Map<BenchmarkResult["level"], BenchmarkResult>>();
	for (const r of state.results) {
		if (!byMode.has(r.mode)) byMode.set(r.mode, new Map());
		byMode.get(r.mode)!.set(r.level, r);
	}
	// One column per engine of this run, in the fixed display order.
	const modes = BENCHMARK_MODES.filter((m) => byMode.has(m) || (state.modes ?? []).includes(m));
	const others = modes.filter((m) => m !== "cpu");
	const hasCpu = modes.includes("cpu");

	const fpsOf = (mode: BenchmarkMode, level: BenchmarkResult["level"]): number | null => {
		const r = byMode.get(mode)?.get(level);
		return r && !r.error && r.fps != null ? r.fps : null;
	};

	const cell = (mode: BenchmarkMode, level: BenchmarkResult["level"]): string => {
		const entry = byMode.get(mode)?.get(level);
		if (!entry) return `<td class="numeric cell-empty">N/A</td>`;
		if (entry.error) return `<td class="numeric cell-failed" title="${escapeHtml(entry.error)}">failed</td>`;
		if (entry.fps == null) return `<td class="numeric cell-empty">N/A</td>`;
		const speed = entry.speed ? ` <span class="cell-empty">(${escapeHtml(entry.speed)})</span>` : "";
		return `<td class="numeric">${entry.fps.toFixed(2)}${speed}</td>`;
	};

	const speedupSum = new Map<BenchmarkMode, { sum: number; count: number }>();

	const rows = levels
		.map((level) => {
			const cpuFps = fpsOf("cpu", level);
			let best: number | null = null;
			for (const mode of others) {
				const fps = fpsOf(mode, level);
				if (!cpuFps || !fps) continue;
				const speedup = fps / cpuFps;
				const acc = speedupSum.get(mode) ?? { sum: 0, count: 0 };
				acc.sum += speedup;
				acc.count++;
				speedupSum.set(mode, acc);
				if (best === null || speedup > best) best = speedup;
			}

			const speedupCell = !hasCpu
				? ""
				: best !== null
					? `<td class="numeric ${classifySpeedup(best)}">${best.toFixed(2)}x</td>`
					: `<td class="numeric cell-empty">N/A</td>`;

			return `<tr>
				<td class="level-cell">${level}</td>
				${modes.map((m) => cell(m, level)).join("")}
				${speedupCell}
			</tr>`;
		})
		.join("");

	const headers = [
		`<th>Level</th>`,
		...modes.map((m) => `<th class="numeric">${escapeHtml(BENCHMARK_MODE_LABELS[m])} fps</th>`),
		hasCpu ? `<th class="numeric">Best vs CPU</th>` : "",
	].join("");

	container.innerHTML = `<table>
		<thead><tr>${headers}</tr></thead>
		<tbody>${rows}</tbody>
	</table>`;

	if (state.status === "completed") {
		let recHtml = "";
		const averages = others
			.map((m) => ({ mode: m, acc: speedupSum.get(m) }))
			.filter((x) => x.acc && x.acc.count > 0)
			.map((x) => ({ mode: x.mode, avg: x.acc!.sum / x.acc!.count }));

		if (averages.length > 0) {
			const top = Math.max(...averages.map((a) => a.avg));
			const cls = top >= 2 ? "good" : top >= 1.2 ? "meh" : "bad";
			const parts = averages.map((a) => `${BENCHMARK_MODE_LABELS[a.mode]} ${a.avg.toFixed(1)}x`);
			recHtml = `<div class="benchmark-recommendation ${cls}">Speed vs CPU nlmeans: ${escapeHtml(parts.join(", "))}. The engines differ in quality, so faster is not the same as better.</div>`;
		} else if (hasCpu && others.length === 0 && state.openclAvailable === false && state.vulkanAvailable === false) {
			recHtml = `<div class="benchmark-recommendation meh">No GPU backend available. Denoising will run on CPU.</div>`;
		}

		container.insertAdjacentHTML("beforeend", recHtml);
	}

	container.style.display = "";
}

export function renderBenchmark(state: BenchmarkState): void {
	const cpuEl = byId("benchmark-cpu-name");
	const gpuEl = byId("benchmark-gpu-name");

	if (cpuEl) cpuEl.textContent = state.cpuName || "Unknown";
	if (gpuEl) {
		if (state.gpuName) {
			gpuEl.textContent = `${state.gpuName.split("(")[0]?.trim()} (${state.gpuDevice})`;
			gpuEl.classList.remove("benchmark-hardware-missing");
		} else if (state.gpuDevice) {
			gpuEl.textContent = `Device ${state.gpuDevice} not found`;
			gpuEl.classList.add("benchmark-hardware-missing");
		} else {
			gpuEl.textContent = "Not available";
			gpuEl.classList.add("benchmark-hardware-missing");
		}
	}

	const statusEl = byId("benchmark-status");
	const statusLabel = byId("benchmark-status-label");
	const statusStep = byId("benchmark-status-step");
	const statusFill = byId("benchmark-progress-fill");
	const statusMeta = byId("benchmark-status-meta");
	const errEl = byId("benchmark-error");
	const runBtn = buttonById("benchmark-run-btn");
	const cancelBtn = buttonById("benchmark-cancel-btn");
	const noteEl = byId("benchmark-note");

	errEl.style.display = "none";

	if (state.status === "running") {
		statusEl.style.display = "";
		statusLabel.textContent = state.currentLabel || "Running...";
		statusStep.textContent = state.totalSteps > 0 ? `Step ${state.currentStep} / ${state.totalSteps}` : "";
		const pct = state.totalSteps > 0 ? Math.min(100, (state.currentStep / state.totalSteps) * 100) : 0;
		statusFill.style.width = `${pct}%`;
		const elapsed = state.startedAt ? Date.now() - state.startedAt : 0;
		statusMeta.textContent = `Elapsed ${formatElapsed(elapsed)}, ${state.size}, ${state.duration}s @ ${state.rate} fps`;
		runBtn.style.display = "none";
		cancelBtn.style.display = "";
		noteEl.textContent = "";
	} else if (state.status === "completed") {
		statusEl.style.display = "";
		statusLabel.textContent = "Completed";
		statusStep.textContent = `${state.results.length} / ${state.totalSteps} runs`;
		statusFill.style.width = "100%";
		const elapsed = state.startedAt && state.completedAt ? state.completedAt - state.startedAt : 0;
		statusMeta.textContent = `Total ${formatElapsed(elapsed)}, ${state.size}, ${state.duration}s @ ${state.rate} fps`;
		runBtn.style.display = "";
		runBtn.textContent = "Run Again";
		cancelBtn.style.display = "none";
		noteEl.textContent = "";
	} else if (state.status === "failed") {
		statusEl.style.display = "none";
		errEl.textContent = state.error || "Benchmark failed";
		errEl.style.display = "";
		runBtn.style.display = "";
		runBtn.textContent = "Retry";
		cancelBtn.style.display = "none";
		noteEl.textContent = "";
	} else if (state.status === "cancelled") {
		statusEl.style.display = "";
		statusLabel.textContent = "Cancelled";
		statusStep.textContent = "";
		statusMeta.textContent = "";
		runBtn.style.display = "";
		runBtn.textContent = "Run Benchmark";
		cancelBtn.style.display = "none";
		noteEl.textContent = "";
	} else {
		// idle
		statusEl.style.display = "none";
		runBtn.style.display = "";
		runBtn.textContent = "Run Benchmark";
		cancelBtn.style.display = "none";
		noteEl.textContent = "";
	}

	renderBenchmarkModes(state);
	renderBenchmarkResults(state);
}

export function startBenchmarkPolling() {
	stopBenchmarkPolling();
	const tick = async () => {
		try {
			const state = await fetchBenchmark();
			renderBenchmark(state);
			if (state.status !== "running") {
				stopBenchmarkPolling();
			}
		} catch {
			stopBenchmarkPolling();
		}
	};
	appState.benchmarkPollTimer = setInterval(tick, 700);
	tick();
}

export function stopBenchmarkPolling() {
	if (appState.benchmarkPollTimer) clearInterval(appState.benchmarkPollTimer);
	appState.benchmarkPollTimer = null;
}

export async function openBenchmark() {
	byId("benchmark-modal").style.display = "";
	try {
		const state = await fetchBenchmark();
		renderBenchmark(state);
		if (state.status === "running") startBenchmarkPolling();
	} catch {
		byId("benchmark-error").textContent = "Failed to load benchmark state";
		byId("benchmark-error").style.display = "";
	}
}

export function closeBenchmark() {
	byId("benchmark-modal").style.display = "none";
	stopBenchmarkPolling();
}

export function closeBenchmarkIfOutside(e: MouseEvent): void {
	if (e.target === e.currentTarget) closeBenchmark();
}

export async function handleBenchmarkRun() {
	const runBtn = buttonById("benchmark-run-btn");
	const noteEl = byId("benchmark-note");
	runBtn.disabled = true;
	runBtn.textContent = "Starting...";
	noteEl.textContent = "";
	if (selectedBenchmarkModes.size === 0) {
		noteEl.textContent = "Select at least one engine to benchmark";
		runBtn.disabled = false;
		runBtn.textContent = "Run Benchmark";
		return;
	}
	try {
		const result = await startBenchmarkRun(BENCHMARK_MODES.filter((m) => selectedBenchmarkModes.has(m)));
		if (result.error) {
			noteEl.textContent = result.error;
			runBtn.textContent = "Run Benchmark";
		} else {
			renderBenchmark(result);
			startBenchmarkPolling();
		}
	} catch {
		noteEl.textContent = "Failed to start benchmark";
		runBtn.textContent = "Run Benchmark";
	} finally {
		runBtn.disabled = false;
	}
}

export async function handleBenchmarkCancel() {
	const cancelBtn = buttonById("benchmark-cancel-btn");
	cancelBtn.disabled = true;
	try {
		await cancelBenchmarkRun();
		const state = await fetchBenchmark();
		renderBenchmark(state);
		stopBenchmarkPolling();
	} catch {
	} finally {
		cancelBtn.disabled = false;
	}
}
