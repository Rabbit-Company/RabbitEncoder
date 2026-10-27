import type { SubtitleSearchCandidate, SubtitleSearchIdentity, SubtitleSearchLanguage } from "../types";
import { applyVideoSubtitles, cancelSubtitleSearch, fetchSubtitleSearch, startSubtitleSearch, type SubtitleSearchState } from "../api/client";
import { buttonById, byId, inputById } from "../shared/dom";
import { errorMessage } from "../shared/errors";
import { appState } from "../state";
import { update } from "./polling";
import { openSubtitleSearchPicker } from "./repair";

const STORAGE_KEY = "rabbit-subtitle-search-languages";
const POLL_MS = 1000;

let videoPath = "";
let search: SubtitleSearchState | null = null;
/** Chosen candidate key per language. */
const choices = new Map<string, string>();
/** Candidates whose sample lines are shown. */
const expanded = new Set<string>();
/** Bumped on every search, so polling for an earlier one stops. */
let run = 0;
let startedAt = 0;

const escapeHtml = (value: unknown): string =>
	String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");

const fileName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

function setError(message: string): void {
	const el = byId("subsearch-error");
	el.textContent = message;
	el.style.display = message ? "" : "none";
}

function setStatus(message: string): void {
	byId("subsearch-status").textContent = message;
}

function defaultLanguages(): string {
	const saved = localStorage.getItem(STORAGE_KEY);
	if (saved) return saved;
	const d = appState.defaults;
	return (d?.subtitleDownloadLanguages?.length ? d.subtitleDownloadLanguages : (d?.translateTargetLanguages ?? [])).join(", ");
}

