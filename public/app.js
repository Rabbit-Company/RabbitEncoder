import Blake2b from "@rabbit-company/blake2b";

const API = "";
let defaults = null;
let currentEditJobId = null;
let authToken = localStorage.getItem("authToken") || "";
let pollTimer = null;

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

const expandedFolders = new Set();
let libraryDirs = [];
const libraryNodes = new Map();

function createTreeNode(entry, depth, parentPath) {
	return {
		path: entry.path,
		name: entry.name,
		type: entry.type,
		depth,
		parentPath,
		expanded: false,
		checked: false,
		children: entry.type === "directory" ? null : undefined,
		loading: false,
		encoded: entry.encoded || false,
		videoCount: entry.videoCount || 0,
		encodedCount: entry.encodedCount || 0,
		size: entry.size || 0,
	};
}

function hashPassword(password) {
	return Blake2b.hash(`rabbitencoder-${password}`);
}

function showLogin(message) {
	const modal = document.getElementById("login-modal");
	const error = document.getElementById("login-error");
	const input = document.getElementById("login-password");
	error.textContent = message || "";
	input.value = "";
	modal.style.display = "";
	input.focus();
}

function hideLogin() {
	document.getElementById("login-modal").style.display = "none";
}

async function handleLogin() {
	const input = document.getElementById("login-password");
	const password = input.value.trim();
	if (!password) return;

	const btn = document.getElementById("login-submit-btn");
	btn.disabled = true;
	btn.textContent = "Verifying...";

	authToken = hashPassword(password);

	try {
		const res = await fetch(`${API}/api/config`, {
			headers: { Authorization: `Bearer ${authToken}` },
		});

		if (res.status === 401 || res.status === 403) {
			document.getElementById("login-error").textContent = "Invalid password";
			input.value = "";
			input.focus();
			return;
		}

		if (!res.ok) {
			document.getElementById("login-error").textContent = `Server error (${res.status})`;
			return;
		}

		localStorage.setItem("authToken", authToken);
		hideLogin();
		defaults = await res.json();
		startPolling();
	} catch (e) {
		document.getElementById("login-error").textContent = "Cannot reach server";
	} finally {
		btn.disabled = false;
		btn.textContent = "Login";
	}
}

function logout() {
	authToken = "";
	localStorage.removeItem("authToken");
	defaults = null;
	lastJobsJson = "";
	stopPolling();
	document.getElementById("jobs-list").style.display = "none";
	document.getElementById("empty-state").style.display = "";
	showLogin("");
}

async function authFetch(url, opts = {}) {
	const headers = { ...(opts.headers || {}) };
	if (authToken) {
		headers["Authorization"] = `Bearer ${authToken}`;
	}
	const res = await fetch(url, { ...opts, headers });

	if (res.status === 401 || res.status === 403) {
		authToken = "";
		localStorage.removeItem("authToken");
		stopPolling();
		showLogin("Session expired, please log in again");
		throw new Error("Unauthorized");
	}

	return res;
}

async function fetchJobs() {
	const res = await authFetch(`${API}/api/jobs`);
	return res.json();
}

async function fetchConfig() {
	const res = await authFetch(`${API}/api/config`);
	return res.json();
}

async function patchConfig(settings) {
	const res = await authFetch(`${API}/api/config`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(settings),
	});
	return res.json();
}

