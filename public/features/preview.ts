import type { PreviewSample, PreviewState } from "../types";
import type { PreviewArtifactKind, PreviewSampleCard, PreviewSampleView } from "../ui/models";
import { authFetch, cancelPreviewRequest, fetchJobs, fetchPreviewState, startPreviewRequest } from "../api/client";
import { API } from "../config/api-base";
import { escapeHtml, formatBitrate2 } from "./job-render";
import { previewSettingsFingerprintFE } from "./library-search";
import { buttonById, byId, inputById } from "../shared/dom";
import { errorMessage } from "../shared/errors";
import { appState } from "../state";
import { humanFileSize } from "./library";

export async function fetchPreviewArtifactBlob(jobId: string, idx: number, kind: PreviewArtifactKind): Promise<string> {
	const cacheKey = `${jobId}:${idx}:${kind}`;
	const cached = appState.previewBlobCache.get(cacheKey);
	if (cached) return cached;
	const res = await authFetch(`${API}/api/jobs/${jobId}/preview/sample/${idx}/${kind}`);
	if (!res.ok) throw new Error(`Failed to load ${kind} (${res.status})`);
	const blob = await res.blob();
	const url = URL.createObjectURL(blob);
	appState.previewBlobCache.set(cacheKey, url);
	return url;
}

export function clearPreviewBlobCache() {
	for (const url of appState.previewBlobCache.values()) URL.revokeObjectURL(url);
	appState.previewBlobCache.clear();
}

export async function openPreviewModal(jobId: string): Promise<void> {
	appState.currentPreviewJobId = jobId;
	clearPreviewBlobCache();

	const jobsList = await fetchJobs();
	const job = jobsList.find((j) => j.id === jobId);
	if (!job) return;

	appState.currentPreviewSettingsFingerprint = previewSettingsFingerprintFE(job.settings);

	byId("preview-modal-title").textContent = `Preview Encode: ${job.filename}`;
	byId("preview-modal").style.display = "";

	await refreshPreviewModal();
}

export function closePreviewModal() {
	byId("preview-modal").style.display = "none";
	stopPreviewPolling();
	appState.currentPreviewJobId = null;
	clearPreviewBlobCache();
}

export function closePreviewModalIfOutside(e: MouseEvent): void {
	if (e.target === e.currentTarget) closePreviewModal();
}

export function startPreviewPolling() {
	stopPreviewPolling();
	appState.previewPollTimer = setInterval(refreshPreviewModal, 1000);
}

export function stopPreviewPolling() {
	if (appState.previewPollTimer) clearInterval(appState.previewPollTimer);
	appState.previewPollTimer = null;
}

export async function refreshPreviewModal() {
	if (!appState.currentPreviewJobId) return;
	try {
		const state = await fetchPreviewState(appState.currentPreviewJobId);
		renderPreviewState(state);
		if (state.status !== "running") stopPreviewPolling();
	} catch (e) {
		if (errorMessage(e) !== "Unauthorized") console.error("Preview poll error:", e);
	}
}

export function initPreviewOptionControls() {
	const countEl = inputById("preview-clip-count");
	const durationEl = inputById("preview-clip-duration");
	const countVal = byId("preview-clip-count-val");
	const durationVal = byId("preview-clip-duration-val");

	const syncCount = () => (countVal.textContent = `(${countEl.value})`);
	const syncDuration = () => (durationVal.textContent = `(${durationEl.value}s)`);

	countEl.oninput = syncCount;
	durationEl.oninput = syncDuration;
	syncCount();
	syncDuration();
}

export function renderPreviewSummary(samples: PreviewSample[]): void {
	const el = byId("preview-summary");
	if (!samples.length) {
		el.style.display = "none";
		return;
	}

	const count = samples.length;
	const projections = samples.map((s) => s.projectedTotalBytes || 0);
	const avgProjected = projections.reduce((a, b) => a + b, 0) / count;
	const minProjected = Math.min(...projections);
	const maxProjected = Math.max(...projections);

	const totalSampledSec = samples.reduce((a, s) => a + (s.windowSeconds || 0), 0);
	const avgBitrateKbps = count > 0 ? samples.reduce((a, s) => a + (s.encodedBitrateKbps || 0), 0) / count : 0;

	el.style.display = "";
	el.innerHTML = `
		<div class="preview-summary-headline">
			<span class="preview-summary-label">Estimated final size</span>
			<span class="preview-summary-value">~${humanFileSize(avgProjected)}</span>
		</div>
		<div class="preview-summary-grid">
			<div class="preview-summary-row">
				<span class="meta-label">Likely range</span>
				<span class="meta-value">${humanFileSize(minProjected)} to ${humanFileSize(maxProjected)}</span>
			</div>
			<div class="preview-summary-row">
				<span class="meta-label">Avg bitrate</span>
				<span class="meta-value">${formatBitrate2(Math.round(avgBitrateKbps))}</span>
			</div>
			<div class="preview-summary-row">
				<span class="meta-label">Based on</span>
				<span class="meta-value">${count} clip${count === 1 ? "" : "s"}, ${totalSampledSec}s sampled</span>
			</div>
		</div>`;
}

