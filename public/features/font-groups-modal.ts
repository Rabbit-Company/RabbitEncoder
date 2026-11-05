// public/features/font-groups-modal.ts
import type { FontOption, SystemFont } from "../api/client";
import {
	fetchFonts,
	fetchSystemFonts,
	createFontGroup,
	renameFontGroup,
	deleteFontGroup,
	importFontFace,
	updateFontFace,
	deleteFontFace,
	uploadLibraryFont,
	fetchFontFace,
} from "../api/client";
import { byId } from "../shared/dom";

/** Writing systems offered in the import dropdown -> these match script-detect.ts keys. */
const WRITING_SYSTEMS: { value: string; label: string }[] = [
	{ value: "latin", label: "Latin" },
	{ value: "cyrillic", label: "Cyrillic" },
	{ value: "greek", label: "Greek" },
	{ value: "arabic", label: "Arabic" },
	{ value: "hebrew", label: "Hebrew" },
	{ value: "japanese", label: "Japanese" },
	{ value: "korean", label: "Korean" },
	{ value: "chinese", label: "Chinese" },
	{ value: "thai", label: "Thai" },
	{ value: "devanagari", label: "Devanagari" },
];

let state: {
	groups: FontOption[];
	systemFonts: SystemFont[];
	systemEnabled: boolean;
	selected: string;
} | null = null;

let search = "";
let uploading = false;

/** CSS family names of faces already loaded for previews, by group and file. */
const previews = new Map<string, Promise<string>>();
let previewCount = 0;

