import type { FontCheckMissing, FontCheckProgress, FontCheckResult, SubtitleFileFontSource } from "../types";
import { cancelFontCheck, createFontCheckJobs, fetchFontCheck, startFontCheck, uploadSubtitleFont } from "../api/client";
import { buttonById, byId, inputById } from "../shared/dom";
import { errorMessage } from "../shared/errors";
import { openRepairFolderPicker } from "./repair";
import { update } from "./polling";

/** How a missing font is fixed: an uploaded font named like it, or another font the subtitles point at instead. */
type Fix = { kind: "upload" } | { kind: "map"; to: string };

let folder = "";
let scanId = "";
let progress: FontCheckProgress | null = null;
let result: FontCheckResult | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let queueing = false;
const uploads = new Map<string, SubtitleFileFontSource>();
const fixes = new Map<string, Fix>();

const escapeHtml = (value: unknown): string =>
	String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");

const fileName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const normalize = (name: string): string => name.trim().toLowerCase().replace(/^@/, "");
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const scanning = () => !!progress && !progress.result && !progress.error;

function setError(message: string): void {
	const error = byId("fontcheck-error");
	error.textContent = message;
	error.style.display = message ? "" : "none";
}

/** Fonts a mapping can point at: the ones the videos carry, then uploaded ones. */
function mapTargets(except: string): { family: string; label: string }[] {
	const total = result?.files.length ?? 0;
	const carried = (result?.families ?? []).map((f) => ({ family: f.family, label: `${f.family} (in ${f.files} of ${total})` }));
	const uploaded = [...uploads.entries()]
		.filter(([key]) => key !== except)
		.map(([, font]) => font.family)
		.filter((family) => !carried.some((c) => normalize(c.family) === normalize(family)))
		.map((family) => ({ family, label: `${family} (uploaded)` }));
	return [...carried, ...uploaded];
}

/** The videos the chosen fixes reach, and the ones a mapping cannot, as the server will plan them. */
function reach(): { files: number; unreachable: number } {
	if (!result) return { files: 0, unreachable: 0 };
	const uploadedFamilies = new Set([...uploads.values()].map((font) => normalize(font.family)));
	let files = 0;
	let unreachable = 0;
	for (const file of result.files) {
		if (file.error) continue;
		const families = new Set(file.families.map(normalize));
		let fixed = false;
		for (const key of file.missing) {
			const fix = fixes.get(key);
			if (fix?.kind === "upload") fixed = true;
			else if (fix?.kind === "map") {
				if (families.has(normalize(fix.to)) || uploadedFamilies.has(normalize(fix.to))) fixed = true;
				else unreachable++;
			}
		}
		if (fixed) files++;
	}
	return { files, unreachable };
}

function renderFolder(): void {
	byId("fontcheck-selection").innerHTML = folder
		? `<span class="repair-file-name" title="${escapeHtml(folder)}">${escapeHtml(fileName(folder))}</span><span class="repair-file-folder">${escapeHtml(folder)}</span>`
		: '<span class="repair-file-empty">No folder selected</span>';
	const scan = buttonById("fontcheck-scan-btn");
	scan.disabled = !folder || queueing;
	scan.textContent = scanning() ? "Cancel" : result ? "Check again" : "Check fonts";
	inputById("fontcheck-recursive").disabled = scanning();
}

function renderProgress(): void {
	const line = byId("fontcheck-progress");
	if (scanning()) line.textContent = `Reading subtitles, ${progress!.done} of ${progress!.total}${progress!.current ? `: ${progress!.current}` : ""}`;
	else if (!result) line.textContent = "Every subtitle line is read, so each video is read from disk once.";
	else line.textContent = "";
}

function fixSelect(font: FontCheckMissing): string {
	const fix = fixes.get(font.key);
	const value = fix?.kind === "upload" ? "upload" : fix?.kind === "map" ? `map:${fix.to}` : "";
	const options = [
		`<option value="">Leave missing</option>`,
		...(uploads.has(font.key) ? [`<option value="upload">Attach the uploaded font</option>`] : []),
		...mapTargets(font.key).map((t) => `<option value="map:${escapeHtml(t.family)}">Use ${escapeHtml(t.label)}</option>`),
	];
	return `<select class="select-input" data-fontcheck-fix="${escapeHtml(font.key)}" ${queueing ? "disabled" : ""}>${options
		.map((option) => (option.includes(`value="${escapeHtml(value)}"`) ? option.replace("<option", "<option selected") : option))
		.join("")}</select>`;
}

