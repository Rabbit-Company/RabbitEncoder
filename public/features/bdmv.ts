import type { DiscRow, DiscSetScan } from "../../src/bdmv/plan";
import type { TmdbMovie, TvdbSeries } from "../../src/bdmv/metadata";
import type { DetectedDiscSet } from "../../src/bdmv/watch";
import { discOutputPath, type DiscIdentity, type DiscMode, type DiscOutputKind } from "../../src/bdmv/naming";
import { numberRows } from "../../src/bdmv/numbering";
import { createDiscJobs, type DiscDestination, dismissDiscSet, fetchDetectedDiscSets, scanDiscSetRequest, searchDiscMetadata } from "../api/client";
import { buttonById, byId, inputById } from "../shared/dom";
import { errorMessage } from "../shared/errors";
import { openRepairFolderPicker } from "./repair";
import { update } from "./polling";

let setPath = "";
let scan: DiscSetScan | null = null;
let rows: DiscRow[] = [];
let warnings: string[] = [];
/** Unset until the first read, which guesses it from the discs. */
let mode: DiscMode | undefined;
let tvdbId: number | undefined;
let tmdbId: number | undefined;
let seriesResults: TvdbSeries[] = [];
let movieResults: TmdbMovie[] = [];
let season = 1;
let firstEpisode = 1;
let episodeCounts: Record<number, number> = {};
let identity: DiscIdentity = { title: "" };
let destinations: DiscDestination[] = [];
/** The folder chosen for each kind, kept so anime can go to one library and films to another. */
const SAVE_TO_KEY = "bdmvSaveTo";
let loading = false;
let detected: DetectedDiscSet[] = [];
let detectTimer: ReturnType<typeof setInterval> | null = null;

const escapeHtml = (value: unknown): string =>
	String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");

const fileName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

function clock(seconds: number): string {
	const s = Math.round(seconds);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const mmss = `${String(m).padStart(h ? 2 : 1, "0")}:${String(s % 60).padStart(2, "0")}`;
	return h ? `${h}:${mmss}` : mmss;
}

function bytes(n: number): string {
	const units = ["B", "KiB", "MiB", "GiB", "TiB"];
	let v = n;
	let u = 0;
	while (v >= 1024 && u < units.length - 1) {
		v /= 1024;
		u++;
	}
	return `${v.toFixed(u ? 1 : 0)} ${units[u]}`;
}

function setError(message: string): void {
	const error = byId("bdmv-error");
	error.textContent = message;
	error.style.display = message ? "" : "none";
}

const isMovie = () => (scan?.mode ?? mode) === "movie";

function savedDestinations(): Record<string, string> {
	try {
		const saved = JSON.parse(localStorage.getItem(SAVE_TO_KEY) || "{}");
		return saved && typeof saved === "object" ? saved : {};
	} catch {
		return {};
	}
}

/** The chosen folder for the current kind, or the output folder until one is chosen. */
function saveTo(): string {
	const chosen = savedDestinations()[isMovie() ? "movie" : "series"];
	return destinations.find((d) => d.path === chosen)?.path ?? destinations[0]?.path ?? "";
}

export function handleBdmvSaveTo(): void {
	const value = byId<HTMLSelectElement>("bdmv-save-to").value;
	localStorage.setItem(SAVE_TO_KEY, JSON.stringify({ ...savedDestinations(), [isMovie() ? "movie" : "series"]: value }));
}

function renderSaveTo(): void {
	const select = byId<HTMLSelectElement>("bdmv-save-to");
	const chosen = saveTo();
	select.innerHTML = destinations.length
		? destinations
				.map(
					(d) => `<option value="${escapeHtml(d.path)}" title="${escapeHtml(d.path)}" ${d.path === chosen ? "selected" : ""}>${escapeHtml(d.label)}</option>`,
				)
				.join("")
		: "<option>Read the discs first</option>";
	select.disabled = loading || !destinations.length;
	select.title = chosen;
}

