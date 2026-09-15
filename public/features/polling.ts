import { fetchJobs, fetchQueueState, pauseQueueRequest, resumeQueueRequest } from "../api/client";
import { isActive, renderJobsList } from "./job-render";
import { startSystemPolling, stopSystemPolling } from "./system-benchmark";
import { buttonById, byId } from "../shared/dom";
import { errorMessage } from "../shared/errors";
import { appState } from "../state";

export function updatePauseUI() {
	const btn = byId("pause-queue-btn");
	const pauseIcon = byId("pause-icon");
	const resumeIcon = byId("resume-icon");
	const label = byId("pause-label");
	const banner = byId("queue-paused-banner");

	if (appState.queuePaused) {
		pauseIcon.style.display = "none";
		resumeIcon.style.display = "";
		label.textContent = "Continue";
		btn.title = "Continue";
		btn.classList.add("btn-paused");
		banner.style.display = "";
	} else {
		pauseIcon.style.display = "";
		resumeIcon.style.display = "none";
		label.textContent = "Pause";
		btn.title = "Pause";
		btn.classList.remove("btn-paused");
		banner.style.display = "none";
	}
}

export async function handlePauseToggle() {
	const btn = buttonById("pause-queue-btn");
	btn.disabled = true;
	try {
		if (appState.queuePaused) {
			await resumeQueueRequest();
		} else {
			await pauseQueueRequest();
		}
		appState.lastJobsJson = ""; // force re-render
		await update();
	} catch (e) {
		console.error("Pause toggle failed:", e);
	} finally {
		btn.disabled = false;
	}
}

export async function update() {
	try {
		const [jobs, queueState] = await Promise.all([fetchJobs(), fetchQueueState().catch(() => ({ paused: false }))]);

		appState.queuePaused = !!queueState.paused;

		const hashKey = JSON.stringify({ j: jobs, p: appState.queuePaused });
		const hasActive = jobs.some((j) => isActive(j.status));

		updatePauseUI();

		if (hashKey === appState.lastJobsJson && !hasActive) return;
		appState.lastJobsJson = hashKey;

		const emptyEl = byId("empty-state");
		const listEl = byId("jobs-list");

		if (jobs.length === 0) {
			emptyEl.style.display = "";
			listEl.style.display = "none";
			return;
		}

		emptyEl.style.display = "none";
		listEl.style.display = "";
		listEl.innerHTML = renderJobsList(jobs);
	} catch (e) {
		if (errorMessage(e) === "Unauthorized") return;
		console.error("Poll error:", e);
	}
}

export function startPolling() {
	stopPolling();
	update();
	startSystemPolling();
	appState.pollTimer = setInterval(update, 1500);
}

export function stopPolling() {
	stopSystemPolling();
	if (appState.pollTimer) {
		clearInterval(appState.pollTimer);
		appState.pollTimer = null;
	}
}