export function renderPreviewState(state: PreviewState): void {
	const introEl = byId("preview-intro");
	const optionsEl = byId("preview-options");
	const statusEl = byId("preview-status");
	const errorEl = byId("preview-error");
	const samplesEl = byId("preview-samples");
	const staleEl = byId("preview-stale-banner");
	const runBtn = buttonById("preview-run-btn");
	const cancelBtn = buttonById("preview-cancel-btn");
	const clearBtn = byId("preview-clear-btn");

	const status = state?.status || "idle";
	const isRunning = status === "running";
	const hasResults = (state?.samples?.length || 0) > 0;
	const isFinished = status === "done" || status === "error" || status === "cancelled";

	const stale = state?.settingsFingerprint && state.settingsFingerprint !== appState.currentPreviewSettingsFingerprint;
	staleEl.style.display = stale && hasResults ? "" : "none";

	introEl.style.display = status === "idle" ? "" : "none";
	optionsEl.style.display = isRunning ? "none" : "";

	if (isRunning) {
		statusEl.style.display = "";
		const pct = (state.progress || 0).toFixed(1);
		byId("preview-status-label").textContent = state.currentDetail || "Encoding...";
		byId("preview-status-pct").textContent = `${pct}%`;
		byId("preview-progress-fill").style.width = `${pct}%`;
		byId("preview-status-detail").textContent = `${state.samples?.length || 0} of ${state.sampleCount} samples done`;
	} else {
		statusEl.style.display = "none";
	}

	if (status === "error" && state.error) {
		errorEl.textContent = state.error;
		errorEl.style.display = "";
	} else {
		errorEl.style.display = "none";
	}

	if (hasResults) {
		samplesEl.style.display = "";
		renderPreviewSamples(state.jobId, state.samples);
	} else {
		samplesEl.style.display = "none";
	}
	renderPreviewSummary(state.samples || []);

	runBtn.disabled = isRunning;
	runBtn.textContent = isFinished || hasResults ? "Re-run Preview" : "Run Preview";
	runBtn.style.display = isRunning ? "none" : "";
	cancelBtn.style.display = isRunning ? "" : "none";
	clearBtn.style.display = !isRunning && hasResults ? "" : "none";
}

export function buildPreviewSampleViews(sample: PreviewSample): PreviewSampleView[] {
	const views: PreviewSampleView[] = [{ id: "source", label: "Source", role: "source" }];
	for (const f of sample.vsFrames || []) {
		views.push({
			id: `vs:${f.index}`,
			label: f.label || `VS step ${f.index + 1}`,
			role: "vs",
		});
	}
	for (const f of sample.prepareFrames || []) {
		views.push({
			id: `pf:${f.kind}`,
			label: f.label || f.kind,
			role: "prepare",
		});
	}
	views.push({ id: "encode", label: "Encode", role: "encode" });
	return views;
}

