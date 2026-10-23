import type { HdrInspection, HdrMasteringPrimaries, HdrPlan, HdrPlusAction, HdrStaticAction } from "../types";
import { createHdrBatch, createHdrJob, fetchHdrInspection, uploadHdrMetadata } from "../api/client";
import { buttonById, byId, inputById } from "../shared/dom";
import { errorMessage } from "../shared/errors";
import { openHdrSourcePicker, openHdrTargetPicker, openRepairFolderPicker } from "./repair";
import { renderRadioPills } from "./settings-controls";
import { update } from "./polling";

type Scope = "file" | "folder";
type LightSource = "keep" | "hdr10plus" | "manual";

let scope: Scope = "file";
let targetPath = "";
let folderPath = "";
let inspection: HdrInspection | null = null;
/** Bumped on every new inspection, so a late answer for another file is dropped. */
let inspectRun = 0;

const form = {
	hdr10Plus: "keep" as HdrPlusAction,
	sourcePath: "",
	uploadPath: "",
	uploadName: "",
	uploadFrames: 0,
	removeDolbyVision: false,
	staticMetadata: "keep" as HdrStaticAction,
	masteringPrimaries: "bt2020" as HdrMasteringPrimaries,
	masteringMaxNits: 1000,
	masteringMinNits: 0.0001,
	light: "keep" as LightSource,
	maxCll: 1000,
	maxFall: 400,
	fixColor: false,
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
	const error = byId("hdr-error");
	error.textContent = message;
	error.style.display = message ? "" : "none";
}

function setResult(message: string): void {
	byId("hdr-result").textContent = message;
}

function selection(path: string, empty: string): string {
	return path
		? `<span class="repair-file-name" title="${escapeHtml(path)}">${escapeHtml(fileName(path))}</span><span class="repair-file-folder">${escapeHtml(path)}</span>`
		: `<span class="repair-file-empty">${escapeHtml(empty)}</span>`;
}

function resetForm(): void {
	Object.assign(form, {
		hdr10Plus: "keep",
		sourcePath: "",
		uploadPath: "",
		uploadName: "",
		uploadFrames: 0,
		removeDolbyVision: false,
		staticMetadata: "keep",
		light: "keep",
		fixColor: false,
	});
	const mastering = inspection?.masteringDisplay;
	form.masteringPrimaries = mastering?.primaries === "Display P3" ? "p3" : "bt2020";
	form.masteringMaxNits = mastering?.maxNits || 1000;
	form.masteringMinNits = mastering?.minNits ?? 0.0001;
	form.maxCll = inspection?.contentLight?.maxCll ?? inspection?.hdr10PlusMaxCll ?? 1000;
	form.maxFall = inspection?.contentLight?.maxFall ?? inspection?.hdr10PlusMaxFall ?? 400;
	// A file with Dolby Vision cannot keep it, so removing it is chosen for the user.
	if (inspection?.dolbyVision) form.removeDolbyVision = true;
}