async function patchJob(id, settings) {
	const res = await authFetch(`${API}/api/jobs/${id}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(settings),
	});
	return res.json();
}

async function deleteJob(id) {
	await authFetch(`${API}/api/jobs/${id}`, { method: "DELETE" });
}

async function retryJob(id) {
	await authFetch(`${API}/api/jobs/${id}/retry`, { method: "POST" });
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
	if (h > 0) return `${h}h ${m}m ${s}s`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

function formatDurationShort(ms) {
	const sec = Math.floor(ms / 1000);
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	const s = sec % 60;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

function computeStepElapsed(step) {
	if (!step.startedAt) return null;
	const end = step.finishedAt || Date.now();
	return end - step.startedAt;
}

function computeStepETA(step) {
	if (!step.startedAt || step.status !== "active" || step.progress <= 0) return null;
	const elapsed = Date.now() - step.startedAt;
	if (elapsed < 3000) return null;
	const totalEstimated = (elapsed / step.progress) * 100;
	const remaining = totalEstimated - elapsed;
	return remaining > 0 ? remaining : null;
}

function renderStepTime(step) {
	if (step.status === "done" && step.startedAt) {
		const elapsed = computeStepElapsed(step);
		return `<span class="step-time step-time-done">${formatDurationShort(elapsed)}</span>`;
	}
	if (step.status === "active" && step.startedAt) {
		const elapsed = computeStepElapsed(step);
		const eta = computeStepETA(step);
		let timeStr = formatDurationShort(elapsed);
		if (eta !== null) {
			timeStr += ` · ~${formatDurationShort(eta)} left`;
		}
		return `<span class="step-time step-time-active">${timeStr}</span>`;
	}
	return "";
}

function renderSteps(steps) {
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

function buildFolderTree(jobs) {
	const root = { name: "", fullPath: "", children: new Map(), jobs: [] };

	for (const job of jobs) {
		let parts = [];

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
			current = current.children.get(part);
		}

		current.jobs.push(job);
	}

	return root;
}

function collectAllJobs(node) {
	let all = [...node.jobs];
	for (const child of node.children.values()) {
		all = all.concat(collectAllJobs(child));
	}
	return all;
}

function computeFolderStats(node) {
	const allJobs = collectAllJobs(node);
	const total = allJobs.length;
	const done = allJobs.filter((j) => j.status === "done").length;
	const encoding = allJobs.filter((j) => isActive(j.status)).length;
	const queued = allJobs.filter((j) => j.status === "queued").length;
	const error = allJobs.filter((j) => j.status === "error").length;
	return { total, done, encoding, queued, error };
}

function folderHasActive(node) {
	return collectAllJobs(node).some((j) => isActive(j.status));
}

function computeFolderTimeEstimate(node) {
	const allJobs = collectAllJobs(node);

	const doneJobs = allJobs.filter((j) => j.status === "done" && j.startedAt && j.finishedAt);
	const activeJobs = allJobs.filter((j) => isActive(j.status));
	const queuedJobs = allJobs.filter((j) => j.status === "queued");

	if (doneJobs.length === 0 && activeJobs.length === 0) return null;

	// Total elapsed time for completed jobs
	const totalElapsed = doneJobs.reduce((sum, j) => sum + (j.finishedAt - j.startedAt), 0);

	// Average encode time per episode
	const avgPerEpisode = doneJobs.length > 0 ? totalElapsed / doneJobs.length : null;

	// Try duration-weighted estimation
	let useDurationWeighted = false;
	let encodeRatio = null;

	const doneWithDuration = doneJobs.filter((j) => j.probe && j.probe.duration > 0);
	if (doneWithDuration.length > 0) {
		const totalEncode = doneWithDuration.reduce((sum, j) => sum + (j.finishedAt - j.startedAt), 0);
		const totalDuration = doneWithDuration.reduce((sum, j) => sum + j.probe.duration * 1000, 0);
		encodeRatio = totalEncode / totalDuration;
		useDurationWeighted = true;
	}

	// Estimate remaining time for queued jobs
	let queuedEstimate = 0;
	if (queuedJobs.length > 0) {
		if (useDurationWeighted) {
			const queuedWithDuration = queuedJobs.filter((j) => j.probe && j.probe.duration > 0);
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
		} else if (useDurationWeighted && job.probe && job.probe.duration > 0) {
			activeRemaining += job.probe.duration * 1000 * encodeRatio;
		}
	}

	const estimatedRemaining = activeRemaining + queuedEstimate;
	const remainingCount = activeJobs.length + queuedJobs.length;

	return {
		totalElapsed,
		estimatedRemaining,
		avgPerEpisode,
		doneCount: doneJobs.length,
		remainingCount,
	};
}

function renderFolderTimeEstimate(node) {
	const est = computeFolderTimeEstimate(node);
	if (!est) {
		return `<div class="folder-time-estimate folder-time-pending">Estimated after 1st encode</div>`;
	}

	const parts = [];

	if (est.remainingCount > 0 && est.doneCount > 0) {
		// Still encoding (show remaining estimate)
		parts.push(`~${formatDurationShort(est.estimatedRemaining)} remaining`);
	} else if (est.remainingCount === 0 && est.doneCount > 0) {
		// All done (show total time)
		parts.push(`Total: ${formatDurationShort(est.totalElapsed)}`);
	}

	if (est.avgPerEpisode && est.doneCount > 0) {
		parts.push(`${formatDurationShort(est.avgPerEpisode)} avg/ep`);
	}

	if (parts.length === 0) return `<div class="folder-time-estimate folder-time-pending">Estimated after 1st encode</div>`;

	return `<div class="folder-time-estimate">${parts.join(" · ")}</div>`;
}

function renderFolderStats(stats) {
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

function renderFolderProgress(stats) {
	if (stats.total === 0) return "";
	const pct = Math.round((stats.done / stats.total) * 100);
	return `<div class="folder-progress"><div class="folder-progress-fill" style="width:${pct}%"></div></div>`;
}

function renderFolderNode(node, depth) {
	const isExpanded = expandedFolders.has(node.fullPath);
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
        </div>
        <div class="folder-right">
          <div class="folder-stats">${renderFolderStats(stats)}</div>
          ${renderFolderProgress(stats)}
          ${renderFolderTimeEstimate(node)}
        </div>
      </div>`;

	if (isExpanded) {
		html += `<div class="folder-children">`;

		const sortedChildren = Array.from(node.children.values()).sort((a, b) => a.name.localeCompare(b.name));
		for (const child of sortedChildren) {
			html += renderFolderNode(child, depth + 1);
		}

		for (const job of node.jobs) {
			html += `<div class="folder-job" style="--depth:${depth + 1}">${renderJobCard(job)}</div>`;
		}

		html += `</div>`;
	}

	html += `</div>`;
	return html;
}

function renderJobsList(jobs) {
	const tree = buildFolderTree(jobs);
	let html = "";

	const sortedFolders = Array.from(tree.children.values()).sort((a, b) => a.name.localeCompare(b.name));
	for (const folder of sortedFolders) {
		html += renderFolderNode(folder, 0);
	}

	for (const job of tree.jobs) {
		html += renderJobCard(job);
	}

	return html;
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

		const hasActive = jobs.some((j) => isActive(j.status));

		if (json === lastJobsJson && !hasActive) return;
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
		listEl.innerHTML = renderJobsList(jobs);
	} catch (e) {
		if (e.message === "Unauthorized") return;
		console.error("Poll error:", e);
	}
}