const outputOf = (row: DiscRow) => discOutputPath(scan?.mode ?? "series", scan!.formats, identity, row);

const outputHtml = (row: DiscRow) => {
	const out = outputOf(row);
	return `<div>${escapeHtml(out.filename)}</div><div class="release-row-source">${escapeHtml(out.relativePath)}/</div>`;
};

function renumber(): void {
	warnings = [...(scan?.warnings.filter((w) => !w.startsWith("Found ")) ?? []), ...numberRows(rows, season, firstEpisode, scan?.series)];
}

const LANGS = (list: string[]) => (list.length ? list.join(", ") : "none");

function rangeCell(row: DiscRow, index: number): string {
	const length = `<div>${clock(row.end - row.start)}</div>`;
	const where =
		row.start > 0.5 || row.end < row.duration - 0.5
			? `<div class="release-row-source">${clock(row.start)} to ${clock(row.end)} of ${clock(row.duration)}</div>`
			: `<div class="release-row-source">whole playlist</div>`;
	const prev = rows[index - 1];
	const movable = row.split === "chapters" && prev && prev.disc === row.disc && prev.playlist === row.playlist && Math.abs(prev.end - row.start) < 0.01;
	if (!movable) return length + where;
	const points = [...new Set([row.start, ...row.chapters.filter((t) => t > prev.start + 1 && t < row.end - 1)])].sort((a, b) => a - b);
	if (points.length < 2) return length + where;
	const options = points.map((t) => `<option value="${t}" ${Math.abs(t - row.start) < 0.01 ? "selected" : ""}>Starts ${clock(t)}</option>`).join("");
	return `${length}<select class="select-input bdmv-start" data-bdmv-start="${index}" title="Move where this episode starts to another chapter">${options}</select>`;
}

function rowHtml(row: DiscRow, index: number): string {
	const kinds: [DiscOutputKind, string][] = isMovie()
		? [
				["movie", "Movie"],
				["extra", "Extra"],
			]
		: [
				["episode", "Episode"],
				["special", "Special"],
				["extra", "Extra"],
			];
	const out = outputOf(row);
	const numbered = row.kind === "episode" || row.kind === "special";
	const titleInput =
		row.kind === "movie"
			? `<input class="repair-input" type="text" maxlength="100" value="${escapeHtml(row.edition ?? "")}" data-bdmv-edition="${index}" placeholder="Edition, such as Director's Cut" aria-label="Edition" />`
			: `<input class="repair-input" type="text" maxlength="200" value="${escapeHtml(row.title)}" data-bdmv-title="${index}" placeholder="${numbered ? "No title" : "Name"}" aria-label="Title" />`;
	const notes = [row.warning, row.note]
		.filter(Boolean)
		.map((n) => `<div class="bdmv-note">${escapeHtml(n)}</div>`)
		.join("");
	return `<tr class="${row.selected ? "" : "is-skipped"}">
		<td><input type="checkbox" data-bdmv-select="${index}" ${row.selected ? "checked" : ""} aria-label="Queue this item" /></td>
		<th scope="row" class="release-row-head">
			<div class="repair-file-name">Disc ${row.disc + 1} · ${escapeHtml(row.playlist)}.mpls</div>
			<div class="release-row-source" title="Audio: ${escapeHtml(LANGS(row.audio))}\nSubtitles: ${escapeHtml(LANGS(row.subtitles))}">Audio ${escapeHtml(LANGS(row.audio))} · Subs ${escapeHtml(LANGS(row.subtitles))}</div>
		</th>
		<td class="bdmv-range">${rangeCell(row, index)}</td>
		<td><select class="select-input" data-bdmv-kind="${index}">${kinds.map(([k, label]) => `<option value="${k}" ${row.kind === k ? "selected" : ""}>${label}</option>`).join("")}</select></td>
		${
			isMovie()
				? ""
				: `<td class="bdmv-number">${
						numbered
							? `<span>S</span><input class="num-input" type="number" min="0" max="200" value="${row.season ?? ""}" data-bdmv-season="${index}" ${row.kind === "special" ? "disabled" : ""} aria-label="Season" /><span>E</span><input class="num-input" type="number" min="0" max="5000" value="${row.episode ?? ""}" data-bdmv-episode="${index}" aria-label="Episode" />`
							: ""
					}</td>`
		}
		<td class="bdmv-title">${titleInput}${notes}</td>
		<td class="bdmv-output" title="${escapeHtml(`${out.relativePath}/${out.filename}`)}">${outputHtml(row)}</td>
	</tr>`;
}

