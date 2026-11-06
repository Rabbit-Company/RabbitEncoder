import type { FontCheckMissing, FontCheckProgress, FontCheckResult, SubtitleFileFontSource } from "../types";
import { cancelFontCheck, createFontCheckJobs, fetchFontCheck, fetchFonts, startFontCheck, uploadLibraryFont, uploadSubtitleFont } from "../api/client";
import { buttonById, byId, inputById } from "../shared/dom";
import { errorMessage } from "../shared/errors";
import { openMkvVideosPicker, openRepairFolderPicker } from "./repair";
import { update } from "./polling";

/** How a missing font is fixed: an uploaded or library font named like it, or another font the subtitles point at instead. */
type Fix = { kind: "upload" } | { kind: "library"; family: string } | { kind: "map"; to: string };

/** A family of the font library, with every name its faces answer to and their size together. */
interface LibraryFamily {
	family: string;
	names: Set<string>;
	size: number;
}

const CLOSEST = "__closest__";

/** A folder to check, or the videos chosen one by one. Only one of them is set. */
let folder = "";
let videos: string[] = [];
let scanId = "";
let progress: FontCheckProgress | null = null;
let result: FontCheckResult | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let queueing = false;
let library: LibraryFamily[] = [];
let addingToLibrary = false;
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
const size = (bytes: number) => (bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

async function loadLibrary(): Promise<void> {
	const families = new Map<string, LibraryFamily>();
	for (const group of await fetchFonts()) {
		for (const face of group.faces ?? []) {
			const key = normalize(face.family);
			const entry = families.get(key) ?? { family: face.family, names: new Set<string>(), size: 0 };
			for (const name of face.names ?? []) entry.names.add(name);
			entry.names.add(key);
			entry.size += face.size ?? 0;
			families.set(key, entry);
		}
	}
	library = [...families.values()].sort((a, b) => a.family.localeCompare(b.family));
}

/** The library family that already has the missing font's name, so it is attached as it is. */
const libraryMatch = (key: string) => library.find((family) => family.names.has(key));

function setError(message: string): void {
	const error = byId("fontcheck-error");
	error.textContent = message;
	error.style.display = message ? "" : "none";
}

interface Target {
	family: string;
	label: string;
}

/**
 * Fonts a mapping can point at, in three groups. The ones the videos carry
 * cost no space. Library and uploaded fonts are attached to the videos that
 * lack them.
 */
function mapTargets(except: string, closest?: string): { carried: Target[]; library: Target[]; uploaded: Target[] } {
	const total = result?.files.length ?? 0;
	const taken = new Set([except]);
	const carried = (result?.families ?? [])
		.filter((f) => normalize(f.family) !== except)
		.map((f) => {
			taken.add(normalize(f.family));
			const where = f.files === total ? "in every video" : `in ${f.files} of ${total}`;
			return { family: f.family, label: `${f.family} (${where}${f.family === closest ? ", closest" : ""})` };
		})
		.sort((a, b) => Number(b.family === closest) - Number(a.family === closest));
	const uploaded: Target[] = [];
	for (const [key, font] of uploads) {
		if (key === except || taken.has(normalize(font.family))) continue;
		taken.add(normalize(font.family));
		uploaded.push({ family: font.family, label: `${font.family} (uploaded, attached)` });
	}
	// Smallest first, as each one is attached to every video that lacks it.
	const fromLibrary = library
		.filter((family) => !taken.has(normalize(family.family)))
		.sort((a, b) => a.size - b.size)
		.map((family) => ({ family: family.family, label: `${family.family} (attached, +${size(family.size)})` }));
	return { carried, library: fromLibrary, uploaded };
}

function targetOptions(targets: ReturnType<typeof mapTargets>, value: (family: string) => string): string {
	const group = (label: string, list: Target[]) =>
		list.length
			? `<optgroup label="${escapeHtml(label)}">${list.map((t) => `<option value="${escapeHtml(value(t.family))}">Use ${escapeHtml(t.label)}</option>`).join("")}</optgroup>`
			: "";
	return group("Already in the videos, no extra size", targets.carried) + group("From the font library", targets.library) + group("Uploaded", targets.uploaded);
}

/** The videos the chosen fixes reach, and the ones a mapping cannot, as the server will plan them. */
function reach(): { files: number; unreachable: number } {
	if (!result) return { files: 0, unreachable: 0 };
	const brought = new Set([...[...uploads.values()].map((font) => font.family), ...library.map((family) => family.family)].map(normalize));
	let files = 0;
	let unreachable = 0;
	for (const file of result.files) {
		if (file.error) continue;
		const families = new Set(file.families.map(normalize));
		let fixed = false;
		for (const key of file.missing) {
			const fix = fixes.get(key);
			if (fix?.kind === "upload" || fix?.kind === "library") fixed = true;
			else if (fix?.kind === "map") {
				if (families.has(normalize(fix.to)) || brought.has(normalize(fix.to))) fixed = true;
				else unreachable++;
			}
		}
		if (fixed) files++;
	}
	return { files, unreachable };
}

const folderOf = (path: string): string => path.slice(0, path.lastIndexOf("/"));

function selectionHtml(): string {
	const named = (name: string, title: string, where: string) =>
		`<span class="repair-file-name" title="${escapeHtml(title)}">${escapeHtml(name)}</span><span class="repair-file-folder">${escapeHtml(where)}</span>`;
	if (folder) return named(fileName(folder), folder, folder);
	if (videos.length === 1) return named(fileName(videos[0]!), videos[0]!, folderOf(videos[0]!));
	if (videos.length) {
		const folders = [...new Set(videos.map(folderOf))];
		return named(`${videos.length} videos`, videos.map(fileName).join("\n"), folders.length === 1 ? folders[0]! : `${folders.length} folders`);
	}
	return '<span class="repair-file-empty">No folder or videos selected</span>';
}

function renderFolder(): void {
	byId("fontcheck-selection").innerHTML = selectionHtml();
	byId("fontcheck-pick-videos-btn").textContent = videos.length ? "Change videos..." : "Choose videos...";
	const scan = buttonById("fontcheck-scan-btn");
	scan.disabled = !(folder || videos.length) || queueing;
	scan.textContent = scanning() ? "Cancel" : result ? "Check again" : "Check fonts";
	// Subfolders only mean something for a folder.
	const recursive = inputById("fontcheck-recursive");
	recursive.disabled = scanning();
	recursive.closest("label")!.style.display = videos.length ? "none" : "";
}

function renderProgress(): void {
	const line = byId("fontcheck-progress");
	if (scanning()) line.textContent = `Reading subtitles, ${progress!.done} of ${progress!.total}${progress!.current ? `: ${progress!.current}` : ""}`;
	else if (!result) line.textContent = "Every subtitle line is read, so each video is read from disk once.";
	else line.textContent = "";
}

function fixSelect(font: FontCheckMissing): string {
	const fix = fixes.get(font.key);
	const value = fix?.kind === "upload" ? "upload" : fix?.kind === "library" ? `library:${fix.family}` : fix?.kind === "map" ? `map:${fix.to}` : "";
	const match = libraryMatch(font.key);
	const attach = [
		...(uploads.has(font.key) ? [`<option value="upload">Attach the uploaded font</option>`] : []),
		...(match
			? [`<option value="library:${escapeHtml(match.family)}">Attach ${escapeHtml(match.family)} from the library (+${size(match.size)})</option>`]
			: []),
	];
	const options =
		`<option value="">Leave missing</option>` +
		(attach.length ? `<optgroup label="The font itself">${attach.join("")}</optgroup>` : "") +
		targetOptions(mapTargets(font.key, font.closest), (family) => `map:${family}`);
	const selected = `value="${escapeHtml(value)}"`;
	return `<select class="select-input" data-fontcheck-fix="${escapeHtml(font.key)}" ${queueing ? "disabled" : ""}>${
		value ? options.replace(`<option ${selected}`, `<option selected ${selected}`) : options
	}</select>`;
}

function fontRow(font: FontCheckMissing): string {
	const upload = uploads.get(font.key);
	const total = result?.files.length ?? 0;
	const fixed = fixes.has(font.key);
	const detail = upload
		? `<small class="is-ok">Uploaded ${escapeHtml(upload.fileName)}${upload.renamedFrom ? `, renamed from ${escapeHtml(upload.renamedFrom)}` : ""}</small>`
		: libraryMatch(font.key)
			? '<small class="is-ok">In the font library</small>'
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
	const bulkTargets = mapTargets("");
	const anyTarget = bulkTargets.carried.length + bulkTargets.library.length + bulkTargets.uploaded.length > 0;
	container.innerHTML = `${
		result.missing.length
			? `<p class="subfiles-font-warning">Players draw text whose font the video does not carry in another font, so signs, songs and styled lines lose their look. Upload the font, attach it from the font library, or point the subtitles at another font. A font the videos already carry adds no size. A library or uploaded font is attached to every video that lacks it. An uploaded font with another name is renamed to the missing one. Pointing at another font rewrites the font names in the subtitles and remuxes the video. A font attached alone needs no remux.</p>
			<div class="fontcheck-bulk">
				<label>Every font left missing
					<select class="select-input" id="fontcheck-bulk-target" ${queueing ? "disabled" : ""}>${
						bulkTargets.carried.length ? `<option value="${CLOSEST}">Use the closest font the videos carry</option>` : ""
					}${targetOptions(bulkTargets, (family) => family)}</select>
				</label>
				<button class="btn btn-ghost btn-sm" type="button" data-fontcheck-bulk ${queueing || !anyTarget ? "disabled" : ""}>Apply</button>
				<label class="btn btn-ghost btn-sm${queueing || addingToLibrary ? " is-disabled" : ""}" title="Store font files in the font library, where every Font Check can attach them">${addingToLibrary ? "Adding..." : "Add to library..."}<input type="file" accept=".ttf,.otf,.ttc,.otc" multiple data-fontcheck-library hidden ${queueing || addingToLibrary ? "disabled" : ""}></label>
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
	void loadLibrary().then(renderResults);
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
		videos = [];
		setError("");
		render();
	}, "Choose the folder to check");
}

