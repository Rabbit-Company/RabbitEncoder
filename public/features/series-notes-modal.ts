import type { SeriesNotes } from "../api/client";
import { fetchSeriesNotes, saveSeriesNotes, deleteSeriesNotes } from "../api/client";
import { byId } from "../shared/dom";

let series: SeriesNotes[] = [];
let selected = "";

function setStatus(msg: string): void {
	byId("sn-status").textContent = msg;
}

async function refresh(): Promise<void> {
	series = await fetchSeriesNotes();
	if (!series.some((s) => s.key === selected)) selected = series[0]?.key ?? "";
	render();
}

function render(): void {
	const host = byId("sn-body");
	host.innerHTML = "";

	if (series.length === 0) {
		const empty = document.createElement("div");
		empty.className = "lang-filter-hint";
		empty.textContent = "No series notes yet. They are created the first time an episode of a series is translated with series notes turned on.";
		host.appendChild(empty);
		return;
	}

	const row = document.createElement("div");
	row.className = "fg-row";
	const select = document.createElement("select");
	select.className = "select-input";
	for (const s of series) {
		const opt = document.createElement("option");
		opt.value = s.key;
		opt.textContent = `${s.title} (${s.episodes.length} episode${s.episodes.length === 1 ? "" : "s"})`;
		opt.selected = s.key === selected;
		select.appendChild(opt);
	}
	select.onchange = () => {
		selected = select.value;
		render();
	};
	row.appendChild(select);
	host.appendChild(row);

	const current = series.find((s) => s.key === selected)!;
	const editor = document.createElement("textarea");
	editor.className = "lang-filter-input series-notes-editor";
	editor.spellcheck = false;
	editor.value = current.notes;
	host.appendChild(editor);

	const hint = document.createElement("div");
	hint.className = "lang-filter-hint";
	hint.textContent =
		"Sent with every translation request for this series. Fix wrong genders or forms of address here. Later episodes only add new entries and never change existing ones. Delete the notes to build them again from the next episode.";
	host.appendChild(hint);

	const actions = document.createElement("div");
	actions.className = "fg-row";
	const saveBtn = document.createElement("button");
	saveBtn.className = "btn btn-primary";
	saveBtn.textContent = "Save";
	saveBtn.onclick = async () => {
		setStatus("Saving...");
		const r = await saveSeriesNotes(current.key, editor.value);
		if (!r.ok) return setStatus(r.error || "Save failed");
		current.notes = editor.value;
		setStatus(`Saved notes for "${current.title}"`);
	};
	const deleteBtn = document.createElement("button");
	deleteBtn.className = "btn btn-ghost";
	deleteBtn.textContent = "Delete";
	deleteBtn.onclick = async () => {
		if (!confirm(`Delete the series notes for "${current.title}"?`)) return;
		const r = await deleteSeriesNotes(current.key);
		if (!r.ok) return setStatus(r.error || "Delete failed");
		setStatus(`Deleted notes for "${current.title}"`);
		await refresh();
	};
	actions.append(saveBtn, deleteBtn);
	host.appendChild(actions);
}

let onClose: (() => void) | undefined;

/** Open the editor, optionally on one series, and get told when it closes. */
export async function openSeriesNotesModal(key?: string, closed?: () => void): Promise<void> {
	if (key) selected = key;
	onClose = closed;
	byId("series-notes-modal").style.display = "";
	setStatus("Loading...");
	await refresh();
	setStatus("");
}

export function closeSeriesNotesModal(): void {
	byId("series-notes-modal").style.display = "none";
	const done = onClose;
	onClose = undefined;
	done?.();
}

export function closeSeriesNotesModalIfOutside(e: MouseEvent): void {
	if (e.target === e.currentTarget) closeSeriesNotesModal();
}
