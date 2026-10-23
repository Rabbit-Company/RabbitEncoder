import type { FilmGrainRange, FilmGrainSampling, FilmGrainSize, GrainInspection, GrainInspectRun, GrainPlan } from "../types";
import {
	cancelGrainInspection,
	createGrainBatch,
	createGrainJob,
	downloadGrainTable,
	fetchGrainInspectRun,
	startGrainInspection,
	uploadGrainTable,
} from "../api/client";
import { buttonById, byId, inputById } from "../shared/dom";
import { errorMessage } from "../shared/errors";
import { openHdrSourcePicker, openHdrTargetPicker, openRepairFolderPicker } from "./repair";
import { renderRadioPills } from "./settings-controls";
import { update } from "./polling";
import { formatDuration } from "./job-render";
import { grainIso, isoResolution, MAX_GRAIN_ISO, MIN_GRAIN_ISO } from "../../src/core/film-grain-iso";

type Scope = "file" | "folder";
type Action = "keep" | GrainPlan["action"];

let scope: Scope = "file";
let targetPath = "";
let folderPath = "";
let inspection: GrainInspection | null = null;
/** Bumped on every new inspection, so a late answer for another file is dropped. */
let inspectRun = 0;
/** The inspection running on the server for the chosen video. */
let running: GrainInspectRun | null = null;

const STAGES: Record<GrainInspectRun["progress"]["stage"], string> = {
	video: "Reading the video",
	table: "Reading the film grain table",
	measure: "Measuring the grain",
};

const form = {
	action: "keep" as Action,
	grainMode: "iso" as "iso" | "strength",
	iso: 400,
	strength: 0.5,
	size: "medium" as FilmGrainSize,
	chroma: 0,
	staticGrain: false,
	uploadPath: "",
	uploadName: "",
	uploadEntries: 0,
	sourcePath: "",
	range: "representative" as FilmGrainRange,
	sampling: "all" as FilmGrainSampling,
	justEnough: false,
	measureChroma: false,
};

const escapeHtml = (value: unknown): string =>
	String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");

const fileName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

function setError(message: string): void {
	const error = byId("grain-error");
	error.textContent = message;
	error.style.display = message ? "" : "none";
}

function setResult(message: string): void {
	byId("grain-result").textContent = message;
}

function selection(path: string, empty: string): string {
	return path
		? `<span class="repair-file-name" title="${escapeHtml(path)}">${escapeHtml(fileName(path))}</span><span class="repair-file-folder">${escapeHtml(path)}</span>`
		: `<span class="repair-file-empty">${escapeHtml(empty)}</span>`;
}

function resetForm(): void {
	Object.assign(form, {
		action: "keep",
		staticGrain: false,
		uploadPath: "",
		uploadName: "",
		uploadEntries: 0,
		sourcePath: "",
		justEnough: false,
		measureChroma: false,
	});
}

/** The inspection's stage and progress. regrain cannot tell how long reading the table takes, so that stage has no percentage. */
function progressHtml(): string {
	const progress = running?.progress ?? { stage: "video" as const, percent: null, detail: "" };
	const percent = progress.percent;
	const detail = [progress.stage === "video" ? "" : progress.detail, running ? `Elapsed ${formatDuration(Math.max(0, Date.now() - running.startedAt))}` : ""]
		.filter(Boolean)
		.join(" | ");
	return `<div class="fgs-progress">
		<div class="fgs-progress-head"><span>${escapeHtml(STAGES[progress.stage])}</span><span>${percent === null ? "" : `${percent}%`}</span></div>
		<div class="step-bar${percent === null ? " step-bar-indeterminate" : ""}" role="progressbar" aria-label="Film grain inspection" aria-valuemin="0" aria-valuemax="100"${
			percent === null ? "" : ` aria-valuenow="${percent}"`
		}><div class="step-bar-fill"${percent === null ? "" : ` style="width: ${percent}%"`}></div></div>
		<div class="fgs-progress-detail">${escapeHtml(detail)}</div>
	</div>`;
}