/** One video, a few, or every video of a folder, chosen in the picker. */
export function pickFontCheckVideos(): void {
	openMkvVideosPicker(videos, "Choose videos to check", (paths) => {
		reset();
		videos = paths;
		folder = "";
		setError("");
		render();
	});
}

export async function toggleFontCheckScan(): Promise<void> {
	if (scanning()) {
		const id = scanId;
		reset();
		render();
		await cancelFontCheck(id).catch(() => {});
		return;
	}
	if (!folder && !videos.length) return;
	reset();
	setError("");
	try {
		progress = await startFontCheck(folder ? { folder, recursive: inputById("fontcheck-recursive").checked } : { targets: videos, recursive: false });
		scanId = progress.id;
		render();
		void poll();
	} catch (error) {
		setError(errorMessage(error));
		render();
	}
}

async function addToLibrary(files: File[]): Promise<void> {
	setError("");
	addingToLibrary = true;
	renderResults();
	const failed: string[] = [];
	for (const file of files) {
		try {
			await uploadLibraryFont(file);
		} catch (error) {
			failed.push(errorMessage(error));
		}
	}
	await loadLibrary();
	addingToLibrary = false;
	if (failed.length) setError(failed.join(" "));
	renderResults();
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
		else if (target.value.startsWith("library:")) fixes.set(key, { kind: "library", family: target.value.slice(8) });
		else fixes.set(key, { kind: "map", to: target.value.slice(4) });
		renderResults();
	} else if (target instanceof HTMLInputElement && target.dataset.fontcheckLibrary !== undefined && target.files?.length) {
		if (!addingToLibrary) void addToLibrary([...target.files]);
	} else if (target instanceof HTMLInputElement && target.dataset.fontcheckUpload !== undefined && target.files?.[0]) {
		void upload(target.dataset.fontcheckUpload, target.files[0]);
	}
}