function startPolling() {
	stopPolling();
	update();
	pollTimer = setInterval(update, 1500);
}

function stopPolling() {
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
}

async function openSettings() {
	if (!defaults) defaults = await fetchConfig();

	const tempDefaults = {
		...defaults,
		audioBitrates: { ...defaults.audioBitrates },
	};

	renderRadioPills(document.getElementById("default-quality"), QUALITIES, tempDefaults.quality, (v) => (tempDefaults.quality = v));
	renderRadioPills(document.getElementById("default-speed"), SPEEDS, tempDefaults.finalSpeed, (v) => (tempDefaults.finalSpeed = v));
	renderBitrateInputs(document.getElementById("default-bitrates"), tempDefaults.audioBitrates, (ch, val) => (tempDefaults.audioBitrates[ch] = val));

	window._tempDefaults = tempDefaults;
	document.getElementById("settings-modal").style.display = "";
}

async function saveSettings() {
	if (!window._tempDefaults) return;
	defaults = await patchConfig(window._tempDefaults);
	closeSettings();
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

async function fetchLibraryDirs() {
	const res = await authFetch(`${API}/api/library`);
	const data = await res.json();
	return data.dirs || [];
}

async function fetchLibraryBrowse(path) {
	const res = await authFetch(`${API}/api/library/browse?path=${encodeURIComponent(path)}`);
	return res.json();
}

async function postLibraryEncodePaths(paths) {
	const res = await authFetch(`${API}/api/library/encode`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ paths }),
	});
	return res.json();
}

function humanFileSize(bytes) {
	if (!bytes) return "";
	const units = ["B", "KiB", "MiB", "GiB", "TiB"];
	let i = 0;
	let val = bytes;
	while (val >= 1024 && i < units.length - 1) {
		val /= 1024;
		i++;
	}
	return `${val.toFixed(1)} ${units[i]}`;
}

function setNodeChecked(path, checked) {
	const node = libraryNodes.get(path);
	if (!node) return;
	node.checked = checked;
	if (node.type === "directory" && node.children) {
		for (const childPath of node.children) {
			setNodeChecked(childPath, checked);
		}
	}
}

