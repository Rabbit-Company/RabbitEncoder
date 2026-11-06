import type { AudioTrackAction, AudioTrackChoice, AudioTracksScan, PlannedAudioTrack } from "../types";
import { createAudioTracksJobs, fetchAudioTracksScan } from "../api/client";
import { buttonById, byId } from "../shared/dom";
import { errorMessage } from "../shared/errors";
import { openMkvVideosPicker, openRepairFolderPicker } from "./repair";
import { update } from "./polling";

/** A folder of videos, or the videos chosen one by one. Only one of them is set. */
let targetDir = "";
let targetVideos: string[] = [];
/** The selection the plan was read for. Another one makes it stale. */
let scannedFor = "";
const selection = () => (targetDir ? { targetDir } : { targets: targetVideos });
const selectionKey = () => JSON.stringify(selection());
let scan: AudioTracksScan | null = null;
/** A choice per kind of track, which applies to that track in every file. */
let choices: Record<string, AudioTrackChoice> = {};
let loading = false;

const escapeHtml = (value: unknown): string =>
	String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");

const fileName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

const ACTION_LABELS: Record<AudioTrackAction, string> = { copy: "Copy as is", encode: "Encode to Opus", remove: "Remove" };

function setError(message: string): void {
	const error = byId("audio-tracks-error");
	error.textContent = message;
	error.style.display = message ? "" : "none";
}

const folderOf = (path: string): string => path.slice(0, path.lastIndexOf("/"));

function targetHtml(): string {
	const named = (name: string, title: string, folder: string) =>
		`<span class="repair-file-name" title="${escapeHtml(title)}">${escapeHtml(name)}</span><span class="repair-file-folder">${escapeHtml(folder)}</span>`;
	if (targetDir) return named(fileName(targetDir), targetDir, targetDir);
	if (targetVideos.length === 1) return named(fileName(targetVideos[0]!), targetVideos[0]!, folderOf(targetVideos[0]!));
	if (targetVideos.length) {
		const folders = [...new Set(targetVideos.map(folderOf))];
		return named(`${targetVideos.length} videos`, targetVideos.map(fileName).join("\n"), folders.length === 1 ? folders[0]! : `${folders.length} folders`);
	}
	return '<span class="repair-file-empty">No videos selected</span>';
}

function renderFolder(): void {
	byId("audio-tracks-target-selection").innerHTML = targetHtml();
	byId("audio-tracks-pick-videos-btn").textContent = targetVideos.length ? "Change videos..." : "Choose videos...";
	const button = buttonById("audio-tracks-scan-btn");
	button.disabled = loading || !(targetDir || targetVideos.length);
	button.textContent = loading ? "Reading tracks..." : scan ? "Read tracks again" : "Read tracks";
}

function actionText(t: PlannedAudioTrack): string {
	return t.action === "encode" ? `Opus ${t.bitrate} kbps` : t.action === "copy" ? "copied" : "removed";
}