function renderMatches(): void {
	const select = byId<HTMLSelectElement>("bdmv-series-results");
	const movie = isMovie();
	const options: { id: number; label: string }[] = movie
		? [...(scan?.movie && !movieResults.some((m) => m.tmdbId === scan!.movie!.tmdbId) ? [scan.movie] : []), ...movieResults].map((m) => ({
				id: m.tmdbId,
				label: `${m.title}${m.year ? ` (${m.year})` : ""}${m.runtime ? ` · ${m.runtime} min` : ""} · TMDB ${m.tmdbId}`,
			}))
		: [...(scan?.series && !seriesResults.some((r) => r.tvdbId === scan!.series!.tvdbId) ? [scan.series] : []), ...seriesResults].map((s) => ({
				id: s.tvdbId,
				label: `${s.title}${s.year ? ` (${s.year})` : ""} · TVDB ${s.tvdbId}`,
			}));
	const chosen = movie ? tmdbId : tvdbId;
	select.innerHTML = options.length
		? options.map((o) => `<option value="${o.id}" ${o.id === chosen ? "selected" : ""}>${escapeHtml(o.label)}</option>`).join("")
		: `<option value="">${scan ? `No ${movie ? "TMDB" : "TVDB"} match, search for the ${movie ? "movie" : "series"}` : "Read the discs first"}</option>`;
	select.disabled = loading || !options.length;
	byId("bdmv-match-label").textContent = movie ? "TMDB movie" : "TVDB series";
	inputById("bdmv-search").placeholder = movie ? "Movie name" : "Series name";
}

function renderDiscs(): string {
	if (!scan) return "";
	return scan.discs
		.map(
			(d, i) => `<label class="bdmv-disc" title="${escapeHtml(d.path)}">
				<span class="repair-file-name">Disc ${i + 1}</span>
				<span class="repair-file-folder">${escapeHtml(d.label.replace(new RegExp(`^disc\\s*0*${i + 1}(?!\\d)\\s*`, "i"), ""))}</span>
				${
					isMovie()
						? ""
						: `<span class="bdmv-disc-count">Episodes <input class="num-input" type="number" min="0" max="100" value="${episodeCounts[i] ?? d.episodes}" data-bdmv-count="${i}" ${loading ? "disabled" : ""} /></span>`
				}
			</label>`,
		)
		.join("");
}

function render(): void {
	byId("bdmv-target-selection").innerHTML = setPath
		? `<span class="repair-file-name" title="${escapeHtml(setPath)}">${escapeHtml(fileName(setPath))}</span><span class="repair-file-folder">${escapeHtml(setPath)}</span>`
		: '<span class="repair-file-empty">No disc folder selected</span>';
	const read = buttonById("bdmv-scan-btn");
	read.disabled = loading || !setPath;
	read.textContent = loading ? "Reading discs..." : scan ? "Read again" : "Read discs";
	buttonById("bdmv-search-btn").disabled = loading || !setPath;
	const modeSelect = byId<HTMLSelectElement>("bdmv-mode");
	modeSelect.value = scan?.mode ?? mode ?? "series";
	modeSelect.disabled = loading || !setPath;
	for (const id of ["bdmv-season-field", "bdmv-first-field"]) byId(id).style.display = isMovie() ? "none" : "";
	inputById("bdmv-season").value = String(season);
	inputById("bdmv-first-episode").value = String(firstEpisode);
	inputById("bdmv-title").value = identity.title;
	inputById("bdmv-year").value = identity.year ? String(identity.year) : "";
	renderMatches();
	renderSaveTo();
	byId("bdmv-discs").innerHTML = renderDiscs();
	renderTable();
}