function getNodeCheckState(path) {
	const node = libraryNodes.get(path);
	if (!node) return { checked: false, indeterminate: false };
	if (node.type === "file") return { checked: node.checked, indeterminate: false };
	if (!node.children || node.children.length === 0) return { checked: node.checked, indeterminate: false };

	let checkedCount = 0;
	let totalCount = 0;
	let hasIndeterminate = false;
	for (const childPath of node.children) {
		const s = getNodeCheckState(childPath);
		totalCount++;
		if (s.checked) checkedCount++;
		if (s.indeterminate) hasIndeterminate = true;
	}
	if (hasIndeterminate || (checkedCount > 0 && checkedCount < totalCount)) {
		return { checked: false, indeterminate: true };
	}
	return { checked: checkedCount === totalCount && totalCount > 0, indeterminate: false };
}

function updateParentCheckState(path) {
	const node = libraryNodes.get(path);
	if (!node || !node.parentPath) return;
	const parent = libraryNodes.get(node.parentPath);
	if (!parent || !parent.children) return;
	const state = getNodeCheckState(parent.path);
	parent.checked = state.checked;
	updateParentCheckState(parent.path);
}

function toggleNodeCheck(path) {
	const state = getNodeCheckState(path);
	const newChecked = !(state.checked || state.indeterminate);
	setNodeChecked(path, newChecked);
	updateParentCheckState(path);
	renderLibraryTree();
	updateLibraryFooter();
}

async function toggleNodeExpand(path) {
	const node = libraryNodes.get(path);
	if (!node || node.type !== "directory") return;

	if (node.expanded) {
		node.expanded = false;
		renderLibraryTree();
		return;
	}

	if (node.children === null) {
		node.loading = true;
		renderLibraryTree();
		try {
			const data = await fetchLibraryBrowse(node.path);
			const entries = data.entries || [];
			node.children = [];
			for (const entry of entries) {
				const child = createTreeNode(entry, node.depth + 1, node.path);
				if (node.checked) child.checked = true;
				libraryNodes.set(child.path, child);
				node.children.push(child.path);
			}
		} catch {
			node.children = [];
		}
		node.loading = false;
	}

	node.expanded = true;
	renderLibraryTree();
}

function getCheckedPaths() {
	const paths = [];
	function collect(path) {
		const node = libraryNodes.get(path);
		if (!node) return;
		if (node.type === "file") {
			if (node.checked && !node.encoded) paths.push(node.path);
			return;
		}
		const state = getNodeCheckState(path);
		if (state.checked) {
			paths.push(node.path);
			return;
		}
		if (state.indeterminate && node.children) {
			for (const childPath of node.children) collect(childPath);
		}
	}
	for (const dir of libraryDirs) {
		const root = libraryNodes.get(dir.path);
		if (root) collect(root.path);
	}
	return paths;
}

function countSelectedToEncode() {
	let total = 0;
	function count(path) {
		const node = libraryNodes.get(path);
		if (!node) return;
		if (node.type === "file") {
			if (node.checked && !node.encoded) total++;
			return;
		}
		const state = getNodeCheckState(path);
		if (state.checked) {
			total += (node.videoCount || 0) - (node.encodedCount || 0);
			return;
		}
		if (state.indeterminate && node.children) {
			for (const childPath of node.children) count(childPath);
		}
	}
	for (const dir of libraryDirs) {
		const root = libraryNodes.get(dir.path);
		if (root) count(root.path);
	}
	return total;
}

function renderLibraryTree() {
	const content = document.getElementById("library-content");
	if (libraryDirs.length === 0) {
		content.innerHTML = `<div class="library-empty">No library directories configured.<br>Set <code>LIBRARY_DIRS</code> in your docker-compose.yml</div>`;
		return;
	}
	let html = "";
	for (const dir of libraryDirs) {
		const node = libraryNodes.get(dir.path);
		if (node) html += renderTreeNode(node);
	}
	content.innerHTML = html || `<div class="library-empty">No library directories configured</div>`;
}

function renderTreeNode(node) {
	const isDir = node.type === "directory";
	const state = getNodeCheckState(node.path);
	const indent = node.depth * 24;

	if (isDir) {
		return renderTreeFolder(node, state.checked, state.indeterminate, indent);
	}
	return renderTreeFile(node, indent);
}