function renderTypes(): string {
	if (!scan) return "";
	const rows = scan.types
		.map((type) => {
			const suggested = type.suggested === "mixed" ? "Differs between files" : ACTION_LABELS[type.suggested];
			const choice = choices[type.signature] ?? "auto";
			const options = (["auto", "copy", "encode", "remove"] as AudioTrackChoice[])
				.map(
					(value) => `<option value="${value}" ${value === choice ? "selected" : ""}>${value === "auto" ? "Follow settings" : ACTION_LABELS[value]}</option>`,
				)
				.join("");
			return `<tr>
				<th scope="row" class="release-row-head"><div class="repair-file-name">${escapeHtml(type.label)}</div><div class="release-row-source">${escapeHtml(type.format)}</div></th>
				<td class="audio-tracks-files">${type.files}</td>
				<td class="audio-tracks-suggested"><div>${escapeHtml(suggested)}</div><div class="release-row-source">${escapeHtml(type.reason)}</div></td>
				<td class="release-cell"><select class="select-input release-cell-select" data-audio-signature="${escapeHtml(type.signature)}" ${loading ? "disabled" : ""}>${options}</select></td>
			</tr>`;
		})
		.join("");
	return `<table class="release-grid audio-tracks-types"><thead><tr><th class="release-row-head" scope="col">Track</th><th scope="col">Files</th><th scope="col">Your settings</th><th scope="col">Do</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderFiles(): string {
	if (!scan) return "";
	const labels = new Map(scan.types.map((t) => [t.signature, t.label]));
	return scan.files
		.map((file) => {
			const tracks = file.tracks
				.map((t) => {
					const removed = t.position === null;
					const tags = removed ? "removed" : [actionText(t), t.isDefault ? "default" : "", t.trackName ? `“${t.trackName}”` : ""].filter(Boolean).join(" · ");
					const label = `${labels.get(t.signature) ?? t.language} ${t.format}`;
					const title = [label, removed ? t.reason : t.currentName].filter(Boolean).join("\n");
					return `<li class="${removed ? "is-removed" : ""}" title="${escapeHtml(title)}"><span class="audio-tracks-pos">${removed ? "–" : t.position! + 1}</span><span class="audio-tracks-track">${escapeHtml(labels.get(t.signature) ?? t.language)} <span class="audio-tracks-format">${escapeHtml(t.format)}</span></span><span class="audio-tracks-tags">${escapeHtml(tags)}</span></li>`;
				})
				.join("");
			return `<div class="audio-tracks-file">
				<div class="audio-tracks-file-head"><span class="repair-file-name" title="${escapeHtml(file.path)}">${escapeHtml(file.name)}</span><span class="audio-tracks-changes${file.changes.length ? "" : " is-unchanged"}">${escapeHtml(file.changes.join(", ") || "No change")}</span></div>
				<ol class="audio-tracks-list">${tracks}</ol>
			</div>`;
		})
		.join("");
}

function changedFiles(): string[] {
	return scan ? scan.files.filter((f) => f.changes.length).map((f) => f.path) : [];
}

function render(): void {
	renderFolder();
	byId("audio-tracks-types").innerHTML = scan
		? renderTypes()
		: '<div class="repair-empty">Choose a folder of videos or single videos, then read their tracks.</div>';
	byId("audio-tracks-files").innerHTML = renderFiles();
	const changed = changedFiles().length;
	const stale = !!scan && scannedFor !== selectionKey();
	byId("audio-tracks-summary").textContent = scan
		? [
				`${changed} of ${scan.files.length} file${scan.files.length === 1 ? "" : "s"} ${changed === 1 ? "changes" : "change"}`,
				stale ? "the folder changed, read the tracks again" : "",
			]
				.filter(Boolean)
				.join(" | ")
		: "";
	const button = buttonById("audio-tracks-queue-btn");
	button.textContent = changed ? `Queue ${changed} file${changed === 1 ? "" : "s"}` : "Queue files";
	button.disabled = !changed || loading || stale;
}

async function load(): Promise<void> {
	setError("");
	loading = true;
	render();
	try {
		scan = await fetchAudioTracksScan({ ...selection(), choices });
		scannedFor = selectionKey();
	} catch (error) {
		setError(errorMessage(error));
	} finally {
		loading = false;
		render();
	}
}

export function openAudioTracks(): void {
	setError("");
	render();
	byId("audio-tracks-modal").style.display = "";
}

export function closeAudioTracks(): void {
	byId("audio-tracks-modal").style.display = "none";
}

export function closeAudioTracksIfOutside(event: MouseEvent): void {
	if (event.target === byId("audio-tracks-modal")) closeAudioTracks();
}

export function pickAudioTracksFolder(): void {
	openRepairFolderPicker((path) => {
		targetDir = path;
		targetVideos = [];
		render();
	});
}

/** One episode, a few, or every video of a folder, chosen in the picker. */
export function pickAudioTracksVideos(): void {
	openMkvVideosPicker(targetVideos, "Choose videos to redo the audio of", (paths) => {
		targetVideos = paths;
		targetDir = "";
		render();
	});
}

export async function scanAudioTracks(): Promise<void> {
	if (scannedFor !== selectionKey()) choices = {};
	await load();
}

export async function handleAudioTracksChoice(event: Event): Promise<void> {
	const select = event.target;
	if (!(select instanceof HTMLSelectElement) || !select.dataset.audioSignature) return;
	const signature = select.dataset.audioSignature;
	if (select.value === "auto") delete choices[signature];
	else choices[signature] = select.value as AudioTrackChoice;
	await load();
}

export async function queueAudioTracks(): Promise<void> {
	const targets = changedFiles();
	if (!targets.length) return;
	setError("");
	const button = buttonById("audio-tracks-queue-btn");
	button.disabled = true;
	button.textContent = "Queueing...";
	try {
		await createAudioTracksJobs({ targets, choices, replaceTarget: byId<HTMLSelectElement>("audio-tracks-save-mode").value === "existing" });
		closeAudioTracks();
		await update();
	} catch (error) {
		setError(errorMessage(error));
		render();
	}
}