/** The table, warnings and summary, which change while typing without touching the fields above them. */
function renderTable(): void {
	byId("bdmv-warnings").innerHTML = warnings.map((w) => `<div class="bdmv-warning">${escapeHtml(w)}</div>`).join("");
	byId("bdmv-rows").innerHTML = scan
		? rows.length
			? `<table class="release-grid bdmv-grid"><thead><tr><th scope="col"></th><th class="release-row-head" scope="col">Playlist</th><th scope="col">Length</th><th scope="col">Kind</th>${isMovie() ? "" : '<th scope="col">Number</th>'}<th scope="col">${isMovie() ? "Edition or name" : "Title"}</th><th scope="col">Output</th></tr></thead><tbody>${rows.map(rowHtml).join("")}</tbody></table>`
			: '<div class="repair-empty">These discs have no playlist long enough to be an episode or an extra.</div>'
		: '<div class="repair-empty">Choose a folder with one or more Blu-ray discs (each a folder with BDMV inside), then read them.</div>';

	const chosen = rows.filter((r) => r.selected);
	const count = (kind: DiscOutputKind) => chosen.filter((r) => r.kind === kind).length;
	const [episodes, specials, extras, movies] = [count("episode"), count("special"), count("extra"), count("movie")];
	byId("bdmv-summary").textContent = scan
		? [
				isMovie() ? `${movies} movie${movies === 1 ? "" : "s"}` : `${episodes} episode${episodes === 1 ? "" : "s"}`,
				specials ? `${specials} special${specials === 1 ? "" : "s"}` : "",
				`${extras} extra${extras === 1 ? "" : "s"}`,
				rows.length - chosen.length ? `${rows.length - chosen.length} left out` : "",
			]
				.filter(Boolean)
				.join(" | ")
		: "";
	const queue = buttonById("bdmv-queue-btn");
	queue.disabled = loading || !chosen.length || !identity.title.trim();
	queue.textContent = chosen.length ? `Queue ${chosen.length} item${chosen.length === 1 ? "" : "s"}` : "Queue";
}

async function read(): Promise<void> {
	if (!setPath) return;
	setError("");
	loading = true;
	render();
	try {
		scan = await scanDiscSetRequest({ path: setPath, mode, tvdbId, tmdbId, season, firstEpisode, episodeCounts });
		rows = scan.rows;
		destinations = (scan as DiscSetScan & { destinations?: DiscDestination[] }).destinations ?? [];
		mode = scan.mode;
		tvdbId = scan.series?.tvdbId;
		tmdbId = scan.movie?.tmdbId;
		identity = { ...scan.identity };
		if (!inputById("bdmv-search").value.trim()) inputById("bdmv-search").value = scan.series?.title ?? scan.movie?.title ?? scan.guessedTitle;
		renumber();
	} catch (error) {
		setError(errorMessage(error));
	} finally {
		loading = false;
		render();
	}
}

function reset(path: string): void {
	setPath = path;
	scan = null;
	rows = [];
	warnings = [];
	mode = undefined;
	tvdbId = undefined;
	tmdbId = undefined;
	seriesResults = [];
	movieResults = [];
	season = 1;
	firstEpisode = 1;
	episodeCounts = {};
	identity = { title: "" };
	inputById("bdmv-search").value = "";
}

export function openBdmv(path?: string): void {
	setError("");
	if (path && path !== setPath) reset(path);
	render();
	byId("bdmv-modal").style.display = "";
	if (path && !scan) void read();
}