function fontRow(font: FontCheckMissing): string {
	const upload = uploads.get(font.key);
	const total = result?.files.length ?? 0;
	const fixed = fixes.has(font.key);
	const detail = upload
		? `<small class="is-ok">Uploaded ${escapeHtml(upload.fileName)}${upload.renamedFrom ? `, renamed from ${escapeHtml(upload.renamedFrom)}` : ""}</small>`
		: font.windows
			? '<small title="Players on Windows have it. TVs, phones and Linux often do not.">Comes with Windows</small>'
			: "";
	return `<div class="subfiles-font${fixed ? "" : " is-missing"}">
		<span class="subfiles-font-name" style="font-family: ${escapeHtml(JSON.stringify(font.name))}, var(--font-body)">${escapeHtml(font.name)}</span>
		<span class="subfiles-font-used">${font.files === total ? "every video" : plural(font.files, "video")}</span>
		<span class="fontcheck-fix">${fixSelect(font)}</span>
		${detail}
		<span class="subfiles-font-actions">
			<label class="btn btn-ghost btn-sm${queueing ? " is-disabled" : ""}">${upload ? "Replace..." : "Upload..."}<input type="file" accept=".ttf,.otf,.ttc,.otc" data-fontcheck-upload="${escapeHtml(font.key)}" hidden ${queueing ? "disabled" : ""}></label>
		</span>
	</div>`;
}

function renderResults(): void {
	const container = byId("fontcheck-results");
	if (!result) {
		container.innerHTML = "";
		byId("fontcheck-summary").textContent = "";
		renderQueueButton();
		return;
	}
	const unreadable = result.files.filter((file) => file.error);
	const lacking = result.files.filter((file) => file.missing.length);
	const parts = [
		plural(result.files.length, "video"),
		result.missing.length ? `${plural(result.missing.length, "font")} missing in ${plural(lacking.length, "video")}` : "No fonts missing",
	];
	if (unreadable.length) parts.push(`${unreadable.length} could not be read`);
	byId("fontcheck-summary").innerHTML = parts
		.map((part, i) => `<span class="${i === 1 ? (result!.missing.length ? "has-outliers" : "all-matching") : ""}">${escapeHtml(part)}</span>`)
		.join("");
	const { unreachable } = reach();
	container.innerHTML = `${
		result.missing.length
			? `<p class="subfiles-font-warning">Players draw text whose font the video does not carry in another font, so signs, songs and styled lines lose their look. Upload the font, or point the subtitles at a font the videos have, such as the dialogue font. An uploaded font with another name is renamed to the missing one. Pointing at another font rewrites the font names in the subtitles and remuxes the video. An upload alone is attached without a remux.</p>
			<div class="fontcheck-bulk">
				<label>Every font left missing
					<select class="select-input" id="fontcheck-bulk-target" ${queueing ? "disabled" : ""}>${mapTargets("")
						.map((t) => `<option value="${escapeHtml(t.family)}">Use ${escapeHtml(t.label)}</option>`)
						.join("")}</select>
				</label>
				<button class="btn btn-ghost btn-sm" type="button" data-fontcheck-bulk ${queueing || !mapTargets("").length ? "disabled" : ""}>Apply</button>
			</div>
			<div class="subfiles-font-list">${result.missing.map(fontRow).join("")}</div>
			${unreachable ? `<div class="repair-pair-warning">${plural(unreachable, "video")} lack${unreachable === 1 ? "s" : ""} the font a missing font is pointed at, so ${unreachable === 1 ? "it stays" : "they stay"} as ${unreachable === 1 ? "it is" : "they are"} for that font.</div>` : ""}`
			: '<div class="repair-audit-match">Every font the subtitles use is attached to its video.</div>'
	}
	${unreadable.length ? `<details class="fontcheck-unreadable"><summary>${plural(unreadable.length, "video")} could not be read</summary><ul>${unreadable.map((file) => `<li><strong>${escapeHtml(file.fileName)}</strong> ${escapeHtml(file.error)}</li>`).join("")}</ul></details>` : ""}`;
	renderQueueButton();
}

function renderQueueButton(): void {
	const { files } = reach();
	const button = buttonById("fontcheck-queue-btn");
	button.textContent = queueing ? "Queueing..." : files ? `Fix ${plural(files, "video")}` : "Fix fonts";
	button.disabled = queueing || !files;
}

function render(): void {
	renderFolder();
	renderProgress();
	renderResults();
}

function stopPolling(): void {
	if (pollTimer) clearTimeout(pollTimer);
	pollTimer = null;
}

async function poll(): Promise<void> {
	if (!scanId) return;
	try {
		progress = await fetchFontCheck(scanId);
		if (progress.result) result = progress.result;
		if (progress.error) setError(progress.error);
	} catch (error) {
		progress = null;
		setError(errorMessage(error));
	}
	render();
	if (scanning()) pollTimer = setTimeout(() => void poll(), 800);
}