export function renderPreviewSamples(jobId: string, samples: PreviewSample[]): void {
	const container = byId("preview-samples");

	const desiredKey = samples.map((s) => `${s.index}:${(s.vsFrames || []).length}:${(s.prepareFrames || []).length}`).join(",");
	if (container.dataset.renderedKey === desiredKey) return;
	container.dataset.renderedKey = desiredKey;
	container.innerHTML = "";

	for (const sample of samples) {
		const card = document.createElement("div") as PreviewSampleCard;
		card.className = "preview-sample";
		card.dataset.idx = String(sample.index);

		const views = buildPreviewSampleViews(sample);
		card._views = views;
		card._viewIdx = 0;

		const ts = formatTimestamp(sample.timestampSec);
		const projected = sample.projectedTotalHuman || "N/A";
		const sizeStr = sample.encodedSizeHuman || "N/A";
		const bitrate = formatBitrate2(sample.encodedBitrateKbps);

		const hint = views.length > 2 ? `Click to cycle through ${views.length} views` : "Click to toggle";

		card.innerHTML = `
			<div class="preview-sample-image" data-action="toggle">
				<div class="preview-img-loading">Loading...</div>
				<img alt="Preview sample ${sample.index + 1}" style="display: none">
				<span class="preview-sample-tag is-source">Source</span>
				<button class="preview-fullscreen-btn" type="button" title="View fullscreen" aria-label="View preview sample fullscreen" data-action="fullscreen">
					<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>
				</button>
				<span class="preview-sample-hint">${hint}</span>
			</div>
			<div class="preview-sample-meta">
				<div class="preview-sample-meta-row">
					<span class="meta-label">Sample ${sample.index + 1}, ${ts}</span>
					<span class="meta-value">${bitrate}</span>
				</div>
				<div class="preview-sample-meta-row">
					<span class="meta-label">Clip size</span>
					<span class="meta-value">${escapeHtml(sizeStr)}</span>
				</div>
				<div class="preview-sample-meta-row">
					<span class="meta-label">Projected total</span>
					<span class="meta-value">${escapeHtml(projected)}</span>
				</div>
				<div class="preview-sample-actions">
					<button class="btn btn-ghost" data-dl="source">PNG (S)</button>
					<button class="btn btn-ghost" data-dl="encode">PNG (E)</button>
					<button class="btn btn-ghost" data-dl="source-clip">MKV (S)</button>
					<button class="btn btn-ghost" data-dl="clip">MKV (E)</button>
				</div>
			</div>`;

		container.appendChild(card);

		(async () => {
			try {
				// Show source immediately.
				const sourceUrl = await fetchPreviewArtifactBlob(jobId, sample.index, "source");
				const img = card.querySelector<HTMLImageElement>("img")!;
				img.src = sourceUrl;
				img.style.display = "";
				card.querySelector<HTMLElement>(".preview-img-loading")!.style.display = "none";

				// Warm-cache every other view so cycling/arrow keys are instant.
				for (const v of views) {
					if (v.id === "source") continue;
					fetchPreviewArtifactBlob(jobId, sample.index, v.id).catch(() => {
						// Per-view fetch can fail, just ignore.
					});
				}
			} catch (e) {
				card.querySelector<HTMLElement>(".preview-img-loading")!.textContent = `Failed to load: ${errorMessage(e)}`;
			}
		})();
	}
}