export function handleFontCheckClick(event: MouseEvent): void {
	const bulk = event.target instanceof Element ? event.target.closest("[data-fontcheck-bulk]") : null;
	if (!bulk || queueing || !result) return;
	const to = (byId("fontcheck-bulk-target") as HTMLSelectElement).value;
	if (!to) return;
	for (const font of result.missing) {
		if (fixes.has(font.key)) continue;
		const family = to === CLOSEST ? font.closest : to;
		if (family && normalize(family) !== font.key) fixes.set(font.key, { kind: "map", to: family });
	}
	renderResults();
}

export async function queueFontCheckFixes(): Promise<void> {
	if (!result || !scanId || queueing) return;
	const chosen = [...fixes.entries()];
	const request = {
		scanId,
		uploads: chosen.filter(([, fix]) => fix.kind === "upload").map(([key]) => ({ key, path: uploads.get(key)!.path })),
		maps: chosen.flatMap(([key, fix]) => (fix.kind === "map" ? [{ key, to: fix.to }] : [])),
		library: chosen.flatMap(([key, fix]) => (fix.kind === "library" ? [{ key, family: fix.family }] : [])),
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
			`Queued ${queued.jobIds.length} font fix${queued.jobIds.length === 1 ? "" : "es"}. Follow their progress in the job list, then check the fonts again.${note}`;
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
