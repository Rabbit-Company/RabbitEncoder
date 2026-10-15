import type { FilmGrainRun, JobSettings } from "../types";
import type { AdvancedTarget } from "../ui/models";
import { cancelFilmGrainTable, fetchFilmGrainRun, fetchJobs, startFilmGrainTable } from "../api/client";
import { FILM_GRAIN_RANGES, FILM_GRAIN_SAMPLINGS, FILM_GRAIN_SIZES } from "../config/options";
import { byId } from "../shared/dom";
import { errorMessage } from "../shared/errors";
import { appState } from "../state";
import { formatDuration } from "./job-render";
import { openPreviewReferencePicker } from "./repair";
import { renderLabeledToggle, renderRadioPills } from "./settings-controls";

let pollTimer: number | undefined;
/** Bumped whenever the section is rebuilt or closed, so late responses are dropped. */
let session = 0;

export function stopFilmGrainSettings(): void {
	session++;
	window.clearTimeout(pollTimer);
}

function renderStrengthGrid(container: HTMLElement, fields: { label: string; value: number; onChange: (value: number) => void }[]): void {
	container.innerHTML = "";
	const grid = document.createElement("div");
	grid.className = "auto-threshold-grid";
	for (const field of fields) {
		const row = document.createElement("label");
		row.className = "auto-threshold-row";
		const span = document.createElement("span");
		span.textContent = field.label;
		const input = document.createElement("input");
		input.type = "number";
		input.min = "0";
		input.max = "64";
		input.step = "0.1";
		input.value = String(field.value);
		input.onchange = () => {
			const n = parseFloat(input.value);
			const v = Number.isFinite(n) ? Math.min(64, Math.max(0, n)) : 0;
			input.value = String(v);
			field.onChange(v);
		};
		row.appendChild(span);
		row.appendChild(input);
		grid.appendChild(row);
	}
	container.appendChild(grid);
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
		(v) => ({ all: "Every frame", half: "Half", quarter: "Quarter", eighth: "Eighth" })[v],
	);
	renderRadioPills(
		byId("advanced-film-grain-range"),
		FILM_GRAIN_RANGES,
		settings.filmGrainRange || "full",
		(v) => (settings.filmGrainRange = v),
		(v) => (v === "representative" ? "Quick (30s)" : "Full video"),
	);
	renderLabeledToggle(
		byId("advanced-film-grain-restore"),
		settings.filmGrainRestore === true,
		"Measure and restore the grain Rabbit's denoiser removes",
		(v) => (settings.filmGrainRestore = v),
	);
	renderLabeledToggle(
		byId("advanced-film-grain-just-enough"),
		settings.filmGrainJustEnough === true,
		"Just enough to hide banding",
		(v) => (settings.filmGrainJustEnough = v),
	);
	renderLabeledToggle(byId("advanced-film-grain-static"), settings.filmGrainStatic === true, "Static grain pattern", (v) => (settings.filmGrainStatic = v));
	renderStrengthGrid(byId("advanced-film-grain-synthetic-strength"), [
		{ label: "luma", value: settings.filmGrainSyntheticStrength ?? 0, onChange: (v) => (settings.filmGrainSyntheticStrength = v) },
		{ label: "chroma", value: settings.filmGrainSyntheticChroma ?? 0, onChange: (v) => (settings.filmGrainSyntheticChroma = v) },
	]);
	renderRadioPills(
		byId("advanced-film-grain-synthetic-size"),
		FILM_GRAIN_SIZES,
		settings.filmGrainSyntheticSize ?? "medium",
		(v) => (settings.filmGrainSyntheticSize = v),
		(v) => ({ fine: "Fine", medium: "Medium", coarse: "Coarse" })[v],
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
			result.textContent = run.segments
				? `Table generated (${run.segments} ${run.segments === 1 ? "segment" : "segments"}) and set on this job. Run Preview to inspect the grain.`
				: "The denoiser removed no measurable grain, so this job encodes without film grain.";
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
			const run = await startFilmGrainTable(
				jobId,
				sourcePath,
				settings.filmGrainSampling,
				settings.filmGrainRange ?? "full",
				settings.filmGrainJustEnough === true,
			);
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
