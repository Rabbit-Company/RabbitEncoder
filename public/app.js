const API = "";
let defaults = null;
let currentEditJobId = null;

const QUALITIES = ["low", "medium", "high"];
const SPEEDS = ["slower", "slow", "medium", "fast", "faster"];
const CHANNELS = [
	{ key: "mono", label: "Mono" },
	{ key: "stereo", label: "Stereo" },
	{ key: "2.1", label: "2.1" },
	{ key: "5.1", label: "5.1" },
	{ key: "6.1", label: "6.1" },
	{ key: "7.1", label: "7.1" },
	{ key: "7.1.4", label: "7.1.4 Atmos" },
];

async function fetchJobs() {
	const res = await fetch(`${API}/api/jobs`);
	return res.json();
}

async function fetchConfig() {
	const res = await fetch(`${API}/api/config`);
	return res.json();
}

async function patchJob(id, settings) {
	const res = await fetch(`${API}/api/jobs/${id}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(settings),
	});
	return res.json();
}

async function deleteJob(id) {
	await fetch(`${API}/api/jobs/${id}`, { method: "DELETE" });
}

async function retryJob(id) {
	await fetch(`${API}/api/jobs/${id}/retry`, { method: "POST" });
}

function renderRadioPills(container, options, selected, onChange) {
	container.innerHTML = "";
	options.forEach((opt) => {
		const pill = document.createElement("div");
		pill.className = `radio-pill${opt === selected ? " selected" : ""}`;
		pill.textContent = opt;
		pill.onclick = () => {
			container.querySelectorAll(".radio-pill").forEach((p) => p.classList.remove("selected"));
			pill.classList.add("selected");
			onChange(opt);
		};
		container.appendChild(pill);
	});
}

function renderBitrateInputs(container, bitrates, onChange) {
	container.innerHTML = "";
	CHANNELS.forEach((ch) => {
		const field = document.createElement("div");
		field.className = "bitrate-field";
		field.innerHTML = `
      <span>${ch.label}</span>
      <input type="number" min="32" max="1024" step="16" value="${bitrates[ch.key] || 128}" data-ch="${ch.key}">
    `;
		field.querySelector("input").oninput = (e) => {
			onChange(ch.key, parseInt(e.target.value) || 128);
		};
		container.appendChild(field);
	});
}

function statusLabel(status) {
	const labels = {
		queued: "Queued",
		probing: "Analyzing",
		encoding_video: "Video",
		encoding_audio: "Audio",
		muxing: "Muxing",
		done: "Done",
		error: "Error",
	};
	return labels[status] || status;
}

function isActive(status) {
	return ["probing", "encoding_video", "encoding_audio", "muxing"].includes(status);
}

function formatDuration(ms) {
	const sec = Math.floor(ms / 1000);
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	const s = sec % 60;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

function renderSteps(steps) {
	if (!steps || steps.length === 0) return "";

	const stepsHtml = steps
		.map((step) => {
			const statusIcon = step.status === "done" ? "✓" : step.status === "active" ? "›" : step.status === "error" ? "✗" : "·";

			const statusClass = `step-${step.status}`;
			const pctStr = step.status === "active" ? `${step.progress.toFixed(2)}%` : step.status === "done" ? "100%" : "";

			const detail = step.detail && step.status === "active" ? `<span class="step-detail">${escapeHtml(step.detail)}</span>` : "";

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
        </div>
        ${progressBar}
        ${detail}
      </div>`;
		})
		.join("");

	return `<div class="steps-pipeline">${stepsHtml}</div>`;
}