function renderInspection(): void {
	const container = byId("grain-inspection");
	if (scope !== "file" || !targetPath) {
		container.innerHTML = "";
		return;
	}
	if (!inspection) {
		container.innerHTML = progressHtml();
		return;
	}
	const i = inspection;
	const rows: [string, string][] = [
		[
			"Video",
			escapeHtml(
				[
					i.codec,
					i.width && i.height ? `${i.width}x${i.height}` : "",
					i.frames ? `${i.frames.toLocaleString()} frames` : "",
					i.frameRate ? `${i.frameRate.toFixed(3)} fps` : "",
				]
					.filter(Boolean)
					.join(", "),
			),
		],
	];
	if (i.codec === "AV1" && i.frames !== null) {
		rows.push([
			"Film grain",
			i.entries
				? `${escapeHtml(`${i.entries.toLocaleString()} table ${i.entries === 1 ? "entry" : "entries"}`)}
					<button class="btn btn-ghost btn-sm" type="button" data-grain-action="download">Download table</button>`
				: '<span class="hdr-note">None</span>',
		]);
		if (i.luma !== null)
			rows.push([
				"Strength",
				escapeHtml(`luma ${i.luma} on average, ${i.lumaMax} at most, chroma ${i.chroma}`) + ' <span class="hdr-note">(0 to 255 scale)</span>',
			]);
	}
	if (i.findings.length) {
		const findings = i.findings
			.map(
				(finding) =>
					`<li class="hdr-finding-${finding.severity}"><span class="hdr-finding-severity">${escapeHtml(finding.severity)}</span>${escapeHtml(finding.message)}</li>`,
			)
			.join("");
		rows.push(["Problems", `<ul class="hdr-findings">${findings}</ul>`]);
	}
	if (!i.editable) rows.push(["Changes", `<span class="hdr-note">${escapeHtml(i.reason || "This video cannot be changed")}</span>`]);
	container.innerHTML = `<dl class="hdr-facts">${rows.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${value}</dd>`).join("")}</dl>`;
}

function option(value: string, label: string, selected: string): string {
	return `<option value="${value}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
}

function actionHint(): string {
	switch (form.action) {
		case "remove":
			return "The video plays without grain. The picture the encoder stored stays the same.";
		case "synthetic": {
			if (form.grainMode === "strength")
				return "A deviation on the 0 to 255 scale for the whole video. About 0.5 hides banding, from 1 on the grain is plainly visible.";
			const frame = inspection ? isoResolution(inspection.width, inspection.height) : null;
			return `Camera sensor noise at this ISO${frame ? ` for a ${frame.width}x${frame.height} frame` : " for each video's frame size"}, as aomenc and SVT-AV1 --photon-noise use it. ISO 200 to 600 hides banding at 1080p, and 4K needs about a quarter of the ISO for the same grain. It is weaker in shadows, as a sensor's is.`;
		}
		case "table":
			return "A table from regrain, aomenc or Download table. Its entries are matched to the video by time, so it must be made for this video or start at its first frame.";
		case "measure":
			return "regrain compares the original with this video and puts back the grain the encode lost. The original must have the same frames. A crop and a downscale are found on their own. Quick measures 30 seconds and gives the whole video that grain, Full video gives every scene its own.";
		default:
			return "";
	}
}