function reset(): void {
	stopPolling();
	if (scanning() && scanId) void cancelFontCheck(scanId).catch(() => {});
	scanId = "";
	progress = null;
	result = null;
	uploads.clear();
	fixes.clear();
}

export function openFontCheck(): void {
	setError("");
	render();
	byId("fontcheck-modal").style.display = "";
	if (scanning()) void poll();
}

export function closeFontCheck(): void {
	stopPolling();
	byId("fontcheck-modal").style.display = "none";
}

export function closeFontCheckIfOutside(event: MouseEvent): void {
	if (event.target === byId("fontcheck-modal")) closeFontCheck();
}

export function pickFontCheckFolder(): void {
	openRepairFolderPicker((path) => {
		reset();
		folder = path;
		setError("");
		render();
	}, "Choose the folder to check");
}

export async function toggleFontCheckScan(): Promise<void> {
	if (scanning()) {
		const id = scanId;
		reset();
		render();
		await cancelFontCheck(id).catch(() => {});
		return;
	}
	if (!folder) return;
	const keepFolder = folder;
	reset();
	folder = keepFolder;
	setError("");
	try {
		progress = await startFontCheck({ folder, recursive: inputById("fontcheck-recursive").checked });
		scanId = progress.id;
		render();
		void poll();
	} catch (error) {
		setError(errorMessage(error));
		render();
	}
}

async function upload(key: string, file: File): Promise<void> {
	const font = result?.missing.find((m) => m.key === key);
	if (!font) return;
	setError("");
	try {
		uploads.set(key, await uploadSubtitleFont(file, font.name));
		fixes.set(key, { kind: "upload" });
	} catch (error) {
		setError(errorMessage(error));
	}
	renderResults();
}

export function handleFontCheckChange(event: Event): void {
	const target = event.target;
	if (queueing) return;
	if (target instanceof HTMLSelectElement && target.dataset.fontcheckFix !== undefined) {
		const key = target.dataset.fontcheckFix;
		if (!target.value) fixes.delete(key);
		else if (target.value === "upload") fixes.set(key, { kind: "upload" });
		else fixes.set(key, { kind: "map", to: target.value.slice(4) });
		renderResults();
	} else if (target instanceof HTMLInputElement && target.dataset.fontcheckUpload !== undefined && target.files?.[0]) {
		void upload(target.dataset.fontcheckUpload, target.files[0]);
	}
}

export function handleFontCheckClick(event: MouseEvent): void {
	const bulk = event.target instanceof Element ? event.target.closest("[data-fontcheck-bulk]") : null;
	if (!bulk || queueing || !result) return;
	const to = (byId("fontcheck-bulk-target") as HTMLSelectElement).value;
	if (!to) return;
	for (const font of result.missing) if (!fixes.has(font.key) && normalize(font.name) !== normalize(to)) fixes.set(font.key, { kind: "map", to });
	renderResults();
}

export async function queueFontCheckFixes(): Promise<void> {
	if (!result || !scanId || queueing) return;
	const chosen = [...fixes.entries()];
	const request = {
		scanId,
		uploads: chosen.filter(([, fix]) => fix.kind === "upload").map(([key]) => ({ key, path: uploads.get(key)!.path })),
		maps: chosen.flatMap(([key, fix]) => (fix.kind === "map" ? [{ key, to: fix.to }] : [])),
		replaceTarget: (byId("fontcheck-save-mode") as HTMLSelectElement).value === "existing",
	};
	// An upload a mapping points at travels with it.
	for (const map of request.maps) {
		const upload = [...uploads.entries()].find(([, font]) => normalize(font.family) === normalize(map.to));
		if (upload && !request.uploads.some((u) => u.key === upload[0])) request.uploads.push({ key: upload[0], path: upload[1].path });
	}
	setError("");
	queueing = true;
	render();
	try {
		const queued = await createFontCheckJobs(request);
		const note = queued.unreachable.length
			? ` ${plural(queued.unreachable.length, "video")} kept a missing font, as it lacks the font that was chosen instead.`
			: "";
		byId("fontcheck-summary").textContent =
			`Queued ${queued.jobIds.length} font fix${queued.jobIds.length === 1 ? "" : "es"}. Follow their progress in the job list, then check the folder again.${note}`;
		result = null;
		fixes.clear();
		uploads.clear();
		void update().catch(() => {});
	} catch (error) {
		setError(errorMessage(error));
	} finally {
		queueing = false;
		renderFolder();
		renderProgress();
		if (result) renderResults();
		else {
			byId("fontcheck-results").innerHTML = "";
			renderQueueButton();
		}
	}
}