function renderTreeFolder(node, checked, indeterminate, indent) {
	const chevronClass = node.expanded ? "expanded" : "";
	const encodedClass = node.videoCount > 0 && node.videoCount === node.encodedCount ? " is-encoded" : "";
	const pending = (node.videoCount || 0) - (node.encodedCount || 0);

	let metaParts = [];
	if (node.videoCount > 0 && pending === 0) metaParts.push(`<span class="library-encoded-badge">encoded</span>`);
	if (pending > 0) metaParts.push(`${pending} to encode`);
	if (node.videoCount > 0) metaParts.push(`${node.videoCount} video${node.videoCount !== 1 ? "s" : ""}`);

	let childrenHtml = "";
	if (node.expanded && node.children) {
		if (node.children.length === 0) {
			childrenHtml = `<div class="tree-empty" style="padding-left:${indent + 56}px">Empty folder</div>`;
		} else {
			for (const childPath of node.children) {
				const child = libraryNodes.get(childPath);
				if (child) childrenHtml += renderTreeNode(child);
			}
		}
	}
	if (node.loading) {
		childrenHtml = `<div class="tree-loading" style="padding-left:${indent + 56}px">Loading...</div>`;
	}

	const cbHtml = renderCheckbox(node.path, checked, indeterminate);
	return `
		<div class="tree-node tree-folder${encodedClass}">
			<div class="tree-row" style="padding-left:${indent}px">
				<button class="tree-chevron ${chevronClass}" data-action="expand" data-path="${escapeHtml(node.path)}">
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
				</button>
				${cbHtml}
				<svg class="tree-icon tree-icon-folder" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
					<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
				</svg>
				<span class="tree-name" data-action="expand" data-path="${escapeHtml(node.path)}">${escapeHtml(node.name)}</span>
				<span class="tree-meta">${metaParts.join(" · ")}</span>
			</div>
			${childrenHtml}
		</div>`;
}

function renderTreeFile(node, indent) {
	const encodedClass = node.encoded ? " is-encoded" : "";
	const cbHtml = renderCheckbox(node.path, node.checked, false);
	let metaParts = [];
	if (node.encoded) metaParts.push(`<span class="library-encoded-badge">encoded</span>`);
	if (node.size) metaParts.push(humanFileSize(node.size));

	return `
		<div class="tree-node tree-file${encodedClass}">
			<div class="tree-row" style="padding-left:${indent + 24}px">
				${cbHtml}
				<svg class="tree-icon tree-icon-file" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
					<polygon points="23 7 16 12 23 17 23 7"/>
					<rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
				</svg>
				<span class="tree-name tree-name-file">${escapeHtml(node.name)}</span>
				<span class="tree-meta">${metaParts.join(" · ")}</span>
			</div>
		</div>`;
}

function renderCheckbox(path, checked, indeterminate) {
	const cls = checked ? "checked" : indeterminate ? "indeterminate" : "";
	const icon = checked
		? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>`
		: indeterminate
			? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="5" y1="12" x2="19" y2="12"/></svg>`
			: "";
	return `<button class="tree-checkbox ${cls}" data-action="check" data-path="${escapeHtml(path)}">${icon}</button>`;
}

function updateLibraryFooter() {
	const note = document.getElementById("library-note");
	const encodeBtn = document.getElementById("library-encode-btn");
	const count = countSelectedToEncode();
	if (count > 0) {
		note.textContent = `${count} file${count !== 1 ? "s" : ""} selected for encoding`;
		encodeBtn.disabled = false;
	} else {
		note.textContent = "Select folders or files to encode";
		encodeBtn.disabled = true;
	}
}

async function openLibrary() {
	const modal = document.getElementById("library-modal");
	const content = document.getElementById("library-content");
	const note = document.getElementById("library-note");
	const encodeBtn = document.getElementById("library-encode-btn");
	content.innerHTML = `<div class="library-loading">Loading library...</div>`;
	note.textContent = "";
	encodeBtn.disabled = true;
	modal.style.display = "";

	try {
		libraryDirs = await fetchLibraryDirs();
		if (libraryDirs.length === 0) {
			content.innerHTML = `<div class="library-empty">No library directories configured.<br>Set <code>LIBRARY_DIRS</code> in your docker-compose.yml</div>`;
			return;
		}
		libraryNodes.clear();
		for (const dir of libraryDirs) {
			const rootNode = createTreeNode({ path: dir.path, name: dir.name, type: "directory", videoCount: 0, encodedCount: 0 }, 0, null);
			libraryNodes.set(dir.path, rootNode);
		}
		renderLibraryTree();
		updateLibraryFooter();
	} catch {
		content.innerHTML = `<div class="library-empty">Failed to load library</div>`;
	}
}

