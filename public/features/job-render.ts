import type { AudioPreviewResult, AudioPreviewTrack, Job, JobStatus, JobStep, SubtitlePreviewResult, SubtitlePreviewTrack } from "../types";
import type { FolderStats, FolderTimeEstimate, FolderTreeNode } from "../ui/models";
import { authFetch, fetchJobs } from "../api/client";
import { API } from "../config/api-base";
import { sortNodeChildren } from "./queue-order";
import { byId } from "../shared/dom";
import { errorMessage } from "../shared/errors";
import { appState } from "../state";

export function statusLabel(status: JobStatus): string {
	const labels = {
		queued: "Queued",
		probing: "Analyzing",
		encoding_video: "Video",
		encoding_audio: "Audio",
		muxing: "Muxing",
		done: "Done",
		error: "Error",
		cancelled: "Cancelled",
	};
	return labels[status] || status;
}

export function isActive(status: JobStatus): boolean {
	return ["probing", "encoding_video", "encoding_audio", "muxing"].includes(status);
}

export function formatDuration(ms: number): string {
	const sec = Math.floor(ms / 1000);
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	const s = sec % 60;
	if (h > 0) return `${h}h ${m}m ${s}s`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

export function formatDurationShort(ms: number): string {
	const sec = Math.floor(ms / 1000);
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	const s = sec % 60;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

export function clampInt(v: number | string, min: number, max: number): number {
	const n = Math.round(Number(v));
	if (!Number.isFinite(n)) return min;
	return Math.max(min, Math.min(max, n));
}

export function forceOdd(n: number): number {
	return n % 2 === 0 ? n + 1 : n;
}

export function clampFloat(v: number | string, min: number, max: number): number {
	const n = Number(v);
	if (!Number.isFinite(n)) return min;
	return Math.max(min, Math.min(max, n));
}

export function computeStepElapsed(step: JobStep): number | null {
	if (!step.startedAt) return null;
	const end = step.finishedAt || Date.now();
	return end - step.startedAt;
}

export function computeStepETA(step: JobStep): number | null {
	if (!step.startedAt || step.status !== "active" || step.progress <= 0) return null;
	const elapsed = Date.now() - step.startedAt;
	if (elapsed < 3000) return null;
	const totalEstimated = (elapsed / step.progress) * 100;
	const remaining = totalEstimated - elapsed;
	return remaining > 0 ? remaining : null;
}

export function renderStepTime(step: JobStep): string {
	if (step.status === "done" && step.startedAt) {
		const elapsed = computeStepElapsed(step);
		return elapsed === null ? "" : `<span class="step-time step-time-done">${formatDurationShort(elapsed)}</span>`;
	}
	if (step.status === "active" && step.startedAt) {
		const elapsed = computeStepElapsed(step);
		const eta = computeStepETA(step);
		if (elapsed === null) return "";
		let timeStr = formatDurationShort(elapsed);
		if (eta !== null) {
			timeStr += ` · ~${formatDurationShort(eta)} left`;
		}
		return `<span class="step-time step-time-active">${timeStr}</span>`;
	}
	return "";
}

export async function openSubtitlePreview(jobId: string): Promise<void> {
	const jobs = await fetchJobs();
	const job = jobs.find((j) => j.id === jobId);
	if (!job) return;

	byId("sub-preview-title").textContent = `Subtitles — ${job.filename}`;
	byId("sub-preview-loading").style.display = "";
	byId("sub-preview-error").style.display = "none";
	byId("sub-preview-content").style.display = "none";
	byId("sub-preview-modal").style.display = "";

	try {
		const res = await authFetch(`${API}/api/jobs/${jobId}/subtitle-preview`);
		const data = await res.json();

		if (data.error) {
			byId("sub-preview-loading").style.display = "none";
			byId("sub-preview-error").textContent = data.error;
			byId("sub-preview-error").style.display = "";
			return;
		}

		renderSubtitlePreview(data);
	} catch (err) {
		byId("sub-preview-loading").style.display = "none";
		byId("sub-preview-error").textContent = `Failed: ${errorMessage(err)}`;
		byId("sub-preview-error").style.display = "";
	}
}

export async function openMediaInfo(jobId: string): Promise<void> {
	const jobs = await fetchJobs();
	const job = jobs.find((j) => j.id === jobId);
	if (!job) return;

	byId("mediainfo-title").textContent = `Media Info — ${job.filename}`;
	byId("mediainfo-loading").style.display = "";
	byId("mediainfo-error").style.display = "none";
	byId("mediainfo-content").style.display = "none";
	byId("mediainfo-modal").style.display = "";

	try {
		const res = await authFetch(`${API}/api/jobs/${jobId}/mediainfo`);
		const data = await res.json();
		byId("mediainfo-loading").style.display = "none";
		if (data.error) {
			const el = byId("mediainfo-error");
			el.textContent = data.error;
			el.style.display = "";
			return;
		}
		const pre = byId("mediainfo-content");
		pre.textContent = data.text;
		pre.style.display = "";
	} catch (err) {
		byId("mediainfo-loading").style.display = "none";
		const el = byId("mediainfo-error");
		el.textContent = `Failed: ${errorMessage(err)}`;
		el.style.display = "";
	}
}

export function closeMediaInfo() {
	byId("mediainfo-modal").style.display = "none";
}

export async function openAudioPreview(jobId: string): Promise<void> {
	const jobs = await fetchJobs();
	const job = jobs.find((j) => j.id === jobId);
	if (!job) return;

	byId("audio-preview-title").textContent = `Audio — ${job.filename}`;
	byId("audio-preview-loading").style.display = "";
	byId("audio-preview-error").style.display = "none";
	byId("audio-preview-content").style.display = "none";
	byId("audio-preview-modal").style.display = "";

	try {
		const res = await authFetch(`${API}/api/jobs/${jobId}/audio-preview`);
		const data = await res.json();

		if (data.error) {
			byId("audio-preview-loading").style.display = "none";
			byId("audio-preview-error").textContent = data.error;
			byId("audio-preview-error").style.display = "";
			return;
		}

		renderAudioPreview(data);
	} catch (err) {
		byId("audio-preview-loading").style.display = "none";
		byId("audio-preview-error").textContent = `Failed: ${errorMessage(err)}`;
		byId("audio-preview-error").style.display = "";
	}
}

export function renderAudioPreview(data: AudioPreviewResult): void {
	byId("audio-preview-loading").style.display = "none";
	byId("audio-preview-content").style.display = "";

	const outputIndices = new Set(data.output.map((t) => t.index));

	byId("audio-preview-source").innerHTML =
		data.source.length > 0
			? data.source.map((t) => renderAudioTrack(t, false, { removed: !outputIndices.has(t.index) })).join("")
			: '<div class="sub-track"><em>No audio tracks</em></div>';

	byId("audio-preview-output").innerHTML =
		data.output.length > 0
			? data.output
					.map((t) => {
						// Same source stream id on both sides — flag a channel-layout change (downmix).
						const src = data.source.find((s) => s.index === t.index);
						const changed = !!src && src.channelLayout !== t.channelLayout;
						return renderAudioTrack(t, true, { highlight: changed });
					})
					.join("")
			: '<div class="sub-track"><em>No audio tracks</em></div>';
}

export function formatBitrate(raw?: number | null): string {
	if (raw === undefined || raw === null) return "";
	// Probe may return bps or kbps - normalize.
	const kbps = raw >= 10000 ? Math.round(raw / 1000) : Math.round(raw);
	return `${kbps} kbps`;
}

export function formatBitrate2(kbps?: number | null): string {
	if (!kbps) return "—";

	if (kbps >= 1000) {
		return `${(kbps / 1000).toFixed(2)} Mbps`;
	}

	return `${kbps} kbps`;
}

export function renderAudioTrack(track: AudioPreviewTrack, isOutput: boolean, opts: { removed?: boolean; highlight?: boolean } = {}): string {
	const badges = [];
	if (opts.removed) badges.push('<span class="sub-badge sub-badge-removed">Removed</span>');
	if (track.isDefault) badges.push('<span class="sub-badge sub-badge-default">Default</span>');
	if (track.trackType === "commentary") badges.push('<span class="sub-badge sub-badge-commentary">Commentary</span>');
	if (track.trackType === "descriptive") badges.push('<span class="sub-badge sub-badge-hi">Descriptive</span>');
	if (track.trackType === "karaoke") badges.push('<span class="sub-badge sub-badge-type">Karaoke</span>');
	if (track.isOriginal) badges.push('<span class="sub-badge sub-badge-original">Original</span>');
	badges.push(`<span class="sub-badge sub-badge-type">${escapeHtml(track.channelLayout)}</span>`);

	const name = track.title || track.trackType;
	const bitrate = isOutput ? formatBitrate(track.outputBitrate === undefined ? undefined : track.outputBitrate * 1000) : formatBitrate(track.bitrate);

	const cls = ["sub-track"];
	if (opts.highlight) cls.push("sub-track-changed");
	if (opts.removed) cls.push("sub-track-removed");

	return `
		<div class="${cls.join(" ")}">
			<div class="sub-track-top">
				<span class="sub-track-id">#${track.index}</span>
				<span class="sub-track-flag">${track.flag}</span>
				<span class="sub-track-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
				<span class="sub-track-lang">${escapeHtml(track.language)}</span>
				<span class="sub-track-codec">${escapeHtml(track.codec)}${bitrate ? " · " + bitrate : ""}</span>
			</div>
			<div class="sub-track-badges">${badges.join("")}</div>
		</div>`;
}

export function closeAudioPreview() {
	byId("audio-preview-modal").style.display = "none";
}

export function closeAudioPreviewIfOutside(e: MouseEvent): void {
	if (e.target === e.currentTarget) closeAudioPreview();
}

export function renderSubtitlePreview(data: SubtitlePreviewResult): void {
	byId("sub-preview-loading").style.display = "none";
	byId("sub-preview-content").style.display = "";

	const outputIndices = new Set(data.output.map((t) => t.index));

	byId("sub-preview-source").innerHTML =
		data.source.length > 0
			? data.source.map((t) => renderSubTrack(t, { removed: !outputIndices.has(t.index) })).join("")
			: '<div class="sub-track"><em>No subtitle tracks</em></div>';

	byId("sub-preview-output").innerHTML =
		data.output.length > 0
			? data.output
					.map((t) => {
						// Same source stream id on both sides — flag a language relabel.
						const src = data.source.find((s) => s.index === t.index);
						const changed = !!src && src.language !== t.language;
						return renderSubTrack(t, { highlight: changed });
					})
					.join("")
			: '<div class="sub-track"><em>No subtitle tracks</em></div>';
}

export function renderSubTrack(track: SubtitlePreviewTrack, opts: { highlight?: boolean; removed?: boolean } = {}): string {
	const badges = [];
	if (opts.removed) badges.push('<span class="sub-badge sub-badge-removed">Removed</span>');
	if (track.isDefault) badges.push('<span class="sub-badge sub-badge-default">Default</span>');
	if (track.isForced) badges.push('<span class="sub-badge sub-badge-forced">Forced</span>');
	if (track.isHearingImpaired) badges.push('<span class="sub-badge sub-badge-hi">HI</span>');
	if (track.isCommentary) badges.push('<span class="sub-badge sub-badge-commentary">Commentary</span>');
	if (track.isOriginal) badges.push('<span class="sub-badge sub-badge-original">Original</span>');
	if (track.isTranslated) badges.push('<span class="sub-badge sub-badge-translated">Translated</span>');
	badges.push(`<span class="sub-badge sub-badge-type">${escapeHtml(track.trackType)}</span>`);

	const cls = ["sub-track"];
	if (opts.highlight) cls.push("sub-track-changed");
	if (opts.removed) cls.push("sub-track-removed");

	return `
    <div class="${cls.join(" ")}">
      <div class="sub-track-top">
        <span class="sub-track-id">${track.isTranslated ? "NEW" : "#" + track.index}</span>
        <span class="sub-track-flag">${track.flag}</span>
        <span class="sub-track-name" title="${escapeHtml(track.trackName)}">${escapeHtml(track.trackName)}</span>
        <span class="sub-track-lang">${escapeHtml(track.language)}</span>
        <span class="sub-track-codec">${escapeHtml(track.codec)}</span>
      </div>
      <div class="sub-track-badges">${badges.join("")}</div>
    </div>`;
}

export function closeSubPreview() {
	byId("sub-preview-modal").style.display = "none";
}

export function closeSubPreviewIfOutside(e: MouseEvent): void {
	if (e.target === e.currentTarget) closeSubPreview();
}

export function renderSteps(steps?: JobStep[]): string {
	if (!steps || steps.length === 0) return "";

	const stepsHtml = steps
		.map((step) => {
			const statusIcon = step.status === "done" ? "✓" : step.status === "active" ? "›" : step.status === "error" ? "✗" : "·";

			const statusClass = `step-${step.status}`;
			const pctStr = step.status === "active" ? `${step.progress.toFixed(2)}%` : step.status === "done" ? "100%" : "";

			const detail = step.detail && step.status === "active" ? `<span class="step-detail">${escapeHtml(step.detail)}</span>` : "";

			const timeHtml = renderStepTime(step);

			let progressBar = "";
			if (step.status === "active") {
				progressBar = `<div class="step-bar"><div class="step-bar-fill" style="width:${step.progress}%"></div></div>`;
			}

			return `
      <div class="step ${statusClass}">
        <div class="step-head">
          <span class="step-icon">${statusIcon}</span>
          <span class="step-label">${escapeHtml(step.label)}</span>
          <span class="step-pct">${pctStr}</span>
          ${timeHtml}
        </div>
        ${progressBar}
        ${detail}
      </div>`;
		})
		.join("");

	return `<div class="steps-pipeline">${stepsHtml}</div>`;
}

export function renderJobCard(job: Job): string {
	const active = isActive(job.status);
	const done = job.status === "done";
	const err = job.status === "error";

	let meta = "";
	if (job.probe) {
		meta += `<span>${job.probe.width}x${job.probe.height}</span>`;
		meta += `<span>${job.probe.audioLayout}</span>`;
		if (job.probe.isHDR) meta += `<span>HDR</span>`;
		if (job.probe.duration) meta += `<span>${formatDuration(job.probe.duration * 1000)}</span>`;
	}
	if (job.settings.videoEncode !== "off")
		meta += `<span>${job.settings.quality} · ${job.settings.finalSpeed}${job.settings.downscale ? " · ↓1080p" : ""}</span>`;
	if (job.settings.skipBoosting) meta += `<span>No Boost</span>`;
	if (job.settings.videoEncode === "off") meta += `<span>No AV1</span>`;
	if (job.settings.audioEncode === "copy") meta += `<span>No Opus</span>`;
	if (job.settings.subtitleProcessing === "copy") meta += `<span>Subs: copy</span>`;

	const stepsHtml = active || done || err ? renderSteps(job.steps) : "";

	let result = "";
	if (done) {
		const elapsed = job.finishedAt && job.startedAt ? formatDuration(job.finishedAt - job.startedAt) : "—";
		result = `
      <div class="job-result">
        <span>Size: ${job.encodedFileSize || "—"}</span>
        <span>Time: ${elapsed}</span>
        <span>Output: ${job.outputFilename || "—"}</span>
      </div>`;
	}

	let error = "";
	if (err && job.error) {
		error = `<div class="job-error">${escapeHtml(job.error)}</div>`;
	}

	const infoBtn = `<button class="btn-icon" title="Media info" data-id="${job.id}" data-action="mediainfo">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
    </svg>
	</button>`;

	const audioBtn = `<button class="btn-icon" title="Preview Audio" data-id="${job.id}" data-action="audio-preview">
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
			<path d="M3 18v-6a9 9 0 0 1 18 0v6"/>
			<path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>
		</svg>
	</button>`;

	const subBtn = `<button class="btn-icon" title="Preview Subtitles" data-id="${job.id}" data-action="sub-preview">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
  </button>`;

	const previewBtn = `<button class="btn-icon" title="Preview Encode" data-id="${job.id}" data-action="preview">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polygon points="5 3 19 12 5 21 5 3"/>
    </svg>
  </button>`;

	const bitrateBtn = `<button class="btn-icon" title="Bitrate Analysis" data-id="${job.id}" data-action="bitrate">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
    </svg>
  </button>`;

	let actions = "";
	if (job.status === "queued") {
		actions = `
      <div class="move-buttons" data-move-type="file" data-move-job="${job.id}">
        <button class="btn-icon btn-move" title="Move up" data-action="move-up">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>
        </button>
        <button class="btn-icon btn-move" title="Move down" data-action="move-down">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
      </div>
			${infoBtn}
			${audioBtn}
			${subBtn}
			${previewBtn}
			${bitrateBtn}
      <button class="btn-icon" title="Settings" data-id="${job.id}" data-action="edit">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
      </button>
      <button class="btn-icon" title="Remove" data-id="${job.id}" data-action="remove">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>`;
	} else if (active) {
		actions = `
			${infoBtn}
			${audioBtn}
			${subBtn}
			${previewBtn}
			${bitrateBtn}
      <button class="btn-icon btn-cancel" title="Cancel" data-id="${job.id}" data-action="cancel">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>
      </button>`;
	} else if (err) {
		actions = `
			${infoBtn}
			${audioBtn}
			${subBtn}
			${previewBtn}
			${bitrateBtn}
      <button class="btn-icon" title="Retry" data-id="${job.id}" data-action="retry">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
      </button>
      <button class="btn-icon" title="Remove" data-id="${job.id}" data-action="remove">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>`;
	} else if (done) {
		actions = `
			${bitrateBtn}
      <button class="btn-icon" title="Dismiss" data-id="${job.id}" data-action="dismiss">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
      </button>`;
	}

	return `
    <div class="job-card ${active ? "is-active" : ""} ${done ? "is-done" : ""}" id="job-${job.id}">
      <div class="job-top">
        <div class="job-info">
          <div class="job-filename" title="${escapeHtml(job.filename)}">${escapeHtml(job.filename)}</div>
          <div class="job-meta">${meta}</div>
        </div>
        <div class="job-actions">
          <span class="status-badge status-${job.status}">${statusLabel(job.status)}</span>
          ${actions}
        </div>
      </div>
      ${stepsHtml}
      ${result}
      ${error}
    </div>`;
}

export function buildFolderTree(jobs: Job[]): FolderTreeNode {
	const root: FolderTreeNode = { name: "", fullPath: "", children: new Map<string, FolderTreeNode>(), jobs: [] };

	for (const job of jobs) {
		let parts: string[] = [];

		if (job.replaceSource && job.inputPath) {
			// Library job: derive full folder hierarchy from inputPath
			const lastSlash = job.inputPath.lastIndexOf("/");
			const dir = lastSlash > 0 ? job.inputPath.substring(1, lastSlash) : "";
			parts = dir ? dir.split("/") : [];
		} else {
			// Regular job: use relativePath
			const rel = job.relativePath || "";
			parts = rel ? rel.split(/[/\\]/) : [];
		}

		if (parts.length === 0) {
			root.jobs.push(job);
			continue;
		}

		let current = root;
		let pathSoFar = "";

		for (const part of parts) {
			pathSoFar = pathSoFar ? `${pathSoFar}/${part}` : part;
			if (!current.children.has(part)) {
				current.children.set(part, {
					name: part,
					fullPath: pathSoFar,
					children: new Map(),
					jobs: [],
				});
			}
			current = current.children.get(part)!;
		}

		current.jobs.push(job);
	}

	return root;
}

export function collectAllJobs(node: FolderTreeNode): Job[] {
	let all = [...node.jobs];
	for (const child of node.children.values()) {
		all = all.concat(collectAllJobs(child));
	}
	return all;
}

export function computeFolderStats(node: FolderTreeNode): FolderStats {
	const allJobs = collectAllJobs(node);
	const total = allJobs.length;
	const done = allJobs.filter((j) => j.status === "done").length;
	const encoding = allJobs.filter((j) => isActive(j.status)).length;
	const queued = allJobs.filter((j) => j.status === "queued").length;
	const error = allJobs.filter((j) => j.status === "error").length;
	return { total, done, encoding, queued, error };
}

export function folderHasActive(node: FolderTreeNode): boolean {
	return collectAllJobs(node).some((j) => isActive(j.status));
}

export function computeFolderTimeEstimate(node: FolderTreeNode): FolderTimeEstimate | null {
	const allJobs = collectAllJobs(node);

	const doneJobs = allJobs.filter(
		(j): j is Job & { startedAt: number; finishedAt: number } => j.status === "done" && typeof j.startedAt === "number" && typeof j.finishedAt === "number",
	);
	const activeJobs = allJobs.filter((j) => isActive(j.status));
	const queuedJobs = allJobs.filter((j) => j.status === "queued");

	if (doneJobs.length === 0 && activeJobs.length === 0) return null;

	// Total elapsed time for completed jobs
	const totalElapsed = doneJobs.reduce((sum, j) => sum + (j.finishedAt - j.startedAt), 0);

	// Average encode time per episode
	const avgPerEpisode = doneJobs.length > 0 ? totalElapsed / doneJobs.length : null;

	// Try duration-weighted estimation
	let useDurationWeighted = false;
	let encodeRatio: number | null = null;

	const doneWithDuration = doneJobs.filter(
		(j): j is Job & { startedAt: number; finishedAt: number; probe: NonNullable<Job["probe"]> } => !!j.probe && j.probe.duration > 0,
	);
	if (doneWithDuration.length > 0) {
		const totalEncode = doneWithDuration.reduce((sum, j) => sum + (j.finishedAt - j.startedAt), 0);
		const totalDuration = doneWithDuration.reduce((sum, j) => sum + j.probe.duration * 1000, 0);
		encodeRatio = totalEncode / totalDuration;
		useDurationWeighted = true;
	}

	// Estimate remaining time for queued jobs
	let queuedEstimate = 0;
	if (queuedJobs.length > 0) {
		if (encodeRatio !== null) {
			const queuedWithDuration = queuedJobs.filter((j): j is Job & { probe: NonNullable<Job["probe"]> } => !!j.probe && j.probe.duration > 0);
			const queuedWithoutDuration = queuedJobs.length - queuedWithDuration.length;
			queuedEstimate += queuedWithDuration.reduce((sum, j) => sum + j.probe.duration * 1000 * encodeRatio, 0);
			if (queuedWithoutDuration > 0 && avgPerEpisode) {
				queuedEstimate += queuedWithoutDuration * avgPerEpisode;
			}
		} else if (avgPerEpisode) {
			queuedEstimate = queuedJobs.length * avgPerEpisode;
		}
	}

	// Estimate remaining time for active jobs
	let activeRemaining = 0;
	for (const job of activeJobs) {
		if (job.startedAt && job.progress > 0) {
			const elapsed = Date.now() - job.startedAt;
			if (elapsed > 3000) {
				const totalEstimated = (elapsed / job.progress) * 100;
				const remaining = totalEstimated - elapsed;
				activeRemaining += Math.max(0, remaining);
			}
		} else if (avgPerEpisode) {
			activeRemaining += avgPerEpisode;
		} else if (encodeRatio !== null && job.probe && job.probe.duration > 0) {
			activeRemaining += job.probe.duration * 1000 * encodeRatio;
		}
	}

	let activeElapsed = 0;
	for (const job of activeJobs) {
		if (job.startedAt) {
			activeElapsed += Date.now() - job.startedAt;
		}
	}

	const estimatedRemaining = activeRemaining + queuedEstimate;
	const estimatedTotal = totalElapsed + activeElapsed + estimatedRemaining;
	const remainingCount = activeJobs.length + queuedJobs.length;

	return {
		totalElapsed,
		estimatedRemaining,
		estimatedTotal,
		avgPerEpisode,
		doneCount: doneJobs.length,
		remainingCount,
	};
}

export function renderFolderTimeEstimate(node: FolderTreeNode): string {
	const est = computeFolderTimeEstimate(node);
	if (!est) {
		return `<div class="folder-time-estimate folder-time-pending">Estimated after 1st encode</div>`;
	}

	const parts = [];

	if (est.remainingCount > 0 && est.doneCount > 0) {
		// Still encoding (show estimated total and remaining)
		parts.push(`~${formatDurationShort(est.estimatedTotal)} total`);
		parts.push(`~${formatDurationShort(est.estimatedRemaining)} remaining`);
	} else if (est.remainingCount === 0 && est.doneCount > 0) {
		// All done (show actual total time)
		parts.push(`Total: ${formatDurationShort(est.totalElapsed)}`);
	}

	if (est.avgPerEpisode && est.doneCount > 0) {
		parts.push(`${formatDurationShort(est.avgPerEpisode)} avg/ep`);
	}

	if (parts.length === 0) return `<div class="folder-time-estimate folder-time-pending">Estimated after 1st encode</div>`;

	return `<div class="folder-time-estimate">${parts.join(" · ")}</div>`;
}

export function renderFolderStats(stats: FolderStats): string {
	const parts = [];

	parts.push(`<span class="folder-stat folder-stat-total">${stats.total} file${stats.total !== 1 ? "s" : ""}</span>`);

	if (stats.encoding > 0) {
		parts.push(`<span class="folder-stat folder-stat-encoding">${stats.encoding} encoding</span>`);
	}
	if (stats.queued > 0) {
		parts.push(`<span class="folder-stat folder-stat-queued">${stats.queued} queued</span>`);
	}
	if (stats.done > 0) {
		parts.push(`<span class="folder-stat folder-stat-done">${stats.done} done</span>`);
	}
	if (stats.error > 0) {
		parts.push(`<span class="folder-stat folder-stat-error">${stats.error} error</span>`);
	}

	return parts.join("");
}

export function renderFolderProgress(stats: FolderStats): string {
	if (stats.total === 0) return "";
	const pct = Math.round((stats.done / stats.total) * 100);
	return `<div class="folder-progress"><div class="folder-progress-fill" style="width:${pct}%"></div></div>`;
}

export function renderFolderNode(node: FolderTreeNode, depth: number): string {
	const isExpanded = appState.expandedFolders.has(node.fullPath);
	const stats = computeFolderStats(node);
	const hasActive = folderHasActive(node);
	const allDone = stats.total > 0 && stats.done === stats.total;

	const chevronSvg = `<svg class="folder-chevron ${isExpanded ? "expanded" : ""}" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>`;

	const folderIconSvg = `<svg class="folder-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;

	let html = `
    <div class="folder-node ${hasActive ? "folder-active" : ""} ${allDone ? "folder-done" : ""}" style="--depth:${depth}">
      <div class="folder-header" data-folder-path="${escapeHtml(node.fullPath)}">
				<div class="folder-left">
					${chevronSvg}
					${folderIconSvg}
					<span class="folder-name">${escapeHtml(node.name)}</span>
					<div class="move-buttons" data-move-type="folder" data-move-path="${escapeHtml(node.fullPath)}">
						<button class="btn-icon btn-move" title="Move up" data-action="move-up">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>
						</button>
						<button class="btn-icon btn-move" title="Move down" data-action="move-down">
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
						</button>
					</div>
				</div>
        <div class="folder-right">
          <div class="folder-stats">${renderFolderStats(stats)}</div>
          ${renderFolderProgress(stats)}
          ${renderFolderTimeEstimate(node)}
        </div>
      </div>`;

	if (isExpanded) {
		html += `<div class="folder-children">`;

		const sortedChildren = sortNodeChildren(Array.from(node.children.values()));
		for (const child of sortedChildren) {
			html += renderFolderNode(child, depth + 1);
		}

		const sortedJobs = [...node.jobs].sort((a, b) => a.queueOrder - b.queueOrder);
		for (const job of sortedJobs) {
			html += `<div class="folder-job" style="--depth:${depth + 1}" data-containing-folder="${escapeHtml(node.fullPath)}">${renderJobCard(job)}</div>`;
		}

		html += `</div>`;
	}

	html += `</div>`;
	return html;
}

export function renderJobsList(jobs: Job[]): string {
	const tree = buildFolderTree(jobs);
	let html = "";

	const sortedFolders = sortNodeChildren(Array.from(tree.children.values()));
	for (const folder of sortedFolders) {
		html += renderFolderNode(folder, 0);
	}

	for (const job of tree.jobs) {
		html += renderJobCard(job);
	}

	return html;
}

export function escapeHtml(s: unknown): string {
	const d = document.createElement("div");
	d.textContent = String(s);
	return d.innerHTML;
}