function renderActions(): void {
	const container = byId("grain-actions");
	const file = scope === "file";
	if ((file && (!inspection || !inspection.editable)) || (!file && !folderPath)) {
		container.innerHTML = "";
		updateQueueButton();
		return;
	}
	const hasGrain = file ? inspection!.entries > 0 : true;
	const actions = [
		option("keep", "Leave as it is", form.action),
		option("synthetic", hasGrain && file ? "Replace it with grain of a chosen strength" : "Add grain of a chosen strength", form.action),
		option("table", hasGrain && file ? "Replace it with a film grain table" : "Add a film grain table", form.action),
		// Every file needs its own original, so a folder cannot measure.
		...(file ? [option("measure", hasGrain ? "Replace it with grain measured from the original" : "Add grain measured from the original", form.action)] : []),
		...(hasGrain ? [option("remove", "Remove it", form.action)] : []),
	].join("");
	const fields =
		form.action === "synthetic"
			? `<div class="hdr-action-row">
				<select class="select-input" data-grain-field="grainMode">${option("iso", "ISO", form.grainMode)}${option("strength", "Deviation", form.grainMode)}</select>
				${
					form.grainMode === "iso"
						? `<label>ISO <input class="lang-filter-input" type="number" min="${MIN_GRAIN_ISO}" max="${MAX_GRAIN_ISO}" step="50" data-grain-field="iso" value="${form.iso}" /></label>`
						: `<label>Luma <input class="lang-filter-input" type="number" min="0.1" max="64" step="0.1" data-grain-field="strength" value="${form.strength}" /></label>`
				}
				<label>Chroma <input class="lang-filter-input" type="number" min="0" max="64" step="0.1" data-grain-field="chroma" value="${form.chroma}" /></label>
				<select class="select-input" data-grain-field="size">${option("fine", "Fine", form.size)}${option("medium", "Medium", form.size)}${option("coarse", "Coarse", form.size)}</select>
			</div>`
			: form.action === "table"
				? `<div class="hdr-action-row grain-option"><span>${
						form.uploadPath
							? escapeHtml(`${form.uploadName} (${form.uploadEntries.toLocaleString()} ${form.uploadEntries === 1 ? "entry" : "entries"})`)
							: '<span class="hdr-note">No table uploaded</span>'
					}</span>
					<button class="btn btn-ghost btn-sm" type="button" data-grain-action="upload">Upload table...</button></div>`
				: form.action === "measure"
					? `<div class="hdr-action-row grain-option"><span>${
							form.sourcePath
								? `<span title="${escapeHtml(form.sourcePath)}">${escapeHtml(fileName(form.sourcePath))}</span>`
								: '<span class="hdr-note">No original chosen</span>'
						}</span>
						<button class="btn btn-ghost btn-sm" type="button" data-grain-action="choose-source">Choose original...</button></div>
					<div class="hdr-action-row">
						<label>Measure <select class="select-input" data-grain-field="range">${option("representative", "Quick (30 s)", form.range)}${option("full", "Full video", form.range)}</select></label>
						<label>Scan <select class="select-input" data-grain-field="sampling">${option("all", "Every frame", form.sampling)}${option("half", "Half", form.sampling)}${option("quarter", "Quarter", form.sampling)}${option("eighth", "Eighth", form.sampling)}</select></label>
					</div>
					<div class="grain-option"><label class="toggle-label"><input type="checkbox" data-grain-field="justEnough"${form.justEnough ? " checked" : ""} />&nbsp;Just enough to hide banding</label></div>
					<div class="grain-option"><label class="toggle-label"><input type="checkbox" data-grain-field="measureChroma"${form.measureChroma ? " checked" : ""} />&nbsp;Measure chroma grain too</label></div>
					<div class="lang-filter-hint">Colour detail an encode loses counts as chroma grain, so only luma grain is measured unless the original has visible colour grain.</div>`
					: "";
	const staticToggle =
		form.action === "synthetic" || form.action === "table" || form.action === "measure"
			? `<div class="grain-option"><label class="toggle-label"><input type="checkbox" data-grain-field="staticGrain"${form.staticGrain ? " checked" : ""} />&nbsp;Static grain pattern</label></div>
			<div class="lang-filter-hint">Every frame of a table entry gets the same pattern, which stands still like texture on the screen instead of moving.</div>`
			: "";
	container.innerHTML = `
		<div class="setting-group">
			<label>Film grain</label>
			<select class="select-input" data-grain-field="action">${actions}</select>
			${fields}
			<div class="lang-filter-hint">${escapeHtml(actionHint())}</div>
			${staticToggle}
		</div>`;
	updateQueueButton();
}

function buildPlan(): Partial<GrainPlan> {
	const plan: Partial<GrainPlan> = { targetPath, action: form.action as GrainPlan["action"] };
	if (form.action === "synthetic")
		Object.assign(plan, form.grainMode === "iso" ? { iso: form.iso } : { strength: form.strength }, { size: form.size, chroma: form.chroma });
	if (form.action === "table") plan.tablePath = form.uploadPath;
	if (form.action === "measure")
		Object.assign(plan, {
			sourcePath: form.sourcePath,
			range: form.range,
			sampling: form.sampling,
			justEnough: form.justEnough,
			measureChroma: form.measureChroma,
		});
	if (form.action !== "remove" && form.staticGrain) plan.staticGrain = true;
	return plan;
}

function updateQueueButton(): void {
	const ready = scope === "file" ? !!inspection?.editable : !!folderPath;
	const actionReady =
		form.action === "synthetic"
			? form.grainMode === "iso"
				? grainIso(form.iso) > 0
				: form.strength > 0 && form.strength <= 64
			: form.action === "table"
				? !!form.uploadPath
				: form.action === "measure"
					? !!form.sourcePath
					: form.action === "remove";
	buttonById("grain-queue").disabled = !ready || !actionReady;
}

function renderScope(): void {
	renderRadioPills(
		byId("grain-scope"),
		["file", "folder"] as const,
		scope,
		(value) => {
			scope = value;
			setError("");
			setResult("");
			resetForm();
			render();
		},
		(value) => (value === "file" ? "One file" : "Every MKV in a folder"),
	);
}

function render(): void {
	byId("grain-file-choice").style.display = scope === "file" ? "" : "none";
	byId("grain-folder-choice").style.display = scope === "folder" ? "" : "none";
	byId("grain-target-selection").innerHTML = selection(targetPath, "No video selected");
	byId("grain-folder-selection").innerHTML = selection(folderPath, "No folder selected");
	renderInspection();
	renderActions();
}

/** Stops the inspection the server is running for this modal, if any. */
function stopInspection(): void {
	if (running?.status === "running") void cancelGrainInspection(running.id).catch(() => {});
	running = null;
}