function closeLibrary() {
	document.getElementById("library-modal").style.display = "none";
}

function closeLibraryIfOutside(e) {
	if (e.target === e.currentTarget) closeLibrary();
}

async function handleLibraryEncode() {
	const paths = getCheckedPaths();
	if (paths.length === 0) return;

	const encodeBtn = document.getElementById("library-encode-btn");
	encodeBtn.disabled = true;
	encodeBtn.textContent = "Starting...";

	try {
		const result = await postLibraryEncodePaths(paths);
		const note = document.getElementById("library-note");
		const parts = [];
		if (result.added > 0) parts.push(`Queued ${result.added} file${result.added !== 1 ? "s" : ""}`);
		if (result.skipped > 0) parts.push(`${result.skipped} already queued`);
		if (result.alreadyEncoded > 0) parts.push(`${result.alreadyEncoded} already encoded`);
		if (parts.length === 0) parts.push("No video files found to encode");
		note.textContent = parts.join(" · ");

		if (result.added > 0) {
			closeLibrary();
			update();
		}
	} catch {
		document.getElementById("library-note").textContent = "Failed to start encoding";
	} finally {
		encodeBtn.textContent = "Encode Selected";
		encodeBtn.disabled = getCheckedPaths().length === 0;
	}
}

function initEventListeners() {
	document.getElementById("open-settings-btn").addEventListener("click", openSettings);
	document.getElementById("close-settings-btn").addEventListener("click", closeSettings);
	document.getElementById("save-settings-btn").addEventListener("click", saveSettings);
	document.getElementById("settings-modal").addEventListener("click", closeSettingsIfOutside);
	document.getElementById("close-job-modal-btn").addEventListener("click", closeJobModal);
	document.getElementById("job-modal").addEventListener("click", closeJobModalIfOutside);
	document.getElementById("save-job-settings-btn").addEventListener("click", saveJobSettings);
	document.getElementById("logout-btn").addEventListener("click", logout);

	document.getElementById("login-submit-btn").addEventListener("click", handleLogin);
	document.getElementById("login-password").addEventListener("keydown", (e) => {
		if (e.key === "Enter") handleLogin();
	});

	document.getElementById("jobs-list").addEventListener("click", (e) => {
		const folderHeader = e.target.closest(".folder-header");
		if (folderHeader) {
			const path = folderHeader.dataset.folderPath;
			if (expandedFolders.has(path)) {
				expandedFolders.delete(path);
			} else {
				expandedFolders.add(path);
			}
			lastJobsJson = "";
			update();
			return;
		}

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

	document.getElementById("open-library-btn").addEventListener("click", openLibrary);
	document.getElementById("close-library-btn").addEventListener("click", closeLibrary);
	document.getElementById("library-modal").addEventListener("click", closeLibraryIfOutside);
	document.getElementById("library-encode-btn").addEventListener("click", handleLibraryEncode);

	document.getElementById("library-content").addEventListener("click", (e) => {
		const chevron = e.target.closest('[data-action="expand"]');
		if (chevron) {
			const path = chevron.dataset.path;
			if (path) toggleNodeExpand(path);
			return;
		}

		const checkbox = e.target.closest('[data-action="check"]');
		if (checkbox) {
			const path = checkbox.dataset.path;
			if (path) toggleNodeCheck(path);
			return;
		}
	});
}

async function init() {
	initEventListeners();

	if (!authToken) {
		showLogin("");
		return;
	}

	try {
		const res = await fetch(`${API}/api/config`, {
			headers: { Authorization: `Bearer ${authToken}` },
		});

		if (res.status === 401 || res.status === 403) {
			authToken = "";
			localStorage.removeItem("authToken");
			showLogin("");
			return;
		}

		defaults = await res.json();
		startPolling();

		try {
			const libData = await fetchLibraryDirs();
			if (libData.length > 0) {
				document.getElementById("open-library-btn").style.display = "";
			}
		} catch {}
	} catch {
		showLogin("Cannot reach server");
	}
}

document.addEventListener("DOMContentLoaded", init);