export function closeBdmv(): void {
	byId("bdmv-modal").style.display = "none";
}

export function closeBdmvIfOutside(event: MouseEvent): void {
	if (event.target === byId("bdmv-modal")) closeBdmv();
}

export function pickBdmvFolder(): void {
	openRepairFolderPicker((path) => {
		reset(path);
		render();
		void read();
	}, "Choose a Blu-ray disc set");
}

export async function scanBdmv(): Promise<void> {
	await read();
}

export async function searchBdmvSeries(): Promise<void> {
	const term = inputById("bdmv-search").value.trim();
	if (!term) return;
	setError("");
	const button = buttonById("bdmv-search-btn");
	button.disabled = true;
	try {
		if (isMovie()) {
			movieResults = await searchDiscMetadata("movie", term, scan?.guessedYear);
			if (!movieResults.length) setError(`TMDB has no movie named ${term}`);
			else if (!movieResults.some((m) => m.tmdbId === tmdbId)) {
				tmdbId = movieResults[0]!.tmdbId;
				await read();
				return;
			}
		} else {
			seriesResults = await searchDiscMetadata("series", term);
			if (!seriesResults.length) setError(`TVDB has no series named ${term}`);
			else if (!seriesResults.some((r) => r.tvdbId === tvdbId)) {
				tvdbId = seriesResults[0]!.tvdbId;
				await read();
				return;
			}
		}
	} catch (error) {
		setError(errorMessage(error));
	} finally {
		button.disabled = false;
	}
	render();
}

export async function handleBdmvSeriesChange(event: Event): Promise<void> {
	const id = Number((event.target as HTMLSelectElement).value);
	if (!id) return;
	if (isMovie()) {
		if (id === tmdbId) return;
		tmdbId = id;
	} else {
		if (id === tvdbId) return;
		tvdbId = id;
	}
	await read();
}

/** Series and movies are read differently, so the discs are read again. */
export async function handleBdmvModeChange(event: Event): Promise<void> {
	const next = (event.target as HTMLSelectElement).value === "movie" ? "movie" : "series";
	if (next === (scan?.mode ?? mode)) return;
	mode = next;
	tvdbId = undefined;
	tmdbId = undefined;
	episodeCounts = {};
	inputById("bdmv-search").value = "";
	await read();
}

export function handleBdmvNumbering(): void {
	season = Math.max(1, Math.floor(Number(inputById("bdmv-season").value) || 1));
	firstEpisode = Math.max(1, Math.floor(Number(inputById("bdmv-first-episode").value) || 1));
	renumber();
	render();
}

/** The title and year the names are made from, as typed. */
export function handleBdmvIdentityInput(): void {
	identity.title = inputById("bdmv-title").value;
	const year = Math.floor(Number(inputById("bdmv-year").value));
	identity.year = year >= 1800 && year <= 2200 ? year : undefined;
	renderTable();
}

export async function handleBdmvDiscs(event: Event): Promise<void> {
	const input = event.target;
	if (!(input instanceof HTMLInputElement) || input.dataset.bdmvCount === undefined) return;
	const disc = Number(input.dataset.bdmvCount);
	const count = Math.floor(Number(input.value));
	if (!Number.isInteger(count) || count < 0) return;
	episodeCounts[disc] = count;
	await read();
}

/** Titles update their output name while typing. Everything else waits for the change. */
export function handleBdmvRowsInput(event: Event): void {
	const el = event.target;
	if (!(el instanceof HTMLInputElement)) return;
	const d = el.dataset;
	const row = d.bdmvTitle !== undefined ? rows[Number(d.bdmvTitle)] : d.bdmvEdition !== undefined ? rows[Number(d.bdmvEdition)] : undefined;
	if (!row) return;
	if (d.bdmvTitle !== undefined) row.title = el.value;
	else row.edition = el.value;
	const cell = el.closest("tr")?.querySelector(".bdmv-output");
	if (cell) cell.innerHTML = outputHtml(row);
}