export function formatTimestamp(sec: number): string {
	const total = Math.floor(sec);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (n: number) => String(n).padStart(2, "0");
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export async function setPreviewSampleViewByIdx(card: PreviewSampleCard, idx: number): Promise<void> {
	const jobId = appState.currentPreviewJobId;
	const sampleIdx = parseInt(card.dataset.idx!, 10);
	if (!jobId || !Number.isFinite(sampleIdx)) return;

	const views = card._views || [];
	if (views.length === 0) return;
	const wrapped = ((idx % views.length) + views.length) % views.length;
	const view = views[wrapped]!;

	try {
		const url = await fetchPreviewArtifactBlob(jobId, sampleIdx, view.id);
		const img = card.querySelector("img");
		if (img) img.src = url;
		card._viewIdx = wrapped;
		card.dataset.viewing = view.id;

		const tag = card.querySelector(".preview-sample-tag");
		if (tag) {
			tag.textContent = view.label;
			tag.classList.toggle("is-source", view.role === "source");
			tag.classList.toggle("is-encode", view.role === "encode");
			tag.classList.toggle("is-vs", view.role === "vs");
			tag.classList.toggle("is-prepare", view.role === "prepare");
		}

		if (appState.currentPreviewFullscreenCard === card) {
			const fsImg = byId<HTMLImageElement>("preview-fullscreen-img");
			const fsTag = byId("preview-fullscreen-tag");
			if (fsImg) fsImg.src = url;
			if (fsTag) {
				fsTag.textContent = view.label;
				fsTag.classList.toggle("is-source", view.role === "source");
				fsTag.classList.toggle("is-encode", view.role === "encode");
				fsTag.classList.toggle("is-vs", view.role === "vs");
				fsTag.classList.toggle("is-prepare", view.role === "prepare");
			}
		}
	} catch (e) {
		console.error("Preview image switch failed:", e);
	}
}

export function cyclePreviewSampleView(card: PreviewSampleCard, direction: number): Promise<void> | undefined {
	const views = card._views || [];
	if (views.length === 0) return;
	const cur = typeof card._viewIdx === "number" ? card._viewIdx : 0;
	return setPreviewSampleViewByIdx(card, cur + direction);
}

export async function togglePreviewSampleView(card: PreviewSampleCard): Promise<void> {
	await cyclePreviewSampleView(card, +1);
}

export async function openPreviewFullscreen(card: PreviewSampleCard | null): Promise<void> {
	if (!card) return;
	appState.currentPreviewFullscreenCard = card;
	const idx = parseInt(card.dataset.idx!, 10);
	const views = card._views || [];
	const cur = typeof card._viewIdx === "number" ? card._viewIdx : 0;
	const view = views[cur] || { id: "source", label: "Source", role: "source" };

	const modal = byId("preview-fullscreen-modal");
	const title = byId("preview-fullscreen-title");
	const img = byId<HTMLImageElement>("preview-fullscreen-img");
	const loading = byId("preview-fullscreen-loading");

	if (!modal || !title || !img || !loading) return;

	title.textContent = `Preview sample ${idx + 1}`;
	img.style.display = "none";
	loading.style.display = "";
	loading.textContent = "Loading...";
	modal.style.display = "";

	try {
		const url = await fetchPreviewArtifactBlob(appState.currentPreviewJobId!, idx, view.id);
		img.src = url;
		img.style.display = "";
		loading.style.display = "none";
		await setPreviewSampleViewByIdx(card, cur);
	} catch (e) {
		loading.textContent = `Failed to load: ${errorMessage(e)}`;
	}
}

export function closePreviewFullscreen() {
	const modal = byId("preview-fullscreen-modal");
	if (modal) modal.style.display = "none";
	appState.currentPreviewFullscreenCard = null;
}

export function closePreviewFullscreenIfOutside(e: MouseEvent): void {
	if (e.target === e.currentTarget) closePreviewFullscreen();
}

export async function downloadPreviewSampleArtifact(jobId: string, idx: number, kind: PreviewArtifactKind): Promise<void> {
	try {
		const url = await fetchPreviewArtifactBlob(jobId, idx, kind);
		const a = document.createElement("a");
		a.href = url;
		const isClip = kind === "clip" || kind === "source-clip";
		const ext = isClip ? "mkv" : "png";
		const role = isClip ? kind : `${kind}-frame`;
		a.download = `preview-${role}-sample${idx + 1}.${ext}`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
	} catch (e) {
		console.error("Download failed:", e);
	}
}

export async function handlePreviewRun() {
	if (!appState.currentPreviewJobId) return;
	const runBtn = buttonById("preview-run-btn");
	runBtn.disabled = true;
	runBtn.textContent = "Starting...";
	clearPreviewBlobCache();
	const samplesEl = byId("preview-samples");
	if (samplesEl) samplesEl.dataset.renderedKey = "";

	const clamp = (raw: string, def: number, min: number, max: number) => {
		const n = Math.round(Number(raw));
		if (!Number.isFinite(n)) return def;
		return Math.min(max, Math.max(min, n));
	};
	const clipCount = clamp(inputById("preview-clip-count").value, 6, 1, 20);
	const clipDuration = clamp(inputById("preview-clip-duration").value, 5, 1, 30);

	try {
		const result = await startPreviewRequest(appState.currentPreviewJobId, { clipCount, clipDuration });
		if (result.error) {
			byId("preview-error").textContent = result.error;
			byId("preview-error").style.display = "";
			runBtn.disabled = false;
			runBtn.textContent = "Run Preview";
			return;
		}
		renderPreviewState(result);
		startPreviewPolling();
	} catch (e) {
		byId("preview-error").textContent = `Failed to start: ${errorMessage(e)}`;
		byId("preview-error").style.display = "";
		runBtn.disabled = false;
		runBtn.textContent = "Run Preview";
	}
}

export async function handlePreviewCancel() {
	if (!appState.currentPreviewJobId) return;
	const cancelBtn = buttonById("preview-cancel-btn");
	cancelBtn.disabled = true;
	try {
		await cancelPreviewRequest(appState.currentPreviewJobId);
		await refreshPreviewModal();
	} catch (e) {
		console.error("Cancel failed:", e);
	} finally {
		cancelBtn.disabled = false;
	}
}

export async function handlePreviewClear() {
	if (!appState.currentPreviewJobId) return;
	try {
		await cancelPreviewRequest(appState.currentPreviewJobId);
		clearPreviewBlobCache();
		const samplesEl = byId("preview-samples");
		samplesEl.dataset.renderedKey = "";
		await refreshPreviewModal();
	} catch (e) {
		console.error("Clear failed:", e);
	}
}