function renderInspection(): void {
	const container = byId("hdr-inspection");
	if (scope !== "file" || !targetPath) {
		container.innerHTML = "";
		return;
	}
	if (!inspection) {
		container.innerHTML = '<div class="library-loading">Reading the video...</div>';
		return;
	}
	const i = inspection;
	const rows: [string, string][] = [
		["Formats", escapeHtml(i.formats.join(", ") || "SDR")],
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
		["Colour", `${escapeHtml(i.colorDescription)}${i.untagged ? ' <span class="hdr-note">(no transfer tag)</span>' : ""}`],
		[
			"Mastering display",
			i.masteringDisplay
				? escapeHtml(`${i.masteringDisplay.primaries}, ${i.masteringDisplay.minNits} to ${i.masteringDisplay.maxNits} cd/m²`)
				: '<span class="hdr-note">None</span>',
		],
		["MaxCLL / MaxFALL", i.contentLight ? escapeHtml(`${i.contentLight.maxCll} / ${i.contentLight.maxFall} cd/m²`) : '<span class="hdr-note">None</span>'],
		[
			"HDR10+",
			i.hdr10PlusFrames
				? escapeHtml(
						[
							`${i.hdr10PlusFrames.toLocaleString()} of ${(i.frames ?? 0).toLocaleString()} frames`,
							i.hdr10PlusScenes !== null ? `${i.hdr10PlusScenes} scenes` : "",
							i.hdr10PlusMaxCll !== null ? `peak ${i.hdr10PlusMaxCll} cd/m²` : "",
						]
							.filter(Boolean)
							.join(", "),
					)
				: '<span class="hdr-note">None</span>',
		],
		["Dolby Vision", i.dolbyVision ? "Yes" : '<span class="hdr-note">None</span>'],
	];
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

function hdr10PlusHint(): string {
	switch (form.hdr10Plus) {
		case "measure":
			return "retone decodes the video and measures every scene. A 4K film takes about as long as playing it at a few times its speed.";
		case "dolby-vision":
			return "The scenes follow the shots of the original's Dolby Vision metadata, and the values are measured from this video. The original must have the same frames.";
		case "file":
			return "HDR10+ JSON from hdr10plus_tool, retone or Rabbit, or an AV1 video that carries HDR10+. It must have one entry per frame of this video.";
		case "remove":
			return "Displays fall back to HDR10 and tone map the whole video the same way.";
		default:
			return "";
	}
}

function renderActions(): void {
	const container = byId("hdr-actions");
	const file = scope === "file";
	if ((file && (!inspection || !inspection.editable)) || (!file && !folderPath)) {
		container.innerHTML = "";
		updateQueueButton();
		return;
	}
	const hasDolbyVision = file ? inspection!.dolbyVision : true;
	const canTag = file ? inspection!.untagged : true;
	const plusOptions = [
		option("keep", file && inspection!.hdr10PlusFrames ? "Keep as it is" : "Leave as it is", form.hdr10Plus),
		option("measure", file ? "Measure it from this video" : "Measure it for every file", form.hdr10Plus),
		...(file
			? [
					option("dolby-vision", "Measure it with the scenes of a Dolby Vision original", form.hdr10Plus),
					option("file", "Import it from a file", form.hdr10Plus),
				]
			: []),
		option("remove", "Remove it", form.hdr10Plus),
	].join("");
	const source =
		form.hdr10Plus === "dolby-vision"
			? `<div class="hdr-action-row"><span>${form.sourcePath ? escapeHtml(fileName(form.sourcePath)) : '<span class="hdr-note">No original chosen</span>'}</span>
				<button class="btn btn-ghost btn-sm" type="button" data-hdr-action="choose-source">Choose original...</button></div>`
			: form.hdr10Plus === "file"
				? `<div class="hdr-action-row"><span>${
						form.uploadPath
							? escapeHtml(`${form.uploadName} (${form.uploadFrames.toLocaleString()} frames)`)
							: form.sourcePath
								? escapeHtml(fileName(form.sourcePath))
								: '<span class="hdr-note">Nothing chosen</span>'
					}</span>
					<button class="btn btn-ghost btn-sm" type="button" data-hdr-action="upload">Upload JSON...</button>
					<button class="btn btn-ghost btn-sm" type="button" data-hdr-action="choose-source">Choose AV1 video...</button></div>`
				: "";
	const staticFields =
		form.staticMetadata === "set"
			? `<div class="hdr-action-row">
				<select class="select-input" data-hdr-field="masteringPrimaries">${option("bt2020", "BT.2020", form.masteringPrimaries)}${option("p3", "Display P3", form.masteringPrimaries)}</select>
				<label>Max <input class="lang-filter-input" type="number" min="1" max="10000" step="1" data-hdr-field="masteringMaxNits" value="${form.masteringMaxNits}" /> cd/m²</label>
				<label>Min <input class="lang-filter-input" type="number" min="0" max="50" step="0.0001" data-hdr-field="masteringMinNits" value="${form.masteringMinNits}" /> cd/m²</label>
			</div>
			<div class="hdr-action-row">
				<span>MaxCLL and MaxFALL</span>
				<select class="select-input" data-hdr-field="light">${option("keep", "Leave as they are", form.light)}${option("hdr10plus", "From the HDR10+ metadata", form.light)}${option("manual", "Enter them", form.light)}</select>
				${
					form.light === "manual"
						? `<input class="lang-filter-input" type="number" min="0" max="65535" step="1" data-hdr-field="maxCll" value="${form.maxCll}" title="MaxCLL" />
					<input class="lang-filter-input" type="number" min="0" max="65535" step="1" data-hdr-field="maxFall" value="${form.maxFall}" title="MaxFALL" />`
						: ""
				}
			</div>`
			: "";
	container.innerHTML = `
		<div class="setting-group">
			<label>HDR10+</label>
			<select class="select-input" data-hdr-field="hdr10Plus">${plusOptions}</select>
			${source}
			<div class="lang-filter-hint">${escapeHtml(hdr10PlusHint())}</div>
		</div>
		${
			hasDolbyVision
				? `<div class="setting-group">
			<label>Dolby Vision</label>
			<label class="toggle-label"><input type="checkbox" data-hdr-field="removeDolbyVision"${form.removeDolbyVision ? " checked" : ""} />&nbsp;Remove Dolby Vision metadata</label>
			<div class="lang-filter-hint">${
				file
					? "The MKV keeps Dolby Vision's configuration on the video track, which a change to the video would break. Remove it to change anything else, which leaves HDR10."
					: "Files with Dolby Vision can only be changed when it is removed. Others are not affected."
			}</div>
		</div>`
				: ""
		}
		<div class="setting-group">
			<label>HDR10 static metadata</label>
			<select class="select-input" data-hdr-field="staticMetadata">${option("keep", "Leave as it is", form.staticMetadata)}${option("set", "Set the mastering display and light levels", form.staticMetadata)}${option("remove", "Remove it", form.staticMetadata)}</select>
			${staticFields}
			<div class="lang-filter-hint">Written into the AV1 stream and the MKV colour elements, so every player sees the same values.</div>
		</div>
		${
			canTag
				? `<div class="setting-group">
			<label>Colour tags</label>
			<label class="toggle-label"><input type="checkbox" data-hdr-field="fixColor"${form.fixColor ? " checked" : ""} />&nbsp;${file ? "Tag the video as BT.2020 PQ" : "Tag files without a transfer tag as BT.2020 PQ"}</label>
			<div class="lang-filter-hint">Only for PQ video whose encoder left out the tags. Video tagged as SDR is never retagged, it would look washed out.</div>
		</div>`
				: ""
		}`;
	updateQueueButton();
}

function buildPlan(): Partial<HdrPlan> {
	const plan: Partial<HdrPlan> = {
		targetPath,
		hdr10Plus: form.hdr10Plus,
		removeDolbyVision: form.removeDolbyVision,
		staticMetadata: form.staticMetadata,
		fixColor: form.fixColor,
	};
	if (form.hdr10Plus === "dolby-vision" && form.sourcePath) plan.sourcePath = form.sourcePath;
	if (form.hdr10Plus === "file") {
		if (form.uploadPath) plan.metadataPath = form.uploadPath;
		else if (form.sourcePath) plan.sourcePath = form.sourcePath;
	}
	if (form.staticMetadata === "set") {
		Object.assign(plan, { masteringPrimaries: form.masteringPrimaries, masteringMaxNits: form.masteringMaxNits, masteringMinNits: form.masteringMinNits });
		if (form.light === "hdr10plus") plan.lightFromHdr10Plus = true;
		if (form.light === "manual") Object.assign(plan, { maxCll: form.maxCll, maxFall: form.maxFall });
	}
	return plan;
}

function hasChange(): boolean {
	return form.hdr10Plus !== "keep" || form.staticMetadata !== "keep" || form.removeDolbyVision || form.fixColor;
}

function updateQueueButton(): void {
	const ready = scope === "file" ? !!inspection?.editable : !!folderPath;
	const sourceReady = form.hdr10Plus === "dolby-vision" ? !!form.sourcePath : form.hdr10Plus === "file" ? !!(form.uploadPath || form.sourcePath) : true;
	buttonById("hdr-queue").disabled = !ready || !hasChange() || !sourceReady;
}

function renderScope(): void {
	renderRadioPills(
		byId("hdr-scope"),
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
	byId("hdr-file-choice").style.display = scope === "file" ? "" : "none";
	byId("hdr-folder-choice").style.display = scope === "folder" ? "" : "none";
	byId("hdr-target-selection").innerHTML = selection(targetPath, "No video selected");
	byId("hdr-folder-selection").innerHTML = selection(folderPath, "No folder selected");
	renderInspection();
	renderActions();
}

async function inspectTarget(): Promise<void> {
	const run = ++inspectRun;
	inspection = null;
	setError("");
	render();
	try {
		const result = await fetchHdrInspection(targetPath);
		if (run !== inspectRun) return;
		inspection = result;
		resetForm();
	} catch (error) {
		if (run !== inspectRun) return;
		setError(errorMessage(error));
		targetPath = "";
	}
	render();
}

export function openHdrTool(): void {
	byId("hdr-modal").style.display = "";
	setResult("");
	renderScope();
	render();
}

export function closeHdrTool(): void {
	byId("hdr-modal").style.display = "none";
}

export function closeHdrToolIfOutside(event: MouseEvent): void {
	if (event.target === event.currentTarget) closeHdrTool();
}

export function chooseHdrTarget(): void {
	openHdrTargetPicker((path) => {
		targetPath = path;
		setResult("");
		void inspectTarget();
	});
}

export function chooseHdrFolder(): void {
	openRepairFolderPicker((path) => {
		folderPath = path;
		setResult("");
		render();
	});
}

export function handleHdrActionsChange(event: Event): void {
	const field = (event.target as HTMLElement).dataset?.hdrField as keyof typeof form | undefined;
	if (!field) return;
	const input = event.target as HTMLInputElement | HTMLSelectElement;
	if (input instanceof HTMLInputElement && input.type === "checkbox") (form as Record<string, unknown>)[field] = input.checked;
	else if (input instanceof HTMLInputElement && input.type === "number") (form as Record<string, unknown>)[field] = Number(input.value);
	else (form as Record<string, unknown>)[field] = input.value;
	setError("");
	// Selects change what the form shows, number fields only their value.
	if (input instanceof HTMLSelectElement || input.type === "checkbox") renderActions();
	else updateQueueButton();
}

export function handleHdrActionsClick(event: MouseEvent): void {
	const button = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-hdr-action]") : null;
	if (!button) return;
	if (button.dataset.hdrAction === "choose-source") {
		openHdrSourcePicker((path) => {
			form.sourcePath = path;
			form.uploadPath = "";
			renderActions();
		});
	}
	if (button.dataset.hdrAction === "upload") inputById("hdr-upload-input").click();
}

export async function handleHdrUpload(): Promise<void> {
	const input = inputById("hdr-upload-input");
	const file = input.files?.[0];
	input.value = "";
	if (!file) return;
	setError("");
	setResult(`Uploading ${file.name}...`);
	try {
		const uploaded = await uploadHdrMetadata(file);
		Object.assign(form, { uploadPath: uploaded.path, uploadName: file.name, uploadFrames: uploaded.frames, sourcePath: "" });
		setResult("");
		if (inspection?.frames && uploaded.frames !== inspection.frames)
			setError(`The file has metadata for ${uploaded.frames.toLocaleString()} frames, and the video has ${inspection.frames.toLocaleString()}.`);
	} catch (error) {
		setResult("");
		setError(errorMessage(error));
	}
	renderActions();
}

export async function queueHdrChanges(): Promise<void> {
	const button = buttonById("hdr-queue");
	button.disabled = true;
	setError("");
	try {
		if (scope === "file") {
			await createHdrJob(buildPlan() as HdrPlan);
			closeHdrTool();
			targetPath = "";
			inspection = null;
		} else {
			const { targetPath: _, ...plan } = buildPlan();
			const result = await createHdrBatch({
				folder: folderPath,
				recursive: inputById("hdr-recursive").checked,
				plan: { ...plan, skipExisting: inputById("hdr-skip-existing").checked },
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