const size = (bytes: number) => (bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** Loads a library face under a name of its own, so a same-named font on the computer cannot stand in for it. */
function loadPreview(label: string, fileName: string): Promise<string> {
	const id = `${label}/${fileName}`;
	let loaded = previews.get(id);
	if (!loaded) {
		const family = `rabbit-library-${++previewCount}`;
		loaded = fetchFontFace(label, fileName)
			.then((blob) => new FontFace(family, `url(${URL.createObjectURL(blob)})`).load())
			.then((face) => {
				document.fonts.add(face);
				return family;
			});
		loaded.catch(() => previews.delete(id));
		previews.set(id, loaded);
	}
	return loaded;
}

const previewObserver = new IntersectionObserver((entries) => {
	for (const entry of entries) {
		if (!entry.isIntersecting) continue;
		const el = entry.target as HTMLElement;
		previewObserver.unobserve(el);
		loadPreview(el.dataset.group!, el.dataset.file!)
			.then((family) => {
				el.style.fontFamily = `"${family}", var(--font-body)`;
				el.classList.remove("is-loading");
			})
			.catch(() => {
				el.classList.remove("is-loading");
				el.title = "This font could not be shown";
			});
	}
});

function setStatus(msg: string): void {
	byId("fg-status").textContent = msg;
}

function currentGroup(): FontOption | undefined {
	return state!.groups.find((g) => g.label === state!.selected);
}

async function refresh(keepSelection = true): Promise<void> {
	const [groups, sys] = await Promise.all([fetchFonts(), fetchSystemFonts()]);
	const prev = keepSelection ? state?.selected : undefined;
	state = {
		groups,
		systemFonts: sys.fonts,
		systemEnabled: sys.enabled,
		selected: prev && groups.some((g) => g.label === prev) ? prev : (groups[0]?.label ?? ""),
	};
	render();
}

function render(): void {
	renderLibrary();
	renderGroupBar();
	renderFaces();
	renderUpload();
	renderImport();
}

async function uploadToLibrary(files: File[]): Promise<void> {
	uploading = true;
	renderLibrary();
	const stored: string[] = [];
	const failed: string[] = [];
	for (const file of files) {
		setStatus(`Uploading ${file.name}...`);
		try {
			const font = await uploadLibraryFont(file);
			stored.push(`${font.fileName} to "${font.label}"`);
		} catch (error) {
			failed.push(error instanceof Error ? error.message : String(error));
		}
	}
	uploading = false;
	setStatus([stored.length ? `Uploaded ${stored.join(", ")}` : "", ...failed].filter(Boolean).join(". "));
	await refresh();
}

async function removeFace(label: string, fileName: string, last: boolean): Promise<void> {
	const note = last ? `\n\nIt is the last font in "${label}", so the group is removed too.` : "";
	if (!window.confirm(`Remove "${fileName}" from "${label}"?${note}`)) return;
	setStatus("Removing...");
	const r = last ? await deleteFontGroup(label) : await deleteFontFace(label, fileName);
	if (!r.ok) return setStatus(r.error || "Remove failed");
	setStatus(last ? `Removed "${fileName}" and its group "${label}"` : `Removed "${fileName}"`);
	await refresh();
}

/** Every face of every group in one list, to find, preview and remove fonts. */
function renderLibrary(): void {
	const host = byId("fg-library");
	const focused = document.activeElement?.id === "fg-search";
	host.innerHTML = "";
	const s = state!;
	const faces = s.groups.flatMap((group) => (group.faces ?? []).map((face) => ({ group: group.label, last: group.faces!.length === 1, ...face })));
	const total = faces.reduce((n, face) => n + (face.size ?? 0), 0);

	const title = document.createElement("div");
	title.className = "fg-section-title";
	title.textContent = faces.length ? `All fonts (${faces.length}, ${size(total)})` : "All fonts";

	const row = document.createElement("div");
	row.className = "fg-row";
	const searchInput = document.createElement("input");
	searchInput.type = "search";
	searchInput.id = "fg-search";
	searchInput.className = "lang-filter-input fg-search";
	searchInput.placeholder = "Search by family, file or group";
	searchInput.value = search;
	searchInput.oninput = () => {
		search = searchInput.value;
		renderLibrary();
	};
	const fileInput = document.createElement("input");
	fileInput.type = "file";
	fileInput.accept = ".ttf,.otf,.ttc,.otc";
	fileInput.multiple = true;
	fileInput.hidden = true;
	fileInput.onchange = () => {
		if (fileInput.files?.length) void uploadToLibrary([...fileInput.files]);
	};
	const uploadBtn = document.createElement("button");
	uploadBtn.type = "button";
	uploadBtn.className = "btn btn-ghost";
	uploadBtn.title = "Each font goes to a group named after its family, where Font check and the subtitle style can use it";
	uploadBtn.textContent = uploading ? "Uploading..." : "Upload fonts...";
	uploadBtn.disabled = uploading;
	uploadBtn.onclick = () => fileInput.click();
	row.append(searchInput, uploadBtn, fileInput);
	host.append(title, row);
	if (focused) {
		searchInput.focus();
		searchInput.setSelectionRange(search.length, search.length);
	}

	const query = search.trim().toLowerCase();
	const shown = query ? faces.filter((face) => [face.family, face.fileName, face.group].some((text) => text.toLowerCase().includes(query))) : faces;
	const list = document.createElement("div");
	list.className = "fg-library-list";
	if (!shown.length) {
		const empty = document.createElement("div");
		empty.className = "setting-help";
		empty.textContent = faces.length ? "No font matches the search." : "No fonts yet. Upload some above.";
		list.appendChild(empty);
	}
	for (const face of shown) {
		const item = document.createElement("div");
		item.className = "fg-library-row";

		const info = document.createElement("div");
		info.className = "fg-face-info";
		const preview = document.createElement("div");
		preview.className = "fg-library-preview is-loading";
		preview.textContent = face.family;
		preview.dataset.group = face.group;
		preview.dataset.file = face.fileName;
		previewObserver.observe(preview);
		const details = document.createElement("div");
		details.className = "fg-face-file";
		details.textContent = `${face.fileName}, ${size(face.size ?? 0)}${face.group === face.family ? "" : `, in "${face.group}"`}`;
		info.append(preview, details);

		const edit = document.createElement("button");
		edit.className = "btn btn-ghost btn-sm";
		edit.textContent = "Edit group";
		edit.onclick = () => {
			state!.selected = face.group;
			render();
			byId("fg-group-bar").scrollIntoView({ behavior: "smooth", block: "start" });
		};
		const remove = document.createElement("button");
		remove.className = "btn btn-ghost btn-sm fg-danger";
		remove.textContent = "Remove";
		remove.onclick = () => void removeFace(face.group, face.fileName, face.last);

		item.append(info, edit, remove);
		list.appendChild(item);
	}
	host.appendChild(list);
}

function renderGroupBar(): void {
	const host = byId("fg-group-bar");
	host.innerHTML = "";
	const s = state!;

	const title = document.createElement("div");
	title.className = "fg-section-title";
	title.textContent = "Font groups";
	host.appendChild(title);

	const createRow = document.createElement("div");
	createRow.className = "fg-row";
	const newInput = document.createElement("input");
	newInput.type = "text";
	newInput.className = "lang-filter-input";
	newInput.placeholder = "New group name";
	const createBtn = document.createElement("button");
	createBtn.className = "btn btn-ghost";
	createBtn.textContent = "Create group";
	createBtn.onclick = async () => {
		const name = newInput.value.trim();
		if (!name) return;
		setStatus("Creating...");
		const r = await createFontGroup(name);
		if (!r.ok) return setStatus(r.error || "Create failed");
		setStatus(`Created "${name}"`);
		if (state) state.selected = name;
		await refresh();
	};
	createRow.append(newInput, createBtn);
	host.appendChild(createRow);

	if (s.groups.length === 0) {
		const empty = document.createElement("div");
		empty.className = "setting-help";
		empty.textContent = "No font groups yet. Create one above.";
		host.appendChild(empty);
		return;
	}

	const row = document.createElement("div");
	row.className = "fg-row";
	const label = document.createElement("label");
	label.className = "toggle-label";
	const span = document.createElement("span");
	span.textContent = "Editing group\u00A0";
	const select = document.createElement("select");
	select.className = "select-input";
	for (const g of s.groups) {
		const o = document.createElement("option");
		o.value = g.label;
		o.textContent = g.label;
		if (g.label === s.selected) o.selected = true;
		select.appendChild(o);
	}
	select.onchange = () => {
		state!.selected = select.value;
		render();
	};
	label.append(span, select);

	const renameBtn = document.createElement("button");
	renameBtn.className = "btn btn-ghost";
	renameBtn.textContent = "Rename";
	renameBtn.onclick = async () => {
		const current = state!.selected;
		const next = window.prompt(`Rename font group "${current}" to:`, current);
		if (next === null) return;
		const trimmed = next.trim();
		if (!trimmed || trimmed === current) return;
		setStatus("Renaming...");
		const r = await renameFontGroup(current, trimmed);
		if (!r.ok) return setStatus(r.error || "Rename failed");
		setStatus(`Renamed to "${trimmed}"` + (r.updatedReferences ? `. Updated ${r.updatedReferences} setting(s).` : ""));
		if (state) state.selected = trimmed;
		await refresh();
	};

	const deleteBtn = document.createElement("button");
	deleteBtn.className = "btn btn-ghost fg-danger";
	deleteBtn.textContent = "Delete";
	deleteBtn.onclick = async () => {
		const current = state!.selected;
		if (!window.confirm(`Delete font group "${current}"?\n\nSeeded groups (Noto Sans / Noto Serif) reappear on next restart.`)) return;
		setStatus("Deleting...");
		const r = await deleteFontGroup(current);
		if (!r.ok) return setStatus(r.error || "Delete failed");
		setStatus(`Deleted "${current}"`);
		await refresh(false);
	};

	row.append(label, renameBtn, deleteBtn);
	host.appendChild(row);
}

function renderFaces(): void {
	const host = byId("fg-faces");
	host.innerHTML = "";
	const g = currentGroup();
	if (!g) return;

	const title = document.createElement("div");
	title.className = "fg-section-title";
	title.textContent = "Fonts in this group";
	host.appendChild(title);

	const faces = g.faces ?? [];
	if (faces.length === 0) {
		const empty = document.createElement("div");
		empty.className = "setting-help";
		empty.textContent = "No fonts in this group yet. Import one below.";
		host.appendChild(empty);
		return;
	}

	for (const face of faces) {
		const row = document.createElement("div");
		row.className = "fg-face-row";

		const info = document.createElement("div");
		info.className = "fg-face-info";
		const fam = document.createElement("div");
		fam.className = "fg-face-family";
		fam.textContent = face.family;
		const file = document.createElement("div");
		file.className = "fg-face-file";
		file.textContent = face.fileName;
		info.append(fam, file);

		const keysInput = document.createElement("input");
		keysInput.type = "text";
		keysInput.className = "lang-filter-input fg-keys-input";
		keysInput.value = (face.keys ?? []).join(", ");
		keysInput.placeholder = "e.g. latin, jpn";

		const saveBtn = document.createElement("button");
		saveBtn.className = "btn btn-ghost";
		saveBtn.textContent = "Save keys";
		saveBtn.onclick = async () => {
			const keys = keysInput.value
				.split(",")
				.map((k) => k.trim())
				.filter(Boolean);
			setStatus("Saving keys...");
			const r = await updateFontFace(state!.selected, face.fileName, keys);
			if (!r.ok) return setStatus(r.error || "Save failed");
			setStatus("Keys saved");
			await refresh();
		};

		const delBtn = document.createElement("button");
		delBtn.className = "btn btn-ghost fg-danger";
		delBtn.textContent = "Remove";
		delBtn.onclick = async () => {
			if (!window.confirm(`Remove "${face.fileName}" from "${state!.selected}"?`)) return;
			setStatus("Removing...");
			const r = await deleteFontFace(state!.selected, face.fileName);
			if (!r.ok) return setStatus(r.error || "Remove failed");
			setStatus("Removed");
			await refresh();
		};

		row.append(info, keysInput, saveBtn, delBtn);
		host.appendChild(row);
	}
}

function writingSystemSelect(): HTMLSelectElement {
	const select = document.createElement("select");
	select.className = "select-input";
	for (const w of WRITING_SYSTEMS) {
		const o = document.createElement("option");
		o.value = w.value;
		o.textContent = w.label;
		select.appendChild(o);
	}
	return select;
}

const extraKeys = (input: HTMLInputElement) =>
	input.value
		.split(",")
		.map((k) => k.trim())
		.filter(Boolean);

function renderUpload(): void {
	const host = byId("fg-upload");
	host.innerHTML = "";
	const g = currentGroup();
	if (!g) return;

	const title = document.createElement("div");
	title.className = "fg-section-title";
	title.textContent = "Upload fonts from this computer into this group";
	host.appendChild(title);

	const row = document.createElement("div");
	row.className = "fg-row";

	const sysSel = writingSystemSelect();
	const customInput = document.createElement("input");
	customInput.type = "text";
	customInput.className = "lang-filter-input";
	customInput.placeholder = "+ extra keys (e.g. jpn)";

	const fileInput = document.createElement("input");
	fileInput.type = "file";
	fileInput.accept = ".ttf,.otf,.ttc,.otc";
	fileInput.multiple = true;
	fileInput.hidden = true;

	const uploadBtn = document.createElement("button");
	uploadBtn.type = "button";
	uploadBtn.className = "btn btn-primary";
	uploadBtn.textContent = "Upload fonts...";
	uploadBtn.onclick = () => fileInput.click();
	fileInput.onchange = async () => {
		const files = [...(fileInput.files ?? [])];
		if (!files.length) return;
		const group = state!.selected;
		const keys = [sysSel.value, ...extraKeys(customInput)];
		uploadBtn.disabled = true;
		const stored: string[] = [];
		const failed: string[] = [];
		for (const file of files) {
			setStatus(`Uploading ${file.name}...`);
			try {
				stored.push((await uploadLibraryFont(file, { group, keys })).fileName);
			} catch (error) {
				failed.push(error instanceof Error ? error.message : String(error));
			}
		}
		setStatus([stored.length ? `Uploaded ${stored.join(", ")}` : "", ...failed].filter(Boolean).join(". "));
		uploadBtn.disabled = false;
		await refresh();
	};

	row.append(sysSel, customInput, uploadBtn, fileInput);
	host.appendChild(row);
}

function renderImport(): void {
	const host = byId("fg-import");
	host.innerHTML = "";
	const g = currentGroup();
	if (!g) return;

	const title = document.createElement("div");
	title.className = "fg-section-title";
	title.textContent = "Import a font from the host system";
	host.appendChild(title);

	if (!state!.systemEnabled) {
		const help = document.createElement("div");
		help.className = "setting-help";
		help.innerHTML = "No host font directory mounted. Mount one read-only and set <code>SYSTEM_FONTS_DIRS</code> in docker-compose.";
		host.appendChild(help);
		return;
	}
	if (state!.systemFonts.length === 0) {
		const help = document.createElement("div");
		help.className = "setting-help";
		help.textContent = "No fonts found in the mounted host directory.";
		host.appendChild(help);
		return;
	}

	const row = document.createElement("div");
	row.className = "fg-row fg-import-row";

	const fontSel = document.createElement("select");
	fontSel.className = "select-input fg-import-font";
	for (const f of state!.systemFonts) {
		const o = document.createElement("option");
		o.value = f.path;
		o.textContent = `${f.family} (${f.fileName})`;
		fontSel.appendChild(o);
	}

	const sysSel = writingSystemSelect();

	const customInput = document.createElement("input");
	customInput.type = "text";
	customInput.className = "lang-filter-input";
	customInput.placeholder = "+ extra keys (e.g. jpn)";

	const importBtn = document.createElement("button");
	importBtn.className = "btn btn-primary";
	importBtn.textContent = "Import";
	importBtn.onclick = async () => {
		const source = fontSel.value;
		const keys = [sysSel.value, ...extraKeys(customInput)];
		setStatus("Importing...");
		const r = await importFontFace(state!.selected, source, keys);
		if (!r.ok) return setStatus(r.error || "Import failed");
		setStatus(`Imported as ${r.fileName}`);
		customInput.value = "";
		await refresh();
	};

	row.append(fontSel, sysSel, customInput, importBtn);
	host.appendChild(row);
}

export async function openFontGroupsModal(): Promise<void> {
	byId("font-groups-modal").style.display = "";
	setStatus("Loading...");
	await refresh(false);
	setStatus("");
}

export function closeFontGroupsModal(): void {
	byId("font-groups-modal").style.display = "none";
}

export function closeFontGroupsModalIfOutside(e: MouseEvent): void {
	if (e.target === e.currentTarget) closeFontGroupsModal();
}