function parseLanguages(value: string): string[] {
	return value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

function readIdentity(): Partial<SubtitleSearchIdentity> {
	const out: Partial<SubtitleSearchIdentity> = {};
	const title = inputById("subsearch-title").value.trim();
	const imdb = inputById("subsearch-imdb").value.trim();
	const number = (id: string) => {
		const v = inputById(id).value.trim();
		return v && /^\d+$/.test(v) ? parseInt(v, 10) : undefined;
	};
	if (title) out.title = title;
	if (imdb) out.imdbId = /^\d+$/.test(imdb) ? `tt${imdb.padStart(7, "0")}` : imdb;
	const year = number("subsearch-year");
	const season = number("subsearch-season");
	const episode = number("subsearch-episode");
	if (year) out.year = year;
	if (season !== undefined) out.season = season;
	if (episode !== undefined) {
		out.episode = episode;
		out.kind = "episode";
	}
	return out;
}

function describeIdentity(id: SubtitleSearchIdentity): string {
	const parts = [id.title || "(no title)"];
	if (id.year) parts[0] += ` (${id.year})`;
	if (id.kind === "episode") parts.push(`season ${id.season ?? "?"}, episode ${id.episode ?? "?"}`);
	else parts.push("movie");
	const ids = [
		id.imdbId,
		id.parentImdbId && `series ${id.parentImdbId}`,
		id.tmdbId && `TMDB ${id.tmdbId}`,
		id.parentTmdbId && `series TMDB ${id.parentTmdbId}`,
	].filter(Boolean);
	if (ids.length) parts.push(ids.join(", "));
	return `${parts.join(", ")}. From the ${id.sources.join(", ")}.`;
}

function syncText(c: SubtitleSearchCandidate): string {
	if (c.offsetMs === undefined) return "";
	const parts = [`${c.offsetMs >= 0 ? "+" : ""}${(c.offsetMs / 1000).toFixed(2)} s`];
	if (c.scale && c.scale !== 1) parts.push(`speed ×${c.scale.toFixed(4)}`);
	if (c.pieces && c.pieces > 1) parts.push(`${c.pieces} parts`);
	return parts.join(", ");
}

function ratingClass(rating: number): string {
	return rating >= 80 ? "good" : rating >= 60 ? "fair" : "poor";
}

function flags(c: SubtitleSearchCandidate): string {
	const out: string[] = [];
	if (c.hashMatch) out.push('<span class="subsearch-flag good" title="Made for this exact file">exact file</span>');
	if (c.hearingImpaired) out.push('<span class="subsearch-flag" title="Hearing impaired">SDH</span>');
	if (c.machineTranslated) out.push('<span class="subsearch-flag poor" title="Machine or AI translated">MT</span>');
	if (c.trustedUploader) out.push('<span class="subsearch-flag" title="Trusted uploader">trusted</span>');
	return out.join("");
}

function candidateRow(lang: SubtitleSearchLanguage, c: SubtitleSearchCandidate): string {
	const rated = c.status === "rated";
	const chosen = choices.get(lang.language) === c.key;
	const q = c.quality;
	const rating = rated ? `<span class="subsearch-rating ${ratingClass(c.rating!)}">${c.rating}</span>` : '<span class="subsearch-rating none">–</span>';
	const detail = rated
		? escapeHtml(
				[syncText(c), `agreement ${q!.agreement.toFixed(2)}`, q!.missingShare > 0 ? `${Math.round(q!.missingShare * 100)}% missing` : "", `${c.cueCount} lines`]
					.filter(Boolean)
					.join(", "),
			)
		: `<span class="hdr-note">${escapeHtml(c.reason ?? (c.status === "untested" ? "Not downloaded" : c.status))}</span>`;
	const name = c.release || c.fileName;
	const link = c.url ? ` <a href="${escapeHtml(c.url)}" target="_blank" rel="noopener noreferrer" title="Open on OpenSubtitles">↗</a>` : "";
	let html = `<tr class="${chosen ? "is-chosen" : ""}${rated ? "" : " is-muted"}">
		<td><input type="radio" name="subsearch-${escapeHtml(lang.language)}" data-subsearch-choose="${escapeHtml(c.key)}" data-language="${escapeHtml(lang.language)}"${chosen ? " checked" : ""}${rated ? "" : " disabled"} /></td>
		<td>${rating}</td>
		<td class="subsearch-name"><span title="${escapeHtml(c.fileName)}">${escapeHtml(name)}</span>${link}<div class="subsearch-flags">${flags(c)}</div></td>
		<td class="subsearch-num">${c.downloads.toLocaleString()}</td>
		<td class="subsearch-detail">${detail}</td>
		<td>${rated && c.samples?.length ? `<button class="btn btn-ghost btn-sm" type="button" data-subsearch-samples="${escapeHtml(c.key)}">${expanded.has(c.key) ? "Hide" : "Lines"}</button>` : ""}</td>
	</tr>`;
	if (expanded.has(c.key) && c.samples?.length) {
		const time = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
		const lines = c.samples
			.map(
				(s) =>
					`<div class="subsearch-sample"><span class="subsearch-sample-time">${time(s.atMs)}</span><span>${escapeHtml(s.text)}</span>${
						s.reference !== undefined ? `<span class="subsearch-sample-ref">${escapeHtml(s.reference || "(no line in the reference)")}</span>` : ""
					}</div>`,
			)
			.join("");
		html += `<tr class="subsearch-samples-row"><td colspan="6">${lines}</td></tr>`;
	}
	return html;
}

function renderResults(): void {
	const container = byId("subsearch-results");
	if (!search || search.state !== "done" || !search.languages) {
		container.innerHTML = "";
		updateButtons();
		return;
	}
	const summary: string[] = [];
	if (search.identity) summary.push(`<div><strong>Searched as</strong> ${escapeHtml(describeIdentity(search.identity))}</div>`);
	if (search.reference) summary.push(`<div><strong>Synced to</strong> ${escapeHtml(search.reference.label)}</div>`);
	if (search.remainingDownloads !== undefined) summary.push(`<div><strong>Downloads left today</strong> ${search.remainingDownloads}</div>`);
	for (const note of search.notes ?? []) summary.push(`<div class="hdr-note">${escapeHtml(note)}</div>`);
	const sections = search.languages
		.map((lang) => {
			const rows = lang.candidates.map((c) => candidateRow(lang, c)).join("");
			const table = lang.candidates.length
				? `<table class="subsearch-table"><thead><tr><th></th><th>Rating</th><th>Release</th><th>Downloads</th><th>Sync</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
				: "";
			return `<div class="subsearch-language">
				<h3>${escapeHtml(lang.name)} <span class="hdr-note">${escapeHtml(lang.language)}</span></h3>
				${lang.note ? `<div class="lang-filter-hint">${escapeHtml(lang.note)}</div>` : ""}
				${table}
			</div>`;
		})
		.join("");
	container.innerHTML = `<div class="subsearch-summary">${summary.join("")}</div>${sections}`;
	updateButtons();
}

function updateButtons(): void {
	const running = search?.state === "running";
	const searchBtn = buttonById("subsearch-search");
	searchBtn.textContent = running ? "Cancel" : "Search";
	searchBtn.disabled = !videoPath;
	const ready = !running && choices.size > 0;
	buttonById("subsearch-apply").disabled = !ready;
	buttonById("subsearch-sidecar").disabled = !ready;
}

function renderVideo(): void {
	byId("subsearch-video-selection").innerHTML = videoPath
		? `<span class="repair-file-name" title="${escapeHtml(videoPath)}">${escapeHtml(fileName(videoPath))}</span><span class="repair-file-folder">${escapeHtml(videoPath)}</span>`
		: '<span class="repair-file-empty">No video selected</span>';
	updateButtons();
}

function resetResults(): void {
	if (search?.state === "running") void cancelSubtitleSearch(search.searchId);
	run++;
	search = null;
	choices.clear();
	expanded.clear();
	setStatus("");
	setError("");
	renderResults();
}

async function poll(current: number): Promise<void> {
	while (current === run && search?.state === "running") {
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
		if (current !== run || !search) return;
		try {
			search = await fetchSubtitleSearch(search.searchId);
		} catch (error) {
			if (current !== run) return;
			search = null;
			setError(errorMessage(error));
			break;
		}
		if (current !== run) return;
		const seconds = Math.round((Date.now() - startedAt) / 1000);
		setStatus(search.state === "running" ? `${search.message || "Searching"}... ${seconds} s` : "");
	}
	if (current !== run) return;
	if (search?.state === "error") {
		setError(search.error || "Subtitle search failed");
		search = null;
	}
	for (const lang of search?.languages ?? []) if (lang.bestKey) choices.set(lang.language, lang.bestKey);
	if (search?.state === "done") {
		const found = search.languages?.filter((l) => l.bestKey).length ?? 0;
		setStatus(`Found ${found} of ${search.languages?.length ?? 0} language${search.languages?.length === 1 ? "" : "s"}`);
	}
	renderResults();
}

export function openSubtitleSearch(): void {
	byId("subsearch-modal").style.display = "";
	const input = inputById("subsearch-languages");
	if (!input.value) input.value = defaultLanguages();
	renderVideo();
	renderResults();
}

export function closeSubtitleSearch(): void {
	byId("subsearch-modal").style.display = "none";
}

export function closeSubtitleSearchIfOutside(event: MouseEvent): void {
	if (event.target === event.currentTarget) closeSubtitleSearch();
}

export function chooseSubtitleSearchVideo(): void {
	openSubtitleSearchPicker((path) => {
		videoPath = path;
		for (const id of ["subsearch-title", "subsearch-year", "subsearch-season", "subsearch-episode", "subsearch-imdb"]) inputById(id).value = "";
		resetResults();
		renderVideo();
	});
}

export async function runSubtitleSearch(): Promise<void> {
	if (search?.state === "running") {
		resetResults();
		updateButtons();
		return;
	}
	const languages = parseLanguages(inputById("subsearch-languages").value);
	if (!videoPath) return setError("Choose a video first");
	if (!languages.length) return setError("Enter at least one language, such as slv, eng");
	resetResults();
	const current = run;
	try {
		localStorage.setItem(STORAGE_KEY, languages.join(", "));
	} catch {}
	startedAt = Date.now();
	setStatus("Starting...");
	try {
		search = await startSubtitleSearch(videoPath, languages, readIdentity());
	} catch (error) {
		setStatus("");
		setError(errorMessage(error));
		return;
	}
	if (current !== run) return;
	updateButtons();
	await poll(current);
}

export function handleSubtitleSearchResultsClick(event: MouseEvent): void {
	const target = event.target instanceof Element ? event.target : null;
	const samples = target?.closest<HTMLElement>("[data-subsearch-samples]");
	if (samples) {
		const key = samples.dataset.subsearchSamples!;
		if (expanded.has(key)) expanded.delete(key);
		else expanded.add(key);
		renderResults();
	}
}

export function handleSubtitleSearchResultsChange(event: Event): void {
	const input = event.target as HTMLInputElement;
	if (!input.dataset?.subsearchChoose || !input.dataset.language) return;
	choices.set(input.dataset.language, input.dataset.subsearchChoose);
	renderResults();
}

export async function applySubtitleSearch(mode: "mux" | "sidecar"): Promise<void> {
	if (!search || !choices.size) return;
	buttonById("subsearch-apply").disabled = true;
	buttonById("subsearch-sidecar").disabled = true;
	setError("");
	try {
		const result = await applyVideoSubtitles(
			search.searchId,
			[...choices].map(([language, key]) => ({ language, key })),
			mode,
		);
		if (mode === "sidecar") setStatus(`Saved ${result.files?.join(", ")}`);
		else {
			setStatus("Queued. The subtitles are added when the job runs.");
			await update();
		}
	} catch (error) {
		setError(errorMessage(error));
	}
	updateButtons();
}
