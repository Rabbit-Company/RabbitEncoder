import type { FilmGrainRun, JobSettings } from "../types";
import type { AdvancedTarget } from "../ui/models";
import { cancelFilmGrainTable, fetchFilmGrainRun, fetchJobs, startFilmGrainTable } from "../api/client";
import { FILM_GRAIN_RANGES, FILM_GRAIN_SAMPLINGS } from "../config/options";
import { byId } from "../shared/dom";
import { errorMessage } from "../shared/errors";
import { appState } from "../state";
import { formatDuration } from "./job-render";
import { openPreviewReferencePicker } from "./repair";
import { renderRadioPills } from "./settings-controls";

let pollTimer: number | undefined;
/** Bumped whenever the section is rebuilt or closed, so late responses are dropped. */
let session = 0;

export function stopFilmGrainSettings(): void {
	session++;
	window.clearTimeout(pollTimer);
}

export function initFilmGrainSettings(target: AdvancedTarget, settings: JobSettings): void {
	stopFilmGrainSettings();
	const current = session;
	const live = () => current === session;

	renderRadioPills(
		byId("advanced-film-grain-sampling"),
		FILM_GRAIN_SAMPLINGS,
		settings.filmGrainSampling || "all",
		(v) => (settings.filmGrainSampling = v),
		(v) => ({ all: "All", half: "Half", quarter: "Quarter" })[v],
	);
	renderRadioPills(
		byId("advanced-film-grain-range"),
		FILM_GRAIN_RANGES,
		settings.filmGrainRange || "full",
		(v) => (settings.filmGrainRange = v),
		(v) => (v === "representative" ? "Quick (30s)" : "Full video"),
	);

	const jobId = target === "job" ? appState.currentEditJobId : null;
	byId("advanced-film-grain-job").style.display = jobId ? "" : "none";
	if (!jobId) return;

	const tableInput = byId<HTMLInputElement>("advanced-film-grain-table");
	const originalInput = byId<HTMLInputElement>("advanced-film-grain-original");
	const generateButton = byId<HTMLButtonElement>("advanced-film-grain-generate-btn");
	const cancelButton = byId<HTMLButtonElement>("advanced-film-grain-cancel-btn");
	const progressEl = byId("advanced-film-grain-progress");
	const result = byId("advanced-film-grain-result");

	const show = (run: FilmGrainRun): void => {
		const running = run.status === "running";
		generateButton.disabled = running;
		cancelButton.style.display = running ? "" : "none";
		progressEl.style.display = running ? "" : "none";
		if (running) {
			const progress = run.progress;
			const bar = byId("advanced-film-grain-progress-bar");
			byId("advanced-film-grain-progress-pct").textContent = progress?.percent !== undefined ? `${progress.percent}%` : "";
			bar.setAttribute("aria-valuenow", String(progress?.percent ?? 0));
			byId("advanced-film-grain-progress-fill").style.width = `${progress?.percent ?? 0}%`;
			byId("advanced-film-grain-progress-detail").textContent = [
				progress
					? `${progress.frames.toLocaleString()}${progress.totalFrames ? ` / ${progress.totalFrames.toLocaleString()}` : ""} frames`
					: "Preparing film grain measurement",
				progress?.speed,
				progress?.eta ? `ETA ${progress.eta}` : undefined,
				run.startedAt ? `Elapsed ${formatDuration(Math.max(0, Date.now() - run.startedAt))}` : undefined,
			]
				.filter(Boolean)
				.join(" | ");
			return;
		}
		cancelButton.disabled = false;
		if (run.status === "done" && run.tablePath) {
			settings.filmGrainTablePath = run.tablePath;
			tableInput.value = run.tablePath;
			result.textContent = `Table generated (${run.segments} ${run.segments === 1 ? "segment" : "segments"}) and set on this job. Run Preview to inspect the grain.`;
		} else if (run.status === "error") result.textContent = run.error || "Film grain table generation failed.";
		else if (run.status === "cancelled") result.textContent = "Generation cancelled.";
	};

	const poll = async (): Promise<void> => {
		if (!live()) return;
		try {
			const run = await fetchFilmGrainRun(jobId);
			if (!live()) return;
			show(run);
			if (run.status !== "running") return;
		} catch {
			// A failed poll is retried: the run continues on the server.
			if (!live()) return;
		}
		pollTimer = window.setTimeout(poll, 1000);
	};

	tableInput.value = settings.filmGrainTablePath || "";
	tableInput.oninput = () => {
		settings.filmGrainTablePath = tableInput.value.trim();
	};
	originalInput.value = "";
	result.textContent = "";
	show({ status: "idle" });

	// Generation continues on the server when this window closes, so pick a running one back up.
	void (async () => {
		try {
			const run = await fetchFilmGrainRun(jobId);
			if (!live()) return;
			if (run.status === "running") {
				if (run.sourcePath) originalInput.value = run.sourcePath;
				show(run);
				pollTimer = window.setTimeout(poll, 1000);
			}
			if (originalInput.value) return;
			const jobs = await fetchJobs();
			if (live() && !originalInput.value) originalInput.value = jobs.find((job) => job.id === jobId)?.originalSourcePath || "";
		} catch {}
	})();

	byId("advanced-film-grain-choose").onclick = () =>
		openPreviewReferencePicker((path) => {
			originalInput.value = path;
		});

	generateButton.onclick = async () => {
		const sourcePath = originalInput.value.trim();
		if (!sourcePath) {
			result.textContent = "Choose the aligned original video first.";
			return;
		}
		generateButton.disabled = true;
		result.textContent = "";
		try {
			const run = await startFilmGrainTable(jobId, sourcePath, settings.filmGrainSampling, settings.filmGrainRange ?? "full");
			if (!live()) return;
			show(run);
			window.clearTimeout(pollTimer);
			pollTimer = window.setTimeout(poll, 1000);
		} catch (err) {
			if (!live()) return;
			result.textContent = errorMessage(err);
			generateButton.disabled = false;
		}
	};

	cancelButton.onclick = () => {
		cancelButton.disabled = true;
		void cancelFilmGrainTable(jobId).catch(() => {});
	};
}