function renderJobCard(job) {
	const active = isActive(job.status);
	const done = job.status === "done";
	const err = job.status === "error";

	let meta = "";
	if (job.probe) {
		meta += `<span>${job.probe.width}×${job.probe.height}</span>`;
		meta += `<span>${job.probe.audioLayout}</span>`;
		if (job.probe.isHDR) meta += `<span>HDR</span>`;
		if (job.probe.duration) meta += `<span>${formatDuration(job.probe.duration * 1000)}</span>`;
	}
	meta += `<span>${job.settings.quality} · ${job.settings.finalSpeed}</span>`;

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

	// Replace inline onclick with data attributes
	let actions = "";
	if (job.status === "queued") {
		actions = `
      <button class="btn-icon" title="Settings" data-job-id="${job.id}" data-action="edit">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
      </button>
      <button class="btn-icon" title="Remove" data-job-id="${job.id}" data-action="remove">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>`;
	} else if (err) {
		actions = `
      <button class="btn-icon" title="Retry" data-job-id="${job.id}" data-action="retry">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
      </button>
      <button class="btn-icon" title="Remove" data-job-id="${job.id}" data-action="remove">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>`;
	} else if (done) {
		actions = `
      <button class="btn-icon" title="Dismiss" data-job-id="${job.id}" data-action="dismiss">
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

function escapeHtml(s) {
	const d = document.createElement("div");
	d.textContent = s;
	return d.innerHTML;
}

let lastJobsJson = "";

async function update() {
	try {
		const jobs = await fetchJobs();
		const json = JSON.stringify(jobs);

		if (json === lastJobsJson) return;
		lastJobsJson = json;

		const emptyEl = document.getElementById("empty-state");
		const listEl = document.getElementById("jobs-list");

		if (jobs.length === 0) {
			emptyEl.style.display = "";
			listEl.style.display = "none";
			return;
		}

		emptyEl.style.display = "none";
		listEl.style.display = "";
		listEl.innerHTML = jobs.map(renderJobCard).join("");
	} catch (e) {
		console.error("Poll error:", e);
	}
}

setInterval(update, 1500);
update();

async function openSettings() {
	if (!defaults) defaults = await fetchConfig();

	const tempDefaults = {
		...defaults,
		audioBitrates: { ...defaults.audioBitrates },
	};

	renderRadioPills(document.getElementById("default-quality"), QUALITIES, tempDefaults.quality, (v) => (tempDefaults.quality = v));
	renderRadioPills(document.getElementById("default-speed"), SPEEDS, tempDefaults.finalSpeed, (v) => (tempDefaults.finalSpeed = v));
	renderBitrateInputs(document.getElementById("default-bitrates"), tempDefaults.audioBitrates, (ch, val) => (tempDefaults.audioBitrates[ch] = val));

	window._tempDefaults = tempDefaults; // still useful for persistence
	document.getElementById("settings-modal").style.display = "";
}

function closeSettings() {
	document.getElementById("settings-modal").style.display = "none";
}

function closeSettingsIfOutside(e) {
	if (e.target === e.currentTarget) closeSettings();
}

async function openJobSettings(jobId) {
	const jobs = await fetchJobs();
	const job = jobs.find((j) => j.id === jobId);
	if (!job || job.status !== "queued") return;

	currentEditJobId = jobId;
	document.getElementById("job-modal-title").textContent = job.filename;

	const tempSettings = {
		...job.settings,
		audioBitrates: { ...job.settings.audioBitrates },
	};
	window._tempJobSettings = tempSettings;

	renderRadioPills(document.getElementById("job-quality"), QUALITIES, tempSettings.quality, (v) => (tempSettings.quality = v));
	renderRadioPills(document.getElementById("job-speed"), SPEEDS, tempSettings.finalSpeed, (v) => (tempSettings.finalSpeed = v));
	renderBitrateInputs(document.getElementById("job-bitrates"), tempSettings.audioBitrates, (ch, val) => (tempSettings.audioBitrates[ch] = val));

	document.getElementById("job-modal").style.display = "";
}

async function saveJobSettings() {
	if (!currentEditJobId || !window._tempJobSettings) return;
	await patchJob(currentEditJobId, window._tempJobSettings);
	closeJobModal();
	update();
}

function closeJobModal() {
	document.getElementById("job-modal").style.display = "none";
	currentEditJobId = null;
}

function closeJobModalIfOutside(e) {
	if (e.target === e.currentTarget) closeJobModal();
}

async function removeJob(id) {
	await deleteJob(id);
	update();
}

async function doRetry(id) {
	await retryJob(id);
	update();
}

function initEventListeners() {
	document.getElementById("open-settings-btn").addEventListener("click", openSettings);
	document.getElementById("close-settings-btn").addEventListener("click", closeSettings);
	document.getElementById("settings-modal").addEventListener("click", closeSettingsIfOutside);
	document.getElementById("close-job-modal-btn").addEventListener("click", closeJobModal);
	document.getElementById("job-modal").addEventListener("click", closeJobModalIfOutside);
	document.getElementById("save-job-settings-btn").addEventListener("click", saveJobSettings);

	document.getElementById("jobs-list").addEventListener("click", (e) => {
		const button = e.target.closest(".btn-icon");
		if (!button) return;

		const jobId = button.dataset.jobId;
		const action = button.dataset.action;

		if (action === "edit") {
			openJobSettings(jobId);
		} else if (action === "remove" || action === "dismiss") {
			removeJob(jobId);
		} else if (action === "retry") {
			doRetry(jobId);
		}
	});
}

document.addEventListener("DOMContentLoaded", () => {
	initEventListeners();
	fetchConfig().then((c) => (defaults = c));
});