/** Edits in the table. Changes that move numbers renumber everything, title and number edits stay as typed. */
export function handleBdmvRows(event: Event): void {
	const el = event.target;
	if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) return;
	const d = el.dataset;
	if (d.bdmvSelect !== undefined) {
		rows[Number(d.bdmvSelect)]!.selected = (el as HTMLInputElement).checked;
	} else if (d.bdmvKind !== undefined) {
		const row = rows[Number(d.bdmvKind)]!;
		row.kind = el.value as DiscOutputKind;
		row.title = "";
		renumber();
	} else if (d.bdmvSeason !== undefined) {
		rows[Number(d.bdmvSeason)]!.season = Math.max(0, Math.floor(Number(el.value) || 0));
	} else if (d.bdmvEpisode !== undefined) {
		rows[Number(d.bdmvEpisode)]!.episode = Math.max(0, Math.floor(Number(el.value) || 0));
	} else if (d.bdmvStart !== undefined) {
		const index = Number(d.bdmvStart);
		const t = Number(el.value);
		rows[index - 1]!.end = t;
		rows[index]!.start = t;
		renumber();
	} else return;
	render();
}

export async function queueBdmv(): Promise<void> {
	const chosen = rows.filter((r) => r.selected);
	if (!scan || !chosen.length) return;
	setError("");
	const button = buttonById("bdmv-queue-btn");
	button.disabled = true;
	button.textContent = "Queueing...";
	try {
		await createDiscJobs({
			path: scan.path,
			outputRoot: saveTo() || undefined,
			mode: scan.mode,
			identity: { ...identity, title: identity.title.trim() },
			rows: chosen.map(({ discPath, playlist, start, end, kind, season, episode, title, edition }) => ({
				discPath,
				playlist,
				start,
				end,
				kind,
				season,
				episode,
				title,
				edition,
			})),
		});
		detected = detected.filter((s) => s.path !== scan!.path);
		renderDetected();
		closeBdmv();
		await update();
	} catch (error) {
		setError(errorMessage(error));
		render();
	}
}

function renderDetected(): void {
	const banner = byId("disc-banner");
	banner.style.display = detected.length ? "" : "none";
	banner.innerHTML = detected
		.map(
			(s) => `<div class="disc-banner-row">
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="2.5" /></svg>
				<span class="disc-banner-text">Blu-ray ${s.discs === 1 ? "disc" : `set of ${s.discs} discs`} in the input folder: <strong title="${escapeHtml(s.path)}">${escapeHtml(s.name)}</strong> (${bytes(s.bytes)})</span>
				<button class="btn btn-primary" type="button" data-disc-review="${escapeHtml(s.path)}">Review</button>
				<button class="btn btn-ghost" type="button" data-disc-dismiss="${escapeHtml(s.path)}">Dismiss</button>
			</div>`,
		)
		.join("");
}

export async function handleDiscBanner(event: MouseEvent): Promise<void> {
	const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-disc-review], [data-disc-dismiss]") : null;
	if (!target) return;
	if (target.dataset.discReview) {
		openBdmv(target.dataset.discReview);
		return;
	}
	const path = target.dataset.discDismiss!;
	try {
		await dismissDiscSet(path);
		detected = detected.filter((s) => s.path !== path);
		renderDetected();
	} catch (error) {
		console.error("Dismiss failed:", error);
	}
}

async function pollDetected(): Promise<void> {
	try {
		const sets = await fetchDetectedDiscSets();
		if (JSON.stringify(sets) === JSON.stringify(detected)) return;
		detected = sets;
		renderDetected();
	} catch {}
}

export function startDiscPolling(): void {
	if (detectTimer) clearInterval(detectTimer);
	void pollDetected();
	detectTimer = setInterval(pollDetected, 10_000);
}
