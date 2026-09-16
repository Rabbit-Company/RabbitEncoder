import type { BenchmarkResult, BenchmarkState, SystemStats } from "../ui/models";
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

export function renderBenchmarkResults(state: BenchmarkState): void {
	const container = byId("benchmark-results");
	const levels = PARAM_LEVELS;

	const cpuMap = new Map<BenchmarkResult["level"], BenchmarkResult>();
	const oclMap = new Map<BenchmarkResult["level"], BenchmarkResult>();
	const vkMap = new Map<BenchmarkResult["level"], BenchmarkResult>();
	for (const r of state.results) {
		const target = r.mode === "vulkan" ? vkMap : r.mode === "opencl" ? oclMap : cpuMap;
		target.set(r.level, r);
	}

	if (state.results.length === 0 && state.status !== "completed") {
		container.style.display = "none";
		return;
	}
	const showOcl = state.openclAvailable === true || oclMap.size > 0;
	const showVk = state.vulkanAvailable === true || vkMap.size > 0;

	const cell = (entry: BenchmarkResult | undefined, fps: number | null | undefined): string => {
		if (!entry) return `<td class="numeric cell-empty">N/A</td>`;
		if (entry.error) return `<td class="numeric cell-failed" title="${escapeHtml(entry.error)}">failed</td>`;
		if (fps === null || fps === undefined) return `<td class="numeric cell-empty">N/A</td>`;
		const speed = entry.speed ? ` <span class="cell-empty">(${escapeHtml(entry.speed)})</span>` : "";
		return `<td class="numeric">${fps.toFixed(2)}${speed}</td>`;
	};

	let oclSum = 0,
		oclCount = 0;
	let vkSum = 0,
		vkCount = 0;

	const rows = levels
		.map((level) => {
			const cpu = cpuMap.get(level);
			const ocl = oclMap.get(level);
			const vk = vkMap.get(level);
			const cpuFps = cpu && !cpu.error ? cpu.fps : null;
			const oclFps = ocl && !ocl.error ? ocl.fps : null;
			const vkFps = vk && !vk.error ? vk.fps : null;

			const oclSpeedup = cpuFps && oclFps ? oclFps / cpuFps : null;
			const vkSpeedup = cpuFps && vkFps ? vkFps / cpuFps : null;
			if (oclSpeedup !== null) {
				oclSum += oclSpeedup;
				oclCount++;
			}
			if (vkSpeedup !== null) {
				vkSum += vkSpeedup;
				vkCount++;
			}

			const best = vkSpeedup !== null && (oclSpeedup === null || vkSpeedup > oclSpeedup) ? vkSpeedup : oclSpeedup;
			const speedupCell = best !== null ? `<td class="numeric ${classifySpeedup(best)}">${best.toFixed(2)}x</td>` : `<td class="numeric cell-empty">N/A</td>`;

			return `<tr>
				<td class="level-cell">${level}</td>
				${cell(cpu, cpuFps)}
				${showOcl ? cell(ocl, oclFps) : ""}
				${showVk ? cell(vk, vkFps) : ""}
				${speedupCell}
			</tr>`;
		})
		.join("");

	const headers = [
		`<th>Level</th>`,
		`<th class="numeric">CPU fps</th>`,
		showOcl ? `<th class="numeric">OpenCL fps</th>` : "",
		showVk ? `<th class="numeric">Vulkan fps</th>` : "",
		`<th class="numeric">Best speedup</th>`,
	]
		.filter(Boolean)
		.join("");

	container.innerHTML = `<table>
		<thead><tr>${headers}</tr></thead>
		<tbody>${rows}</tbody>
	</table>`;

	if (state.status === "completed") {
		const oclAvg = oclCount > 0 ? oclSum / oclCount : null;
		const vkAvg = vkCount > 0 ? vkSum / vkCount : null;
		let recHtml = "";

		if (state.openclAvailable === false && state.vulkanAvailable === false) {
			recHtml = `<div class="benchmark-recommendation meh">No GPU backend available. Denoising will run on CPU.</div>`;
		} else if (vkAvg !== null && oclAvg !== null) {
			const winnerSpeed = Math.max(vkAvg, oclAvg);
			const cls = winnerSpeed >= 2 ? "good" : winnerSpeed >= 1.2 ? "meh" : "bad";
			recHtml = `<div class="benchmark-recommendation ${cls}">Vulkan ${vkAvg.toFixed(1)}x, OpenCL ${oclAvg.toFixed(1)}x vs CPU.</div>`;
		} else if (vkAvg !== null) {
			const cls = vkAvg >= 2 ? "good" : vkAvg >= 1.2 ? "meh" : "bad";
			recHtml = `<div class="benchmark-recommendation ${cls}">Vulkan is ${vkAvg.toFixed(1)}x faster than CPU.</div>`;
		} else if (oclAvg !== null) {
			const cls = oclAvg >= 2 ? "good" : oclAvg >= 1.2 ? "meh" : "bad";
			recHtml = `<div class="benchmark-recommendation ${cls}">OpenCL is ${oclAvg.toFixed(1)}x faster than CPU.</div>`;
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
	try {
		const result = await startBenchmarkRun();
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