async function inspectTarget(): Promise<void> {
	const run = ++inspectRun;
	stopInspection();
	inspection = null;
	setError("");
	render();
	try {
		const started = await startGrainInspection(targetPath);
		if (run !== inspectRun) {
			void cancelGrainInspection(started.id).catch(() => {});
			return;
		}
		running = started;
		while (running.status === "running") {
			renderInspection();
			await new Promise((resolve) => setTimeout(resolve, 500));
			if (run !== inspectRun) return;
			const state = await fetchGrainInspectRun(running.id);
			if (run !== inspectRun) return;
			running = state;
		}
		if (running.status !== "done" || !running.result) throw new Error(running.error || "Reading the film grain was cancelled");
		inspection = running.result;
		running = null;
		resetForm();
	} catch (error) {
		if (run !== inspectRun) return;
		running = null;
		setError(errorMessage(error));
		targetPath = "";
	}
	render();
}

export function openGrainTool(): void {
	byId("grain-modal").style.display = "";
	setResult("");
	renderScope();
	render();
}

export function closeGrainTool(): void {
	byId("grain-modal").style.display = "none";
	// An unfinished inspection stops, and the video is chosen again next time.
	if (running) {
		inspectRun++;
		stopInspection();
		targetPath = "";
	}
}

export function closeGrainToolIfOutside(event: MouseEvent): void {
	if (event.target === event.currentTarget) closeGrainTool();
}

export function chooseGrainTarget(): void {
	openHdrTargetPicker((path) => {
		targetPath = path;
		setResult("");
		void inspectTarget();
	});
}

export function chooseGrainFolder(): void {
	openRepairFolderPicker((path) => {
		folderPath = path;
		setResult("");
		render();
	});
}

export function handleGrainActionsChange(event: Event): void {
	const field = (event.target as HTMLElement).dataset?.grainField as keyof typeof form | undefined;
	if (!field) return;
	const input = event.target as HTMLInputElement | HTMLSelectElement;
	if (input instanceof HTMLInputElement && input.type === "checkbox") (form as Record<string, unknown>)[field] = input.checked;
	else if (input instanceof HTMLInputElement && input.type === "number") (form as Record<string, unknown>)[field] = Number(input.value);
	else (form as Record<string, unknown>)[field] = input.value;
	setError("");
	// The action and the grain mode change what the form shows, the other fields only their value.
	if (field === "action" || field === "grainMode") renderActions();
	else updateQueueButton();
}

export function handleGrainClick(event: MouseEvent): void {
	const button = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-grain-action]") : null;
	if (!button) return;
	if (button.dataset.grainAction === "upload") inputById("grain-upload-input").click();
	if (button.dataset.grainAction === "choose-source") {
		openHdrSourcePicker((path) => {
			form.sourcePath = path;
			setError("");
			renderActions();
		});
	}
	if (button.dataset.grainAction === "download") {
		setError("");
		downloadGrainTable(targetPath).catch((error) => setError(errorMessage(error)));
	}
}

export async function handleGrainUpload(): Promise<void> {
	const input = inputById("grain-upload-input");
	const file = input.files?.[0];
	input.value = "";
	if (!file) return;
	setError("");
	setResult(`Uploading ${file.name}...`);
	try {
		const uploaded = await uploadGrainTable(file);
		Object.assign(form, { uploadPath: uploaded.path, uploadName: file.name, uploadEntries: uploaded.entries });
		setResult(
			[
				uploaded.fixed ? `regrain corrected ${uploaded.fixed} ${uploaded.fixed === 1 ? "problem" : "problems"} in the table.` : "",
				uploaded.warnings ? `regrain check found ${uploaded.warnings} ${uploaded.warnings === 1 ? "warning" : "warnings"}.` : "",
			]
				.filter(Boolean)
				.join(" "),
		);
	} catch (error) {
		setResult("");
		setError(errorMessage(error));
	}
	renderActions();
}

export async function queueGrainChanges(): Promise<void> {
	const button = buttonById("grain-queue");
	button.disabled = true;
	setError("");
	try {
		if (scope === "file") {
			await createGrainJob(buildPlan() as GrainPlan);
			closeGrainTool();
			targetPath = "";
			inspection = null;
		} else {
			const { targetPath: _, ...plan } = buildPlan();
			const result = await createGrainBatch({
				folder: folderPath,
				recursive: inputById("grain-recursive").checked,
				plan: { ...plan, skipExisting: inputById("grain-skip-existing").checked },
			});
			setResult(
				`Queued ${result.jobIds.length} ${result.jobIds.length === 1 ? "file" : "files"}${result.skipped.length ? `, ${result.skipped.length} already have an unfinished job` : ""}.`,
			);
		}
		await update();
	} catch (error) {
		setError(errorMessage(error));
	}
	updateQueueButton();
}
