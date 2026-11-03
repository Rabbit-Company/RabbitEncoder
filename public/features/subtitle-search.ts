import type { SubtitleSearchCandidate, SubtitleSearchIdentity, SubtitleSearchLanguage } from "../types";
import {
	applyVideoSubtitles,
	cancelSubtitleSearch,
	fetchSubtitleSearch,
	startSubtitleSearch,
	trySubtitleSearchCandidate,
	type SubtitleSearchState,
} from "../api/client";
import { buttonById, byId, inputById } from "../shared/dom";
import { errorMessage } from "../shared/errors";
import { appState } from "../state";
import { update } from "./polling";
import { openSubtitleSearchPicker } from "./repair";

const STORAGE_KEY = "rabbit-subtitle-search-languages";
const EXTRA_STORAGE_KEY = "rabbit-subtitle-search-extra";
const EVERY_STORAGE_KEY = "rabbit-subtitle-search-every-episode";
const PRESENT_STORAGE_KEY = "rabbit-subtitle-search-present";
const POLL_MS = 1000;
/** Untested subtitles of a source downloaded per episode when it is picked for all of them. */
const TRIES_PER_EPISODE = 3;

interface Episode {
	path: string;
	/** Null until its search starts. */
	search: SubtitleSearchState | null;
	error: string;
	/** Chosen candidate key per language. */
	choices: Map<string, string>;
	/** Credits typed over the ones read from the release names, per candidate key. */
	credits: Map<string, string>;
	/** Modes it was already queued or saved with, so a retry after a failure skips it. */
	applied: Set<"mux" | "sidecar">;
}

let episodes: Episode[] = [];
/** The episode whose candidates are shown, or -1 for the overview of all of them. */
let focus = 0;
/** Credits renamed for every episode, by language and the credit read from the names in lower case. */
const renames = new Map<string, Map<string, string>>();
/** Languages left out of every episode by hand. */
const skippedLanguages = new Set<string>();
/** Candidates whose sample lines are shown. */
const expanded = new Set<string>();
/** Candidate being downloaded on request, or "batch" while a source is picked for every episode. */
let trying: string | null = null;
let searching = false;
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
/** What every search of a run is started with, besides its video. */
type SearchOptions = Parameters<typeof startSubtitleSearch> extends [string, ...infer Rest] ? Rest : never;

const isBatch = (): boolean => episodes.length > 1;
const doneEpisodes = (): Episode[] => episodes.filter((ep) => ep.search?.state === "done");
const everyEpisodeOnly = (): boolean => localStorage.getItem(EVERY_STORAGE_KEY) === "1";

function episodeLabel(ep: Episode): string {
	const id = ep.search?.identity;
	if (id?.kind === "episode" && id.episode !== undefined) return `S${String(id.season ?? 1).padStart(2, "0")}E${String(id.episode).padStart(2, "0")}`;
	return fileName(ep.path);
}

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
	const batch = isBatch();
	const title = inputById("subsearch-title").value.trim();
	const imdb = batch ? "" : inputById("subsearch-imdb").value.trim();
	const number = (id: string) => {
		const v = inputById(id).value.trim();
		return v && /^\d+$/.test(v) ? parseInt(v, 10) : undefined;
	};
	if (title) out.title = title;
	if (imdb) out.imdbId = /^\d+$/.test(imdb) ? `tt${imdb.padStart(7, "0")}` : imdb;
	const year = number("subsearch-year");
	if (year) out.year = year;
	const kind = kindSelect().value;
	if (kind === "movie") {
		out.kind = "movie";
		return out;
	}
	const season = number("subsearch-season");
	// Each episode keeps the number its own name gives.
	const episode = batch ? undefined : number("subsearch-episode");
	if (season !== undefined) out.season = season;
	if (episode !== undefined) out.episode = episode;
	if (kind === "episode" || episode !== undefined) out.kind = "episode";
	return out;
}

const kindSelect = () => byId<HTMLSelectElement>("subsearch-kind");

/** Shows what Auto picked after a search, or plain Auto before one. */
function setDetectedKind(kind?: "movie" | "episode"): void {
	kindSelect().options[0]!.textContent = kind ? `Auto (${kind})` : "Auto";
}

export function updateSubtitleSearchKind(): void {
	const movie = kindSelect().value === "movie";
	inputById("subsearch-season").disabled = movie;
	inputById("subsearch-episode").disabled = movie || isBatch();
	inputById("subsearch-imdb").disabled = isBatch();
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
	if (c.preferred !== undefined) out.push('<span class="subsearch-flag good" title="From one of the preferred sources">preferred</span>');
	if (c.otherEpisode) out.push('<span class="subsearch-flag poor" title="The release name gives another episode, so it is tried last">other episode</span>');
	if (c.hashMatch) out.push('<span class="subsearch-flag good" title="Made for this exact file">exact file</span>');
	if (c.hearingImpaired) out.push('<span class="subsearch-flag" title="Hearing impaired">SDH</span>');
	if (c.machineTranslated) out.push('<span class="subsearch-flag poor" title="Machine or AI translated">MT</span>');
	if (c.trustedUploader) out.push('<span class="subsearch-flag" title="Trusted uploader">trusted</span>');
	return out.join("");
}

function findCandidate(ep: Episode, language: string, key: string | undefined): SubtitleSearchCandidate | undefined {
	return key === undefined ? undefined : ep.search?.languages?.find((l) => l.language === language)?.candidates.find((c) => c.key === key);
}

/** The credit a candidate gets: typed for this episode, renamed for every episode, or read from its names. */
function creditFor(ep: Episode, language: string, c: SubtitleSearchCandidate): string {
	return ep.credits.get(c.key) ?? renames.get(language)?.get(c.credit.toLowerCase()) ?? c.credit;
}

/** The track a video has in a language already, which kept the language from being searched for it. */
function presentTrack(ep: Episode, language: string) {
	return ep.search?.present?.find((p) => p.language === language);
}

/** How many finished episodes have a subtitle picked in a language. */
function pickedCount(language: string): number {
	return doneEpisodes().filter((ep) => ep.choices.has(language)).length;
}

/** How many finished episodes have a language, picked now or in the video already. */
function coveredCount(language: string): number {
	return doneEpisodes().filter((ep) => ep.choices.has(language) || presentTrack(ep, language)).length;
}

/** Whether a language goes into the videos. A single video leaves languages out with its own radio buttons. */
function languageAdded(language: string): boolean {
	if (!isBatch()) return true;
	if (skippedLanguages.has(language)) return false;
	return !everyEpisodeOnly() || coveredCount(language) === doneEpisodes().length;
}

function tryButton(lang: SubtitleSearchLanguage, c: SubtitleSearchCandidate): string {
	if (c.status !== "untested") return "";
	const label = trying === c.key ? "Trying..." : "Try";
	return `<button class="btn btn-ghost btn-sm" type="button" data-subsearch-try="${escapeHtml(c.key)}" data-language="${escapeHtml(lang.language)}" title="Download, sync and rate this one"${trying ? " disabled" : ""}>${label}</button>`;
}

function candidateRow(ep: Episode, lang: SubtitleSearchLanguage, c: SubtitleSearchCandidate): string {
	const rated = c.status === "rated";
	const chosen = ep.choices.get(lang.language) === c.key;
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
		<td>${rated && c.samples?.length ? `<button class="btn btn-ghost btn-sm" type="button" data-subsearch-samples="${escapeHtml(c.key)}">${expanded.has(c.key) ? "Hide" : "Lines"}</button>` : ""}${tryButton(lang, c)}</td>
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

/** Lets a language be left out, since a radio button cannot be unchecked. */
function skipRow(ep: Episode, lang: SubtitleSearchLanguage): string {
	if (!lang.candidates.some((c) => c.status === "rated")) return "";
	const skipped = !ep.choices.has(lang.language);
	return `<tr class="subsearch-skip${skipped ? " is-chosen" : ""}">
		<td><input type="radio" name="subsearch-${escapeHtml(lang.language)}" data-subsearch-choose="" data-language="${escapeHtml(lang.language)}"${skipped ? " checked" : ""} /></td>
		<td colspan="5">Don't add ${escapeHtml(lang.name)}</td>
	</tr>`;
}

function creditField(ep: Episode, language: string, c: SubtitleSearchCandidate): string {
	return `<label class="subsearch-credit">Credited as
		<input type="text" class="lang-filter-input" maxlength="60" data-subsearch-credit="${escapeHtml(c.key)}" data-language="${escapeHtml(language)}" value="${escapeHtml(creditFor(ep, language, c))}" placeholder="${escapeHtml(c.credit)}" />
		<span class="hdr-note">The group or source in brackets at the end of the track name. Fix it when it was read wrong.</span>
	</label>`;
}

/** The candidates of one video, to pick and try them one by one. */
function renderEpisode(ep: Episode): string {
	const search = ep.search;
	let nav = "";
	if (isBatch()) {
		const index = episodes.indexOf(ep);
		nav = `<div class="subsearch-episode-nav">
			<button class="btn btn-ghost btn-sm" type="button" data-subsearch-focus="-1">← All episodes</button>
			<button class="btn btn-ghost btn-sm" type="button" data-subsearch-focus="${index - 1}"${index > 0 ? "" : " disabled"}>Previous</button>
			<button class="btn btn-ghost btn-sm" type="button" data-subsearch-focus="${index + 1}"${index < episodes.length - 1 ? "" : " disabled"}>Next</button>
			<span class="repair-file-name" title="${escapeHtml(ep.path)}">${escapeHtml(fileName(ep.path))}</span>
		</div>`;
	}
	if (!search || search.state !== "done" || !search.languages)
		return `${nav}<div class="subsearch-summary"><div class="hdr-note">${escapeHtml(ep.error || (search ? "Searching..." : "Not searched yet"))}</div></div>`;
	const summary: string[] = [];
	if (search.identity) summary.push(`<div><strong>Searched as</strong> ${escapeHtml(describeIdentity(search.identity))}</div>`);
	if (search.reference) summary.push(`<div><strong>Synced to</strong> ${escapeHtml(search.reference.label)}</div>`);
	if (search.remainingDownloads !== undefined) summary.push(`<div><strong>Downloads left today</strong> ${search.remainingDownloads}</div>`);
	for (const note of search.notes ?? []) summary.push(`<div class="hdr-note">${escapeHtml(note)}</div>`);
	if (search.present?.length)
		summary.push(
			`<div><strong>Already in the video</strong> ${escapeHtml(search.present.map((p) => (p.title ? `${p.name} (${p.title})` : p.name)).join(", "))}. Not searched.</div>`,
		);
	// Extra languages without a usable subtitle are listed together, so 30 of them do not bury the rest.
	const unmatched = search.languages.filter((lang) => lang.extra && !lang.candidates.some((c) => c.status === "rated"));
	if (unmatched.length) summary.push(`<div><strong>No good subtitle for</strong> ${escapeHtml(unmatched.map((lang) => lang.name).join(", "))}</div>`);
	const sections = search.languages
		.filter((lang) => !unmatched.includes(lang))
		.map((lang) => {
			const rows = lang.candidates.map((c) => candidateRow(ep, lang, c)).join("") + skipRow(ep, lang);
			const chosen = findCandidate(ep, lang.language, ep.choices.get(lang.language));
			const table = lang.candidates.length
				? `<table class="subsearch-table"><thead><tr><th></th><th>Rating</th><th>Release</th><th>Downloads</th><th>Sync</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
				: "";
			const leftOut = isBatch() && !languageAdded(lang.language) ? ' <span class="subsearch-flag poor">left out of every episode</span>' : "";
			return `<div class="subsearch-language">
				<h3>${escapeHtml(lang.name)} <span class="hdr-note">${escapeHtml(lang.language)}</span>${lang.extra ? ' <span class="subsearch-flag">more</span>' : ""}${leftOut}</h3>
				${lang.note ? `<div class="lang-filter-hint">${escapeHtml(lang.note)}</div>` : ""}
				${table}
				${chosen ? creditField(ep, lang.language, chosen) : ""}
			</div>`;
		})
		.join("");
	return `${nav}<div class="subsearch-summary">${summary.join("")}</div>${sections}`;
}

/** Every language found for any episode, in the order the searches list them. */
function batchLanguages(): SubtitleSearchLanguage[] {
	const seen = new Map<string, SubtitleSearchLanguage>();
	for (const ep of doneEpisodes()) {
		for (const lang of ep.search!.languages ?? []) if (!seen.has(lang.language)) seen.set(lang.language, lang);
		for (const p of ep.search!.present ?? []) if (!seen.has(p.language)) seen.set(p.language, { language: p.language, name: p.name, candidates: [] });
	}
	return [...seen.values()];
}

interface SourceRow {
	key: string;
	credit: string;
	/** Episodes that use it now. */
	picked: number;
	/** Episodes with a rated subtitle from it. */
	rated: number;
	/** Episodes where it was found but not downloaded yet. */
	untested: number;
}

/** The sources a language's subtitles credit, across every episode. */
function sourceRows(language: string): SourceRow[] {
	const rows = new Map<string, SourceRow>();
	for (const ep of doneEpisodes()) {
		const lang = ep.search!.languages?.find((l) => l.language === language);
		if (!lang) continue;
		const chosen = findCandidate(ep, language, ep.choices.get(language));
		const byKey = new Map<string, SubtitleSearchCandidate[]>();
		for (const c of lang.candidates) {
			if (c.status !== "rated" && c.status !== "untested") continue;
			const key = c.credit.toLowerCase();
			byKey.set(key, [...(byKey.get(key) ?? []), c]);
		}
		for (const [key, list] of byKey) {
			const row = rows.get(key) ?? { key, credit: list[0]!.credit, picked: 0, rated: 0, untested: 0 };
			if (chosen?.credit.toLowerCase() === key) row.picked++;
			if (list.some((c) => c.status === "rated")) row.rated++;
			else row.untested++;
			rows.set(key, row);
		}
	}
	return [...rows.values()].sort((a, b) => b.picked - a.picked || b.rated - a.rated || b.untested - a.untested);
}

function renderSourceRow(language: string, row: SourceRow): string {
	const rename = renames.get(language)?.get(row.key) ?? row.credit;
	const downloads = row.untested ? ` and downloads it for the ${row.untested} episode${row.untested === 1 ? "" : "s"} it was not tried on` : "";
	return `<tr${row.picked ? ' class="is-chosen"' : ""}>
		<td>${escapeHtml(row.credit)}</td>
		<td class="subsearch-num">${row.picked}</td>
		<td class="subsearch-num">${row.rated}</td>
		<td class="subsearch-num">${row.untested}</td>
		<td><input type="text" class="lang-filter-input subsearch-rename" maxlength="60" data-subsearch-rename="${escapeHtml(row.key)}" data-language="${escapeHtml(language)}" value="${escapeHtml(rename)}" placeholder="${escapeHtml(row.credit)}" /></td>
		<td><button class="btn btn-ghost btn-sm" type="button" data-subsearch-use="${escapeHtml(row.key)}" data-language="${escapeHtml(language)}" title="Picks its best subtitle on every episode that has one${downloads}"${trying || searching ? " disabled" : ""}>Use on every episode</button></td>
	</tr>`;
}

function renderBatchLanguage(lang: SubtitleSearchLanguage, done: Episode[]): string {
	const picked = pickedCount(lang.language);
	const present = done.filter((ep) => presentTrack(ep, lang.language)).length;
	const added = languageAdded(lang.language);
	const missing = done.filter((ep) => !ep.choices.has(lang.language) && !presentTrack(ep, lang.language)).map(episodeLabel);
	const notes: string[] = [];
	if (missing.length) notes.push(`No subtitle for ${missing.join(", ")}.`);
	if (present) notes.push(`${present} episode${present === 1 ? " has" : "s have"} it already and ${present === 1 ? "was" : "were"} not searched.`);
	if (!skippedLanguages.has(lang.language) && !added) notes.push("Left out, since it is not on every episode.");
	const rows = sourceRows(lang.language);
	return `<div class="subsearch-language${added ? "" : " is-left-out"}">
		<h3>
			<label class="subsearch-language-toggle"><input type="checkbox" data-subsearch-add="${escapeHtml(lang.language)}"${skippedLanguages.has(lang.language) ? "" : " checked"} />
			${escapeHtml(lang.name)}</label> <span class="hdr-note">${escapeHtml(lang.language)}</span>${lang.extra ? ' <span class="subsearch-flag">more</span>' : ""}
			<span class="hdr-note">${picked + present} of ${done.length} episodes</span>
		</h3>
		${notes.map((note) => `<div class="lang-filter-hint">${escapeHtml(note)}</div>`).join("")}
		${
			rows.length
				? `<table class="subsearch-table subsearch-sources"><thead><tr><th>Source</th><th>Used</th><th>Rated</th><th>Not tried</th><th>Credited as</th><th></th></tr></thead><tbody>${rows.map((row) => renderSourceRow(lang.language, row)).join("")}</tbody></table>`
				: ""
		}
	</div>`;
}

function episodeState(ep: Episode): string {
	if (ep.error) return `<span class="subsearch-flag poor" title="${escapeHtml(ep.error)}">failed</span>`;
	if (!ep.search) return '<span class="hdr-note">waiting</span>';
	if (ep.search.state === "running") return '<span class="hdr-note">searching</span>';
	const applied = [ep.applied.has("mux") ? "queued" : "", ep.applied.has("sidecar") ? "saved" : ""].filter(Boolean);
	return applied.map((label) => `<span class="subsearch-flag good">${label}</span>`).join("");
}

function matrixCell(ep: Episode, language: string): string {
	if (ep.search?.state !== "done") return "<td></td>";
	const c = findCandidate(ep, language, ep.choices.get(language));
	const present = presentTrack(ep, language);
	if (!c && present)
		return `<td><span class="subsearch-present" title="${escapeHtml(`Already in the video${present.title ? `: ${present.title}` : ""}. Not searched.`)}">✓</span></td>`;
	if (!c) return '<td><span class="subsearch-rating none">–</span></td>';
	return `<td><button type="button" class="subsearch-chip ${ratingClass(c.rating!)}" data-subsearch-focus="${episodes.indexOf(ep)}" title="${escapeHtml(c.release || c.fileName)}">${escapeHtml(creditFor(ep, language, c))} ${c.rating}</button></td>`;
}

/** Every episode at once: one source and credit per language for all of them, and what each one got. */
function renderBatch(): string {
	const done = doneEpisodes();
	const languages = batchLanguages();
	const found = languages.filter((lang) =>
		done.some(
			(ep) => presentTrack(ep, lang.language) || ep.search!.languages?.find((l) => l.language === lang.language)?.candidates.some((c) => c.status === "rated"),
		),
	);
	const nothing = languages.filter((lang) => !found.includes(lang));
	const summary: string[] = [`<div><strong>Episodes</strong> ${done.length} of ${episodes.length} searched</div>`];
	const remaining = [...done].reverse().find((ep) => ep.search!.remainingDownloads !== undefined)?.search!.remainingDownloads;
	if (remaining !== undefined) summary.push(`<div><strong>Downloads left today</strong> ${remaining}</div>`);
	if (nothing.length) summary.push(`<div><strong>No good subtitle for</strong> ${escapeHtml(nothing.map((lang) => lang.name).join(", "))}</div>`);
	const failed = episodes.filter((ep) => ep.error);
	if (failed.length) summary.push(`<div><strong>Failed</strong> ${escapeHtml(failed.map((ep) => `${fileName(ep.path)}: ${ep.error}`).join(". "))}</div>`);
	const every = `<label class="toggle-label subsearch-every"><input type="checkbox" id="subsearch-every"${everyEpisodeOnly() ? " checked" : ""} /> Only add languages found for every episode</label>`;
	const head = found
		.map((lang) => `<th class="${languageAdded(lang.language) ? "" : "is-left-out"}" title="${escapeHtml(lang.name)}">${escapeHtml(lang.language)}</th>`)
		.join("");
	const rows = episodes
		.map(
			(ep, index) => `<tr>
				<td class="subsearch-name"><button type="button" class="subsearch-episode-link" data-subsearch-focus="${index}" title="${escapeHtml(ep.path)}"${ep.search?.state === "done" ? "" : " disabled"}>${escapeHtml(episodeLabel(ep))}</button> ${episodeState(ep)}</td>
				${found.map((lang) => matrixCell(ep, lang.language)).join("")}
			</tr>`,
		)
		.join("");
	return `<div class="subsearch-summary">${summary.join("")}</div>
		${done.length ? every : ""}
		${found.map((lang) => renderBatchLanguage(lang, done)).join("")}
		<div class="subsearch-matrix"><table class="subsearch-table"><thead><tr><th>Episode</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>
		<div class="lang-filter-hint">Click an episode or a subtitle to see every subtitle found for it, try more and pick another.</div>`;
}

function renderResults(): void {
	const container = byId("subsearch-results");
	const ep = episodes[focus];
	if (isBatch() && !ep) container.innerHTML = episodes.some((e) => e.search || e.error) ? renderBatch() : "";
	else if (ep && (isBatch() || ep.search?.state === "done")) container.innerHTML = renderEpisode(ep);
	else container.innerHTML = "";
	updateButtons();
}

/** What gets added to an episode, with the credits that differ from the ones read from the names. */
function picksFor(ep: Episode): Array<{ language: string; key: string; credit?: string }> {
	return [...ep.choices]
		.filter(([language]) => languageAdded(language))
		.map(([language, key]) => {
			const c = findCandidate(ep, language, key);
			const credit = c ? creditFor(ep, language, c) : undefined;
			return { language, key, ...(c && credit !== c.credit ? { credit } : {}) };
		});
}

function updateButtons(): void {
	const busy = searching || trying !== null;
	const searchBtn = buttonById("subsearch-search");
	searchBtn.textContent = searching ? "Cancel" : "Search";
	searchBtn.disabled = !episodes.length || trying !== null;
	const ready = !busy && doneEpisodes().some((ep) => picksFor(ep).length > 0);
	const apply = buttonById("subsearch-apply");
	const sidecar = buttonById("subsearch-sidecar");
	apply.disabled = !ready;
	sidecar.disabled = !ready;
	apply.textContent = isBatch() ? "Add to videos" : "Add to video";
	sidecar.textContent = isBatch() ? "Save next to videos" : "Save next to video";
}

function renderVideo(): void {
	const button = byId("subsearch-choose");
	button.textContent = episodes.length ? "Change videos..." : "Choose videos...";
	if (!episodes.length) byId("subsearch-video-selection").innerHTML = '<span class="repair-file-empty">No video selected</span>';
	else if (!isBatch())
		byId("subsearch-video-selection").innerHTML =
			`<span class="repair-file-name" title="${escapeHtml(episodes[0]!.path)}">${escapeHtml(fileName(episodes[0]!.path))}</span><span class="repair-file-folder">${escapeHtml(episodes[0]!.path)}</span>`;
	else {
		const folders = [...new Set(episodes.map((ep) => ep.path.slice(0, ep.path.lastIndexOf("/"))))];
		byId("subsearch-video-selection").innerHTML =
			`<span class="repair-file-name">${episodes.length} videos</span><span class="repair-file-folder" title="${escapeHtml(episodes.map((ep) => fileName(ep.path)).join("\n"))}">${escapeHtml(folders.length === 1 ? folders[0] : `${folders.length} folders`)}</span>`;
	}
	updateSubtitleSearchKind();
	updateButtons();
}

function cancelRunning(): void {
	for (const ep of episodes) if (ep.search?.state === "running") void cancelSubtitleSearch(ep.search.searchId);
}

function resetResults(): void {
	cancelRunning();
	run++;
	searching = false;
	trying = null;
	focus = isBatch() ? -1 : 0;
	episodes = episodes.map((ep) => ({ path: ep.path, search: null, error: "", choices: new Map(), credits: new Map(), applied: new Set() }));
	renames.clear();
	skippedLanguages.clear();
	expanded.clear();
	setStatus("");
	setError("");
	renderResults();
}

/** Searches one video and waits for it. Throws when the search fails. */
async function searchEpisode(ep: Episode, current: number, index: number, payload: SearchOptions): Promise<void> {
	const progress = () => {
		const seconds = Math.round((Date.now() - startedAt) / 1000);
		const prefix = isBatch() ? `${index + 1} of ${episodes.length}: ` : "";
		setStatus(`${prefix}${ep.search?.message || "Searching"}... ${seconds} s`);
	};
	ep.search = await startSubtitleSearch(ep.path, ...payload);
	renderResults();
	while (current === run && ep.search.state === "running") {
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
		if (current !== run) return;
		ep.search = await fetchSubtitleSearch(ep.search.searchId);
		if (current !== run) return;
		progress();
	}
	if (ep.search.state === "error") throw new Error(ep.search.error || "Subtitle search failed");
	for (const lang of ep.search.languages ?? []) if (lang.bestKey) ep.choices.set(lang.language, lang.bestKey);
}

export function openSubtitleSearch(): void {
	byId("subsearch-modal").style.display = "";
	const input = inputById("subsearch-languages");
	if (!input.value) input.value = defaultLanguages();
	const preferred = inputById("subsearch-preferred");
	if (!preferred.dataset.ready) {
		preferred.value = (appState.defaults?.subtitleDownloadPreferredSources ?? []).join(", ");
		preferred.dataset.ready = "1";
	}
	const extra = byId<HTMLSelectElement>("subsearch-extra");
	if (!extra.dataset.ready) {
		extra.value = localStorage.getItem(EXTRA_STORAGE_KEY) ?? String(appState.defaults?.subtitleDownloadExtraLanguages ?? 0);
		extra.dataset.ready = "1";
	}
	const present = inputById("subsearch-present");
	if (!present.dataset.ready) {
		present.checked = localStorage.getItem(PRESENT_STORAGE_KEY) === "1";
		present.dataset.ready = "1";
	}
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
	openSubtitleSearchPicker(
		episodes.map((ep) => ep.path),
		(paths) => {
			cancelRunning();
			episodes = paths.map((path) => ({ path, search: null, error: "", choices: new Map(), credits: new Map(), applied: new Set() }));
			for (const id of ["subsearch-title", "subsearch-year", "subsearch-season", "subsearch-episode", "subsearch-imdb"]) inputById(id).value = "";
			kindSelect().value = "";
			setDetectedKind();
			resetResults();
			renderVideo();
		},
	);
}

/** Stops a running search. The episodes already searched keep their results. */
function stopSearch(): void {
	cancelRunning();
	run++;
	searching = false;
	for (const ep of episodes) {
		if (ep.search?.state !== "running") continue;
		ep.search = null;
		ep.error = "Search cancelled";
	}
	setStatus(isBatch() ? `Cancelled after ${doneEpisodes().length} of ${episodes.length} episodes` : "");
	if (!isBatch()) resetResults();
	renderResults();
}

export async function runSubtitleSearch(): Promise<void> {
	if (searching) return stopSearch();
	const languages = parseLanguages(inputById("subsearch-languages").value);
	if (!episodes.length) return setError("Choose a video first");
	const extraLanguages = Number(byId<HTMLSelectElement>("subsearch-extra").value) || 0;
	if (!languages.length && !extraLanguages) return setError("Enter at least one language, such as slv, eng");
	resetResults();
	const current = run;
	try {
		localStorage.setItem(STORAGE_KEY, languages.join(", "));
		localStorage.setItem(EXTRA_STORAGE_KEY, String(extraLanguages));
		localStorage.setItem(PRESENT_STORAGE_KEY, inputById("subsearch-present").checked ? "1" : "0");
	} catch {}
	startedAt = Date.now();
	searching = true;
	setStatus("Starting...");
	updateButtons();
	const payload: SearchOptions = [
		languages,
		readIdentity(),
		extraLanguages,
		parseLanguages(inputById("subsearch-preferred").value),
		inputById("subsearch-present").checked,
	];
	// One video at a time, since each search reads a whole video and downloads from the same account.
	for (const [index, ep] of episodes.entries()) {
		if (current !== run) return;
		try {
			await searchEpisode(ep, current, index, payload);
		} catch (error) {
			if (current !== run) return;
			ep.search = null;
			ep.error = errorMessage(error);
			if (!isBatch()) setError(ep.error);
		}
		if (current !== run) return;
		renderResults();
	}
	searching = false;
	const done = doneEpisodes();
	if (done.length) {
		if (!kindSelect().value) setDetectedKind(done[0]!.search!.identity?.kind);
		if (isBatch()) setStatus(`Searched ${done.length} of ${episodes.length} episodes`);
		else {
			const search = done[0]!.search!;
			const found = search.languages?.filter((l) => l.bestKey).length ?? 0;
			setStatus(`Found ${found} of ${search.languages?.length ?? 0} language${search.languages?.length === 1 ? "" : "s"}`);
		}
	} else setStatus("");
	renderResults();
}

export function handleSubtitleSearchResultsClick(event: MouseEvent): void {
	const target = event.target instanceof Element ? event.target : null;
	const focusBtn = target?.closest<HTMLElement>("[data-subsearch-focus]");
	if (focusBtn) {
		const index = Number(focusBtn.dataset.subsearchFocus);
		focus = index >= 0 && index < episodes.length ? index : -1;
		renderResults();
		byId("subsearch-results").scrollIntoView({ block: "start" });
		return;
	}
	const samples = target?.closest<HTMLElement>("[data-subsearch-samples]");
	if (samples) {
		const key = samples.dataset.subsearchSamples!;
		if (expanded.has(key)) expanded.delete(key);
		else expanded.add(key);
		renderResults();
	}
	const tryBtn = target?.closest<HTMLElement>("[data-subsearch-try]");
	const ep = episodes[focus];
	if (tryBtn?.dataset.language && ep) void tryCandidate(ep, tryBtn.dataset.language, tryBtn.dataset.subsearchTry!);
	const useBtn = target?.closest<HTMLElement>("[data-subsearch-use]");
	if (useBtn?.dataset.language) void useSourceEverywhere(useBtn.dataset.language, useBtn.dataset.subsearchUse!);
}

/** Downloads and rates a candidate, and picks it when it beats the current pick. Returns it as rated, or undefined. */
async function rateCandidate(ep: Episode, language: string, key: string): Promise<SubtitleSearchCandidate | undefined> {
	ep.search = await trySubtitleSearchCandidate(ep.search!.searchId, language, key);
	const tried = findCandidate(ep, language, key);
	return tried?.status === "rated" ? tried : undefined;
}

async function tryCandidate(ep: Episode, language: string, key: string): Promise<void> {
	if (!ep.search || trying) return;
	const current = run;
	trying = key;
	setError("");
	setStatus("Downloading and syncing...");
	renderResults();
	try {
		const tried = await rateCandidate(ep, language, key);
		if (current !== run) return;
		const chosen = findCandidate(ep, language, ep.choices.get(language));
		// A subtitle asked for by hand is picked when it beats the current pick.
		if (tried && (!chosen || tried.rating! > chosen.rating!)) ep.choices.set(language, key);
		setStatus(tried ? `Rated ${tried.rating}` : (findCandidate(ep, language, key)?.reason ?? ""));
	} catch (error) {
		if (current !== run) return;
		setStatus("");
		setError(errorMessage(error));
	} finally {
		if (current === run) trying = null;
	}
	renderResults();
}

/**
 * Picks the best subtitle of one source on every episode, downloading its
 * untested ones where it has no rated subtitle yet. Episodes without it keep
 * their pick.
 */
async function useSourceEverywhere(language: string, sourceKey: string): Promise<void> {
	if (trying || searching) return;
	const current = run;
	trying = "batch";
	setError("");
	const done = doneEpisodes();
	const without: string[] = [];
	let credit = sourceKey;
	try {
		for (const [index, ep] of done.entries()) {
			const lang = ep.search!.languages?.find((l) => l.language === language);
			const matches = (lang?.candidates ?? []).filter((c) => c.credit.toLowerCase() === sourceKey);
			if (matches[0]) credit = matches[0].credit;
			let best = matches.filter((c) => c.status === "rated").sort((a, b) => b.rating! - a.rating!)[0];
			for (const c of matches.filter((m) => m.status === "untested").slice(0, best ? 0 : TRIES_PER_EPISODE)) {
				setStatus(`Trying ${credit} for ${episodeLabel(ep)}, ${index + 1} of ${done.length}...`);
				renderResults();
				best = await rateCandidate(ep, language, c.key);
				if (current !== run) return;
				if (best) break;
			}
			if (best) ep.choices.set(language, best.key);
			else without.push(episodeLabel(ep));
		}
		setStatus(
			`${credit} is used on ${done.length - without.length} of ${done.length} episodes${without.length ? `. Not found for ${without.join(", ")}` : ""}`,
		);
	} catch (error) {
		if (current !== run) return;
		setStatus("");
		setError(errorMessage(error));
	} finally {
		if (current === run) trying = null;
	}
	renderResults();
}

export function handleSubtitleSearchResultsChange(event: Event): void {
	const input = event.target as HTMLInputElement;
	if (input.id === "subsearch-every") {
		try {
			localStorage.setItem(EVERY_STORAGE_KEY, input.checked ? "1" : "0");
		} catch {}
		renderResults();
		return;
	}
	const added = input.dataset?.subsearchAdd;
	if (added) {
		if (input.checked) skippedLanguages.delete(added);
		else skippedLanguages.add(added);
		renderResults();
		return;
	}
	const renameKey = input.dataset?.subsearchRename;
	if (renameKey && input.dataset.language) {
		const original = sourceRows(input.dataset.language).find((row) => row.key === renameKey)?.credit;
		const value = input.value.replace(/[[\]]/g, "").trim();
		const map = renames.get(input.dataset.language) ?? new Map<string, string>();
		if (!value || value === original) map.delete(renameKey);
		else map.set(renameKey, value);
		renames.set(input.dataset.language, map);
		// A name typed for one episode gives way to the one typed for all of them.
		for (const ep of doneEpisodes())
			for (const c of ep.search!.languages?.find((l) => l.language === input.dataset.language)?.candidates ?? [])
				if (c.credit.toLowerCase() === renameKey) ep.credits.delete(c.key);
		renderResults();
		return;
	}
	const ep = episodes[focus];
	if (!ep) return;
	const creditKey = input.dataset?.subsearchCredit;
	if (creditKey && input.dataset.language) {
		const candidate = findCandidate(ep, input.dataset.language, creditKey);
		const value = input.value.trim();
		const fallback = candidate && (renames.get(input.dataset.language)?.get(candidate.credit.toLowerCase()) ?? candidate.credit);
		if (!value || value === fallback) ep.credits.delete(creditKey);
		else ep.credits.set(creditKey, value);
		return;
	}
	const key = input.dataset?.subsearchChoose;
	if (key === undefined || !input.dataset.language) return;
	if (key) ep.choices.set(input.dataset.language, key);
	else ep.choices.delete(input.dataset.language);
	renderResults();
}

export async function applySubtitleSearch(mode: "mux" | "sidecar"): Promise<void> {
	const targets = doneEpisodes().filter((ep) => picksFor(ep).length > 0 && (!isBatch() || !ep.applied.has(mode)));
	if (!targets.length) {
		if (isBatch()) setStatus(mode === "mux" ? "Every episode is queued already" : "Every episode is saved already");
		return;
	}
	buttonById("subsearch-apply").disabled = true;
	buttonById("subsearch-sidecar").disabled = true;
	setError("");
	const failures: string[] = [];
	const files: string[] = [];
	for (const [index, ep] of targets.entries()) {
		if (isBatch()) setStatus(`${mode === "mux" ? "Queueing" : "Saving"} ${index + 1} of ${targets.length}...`);
		try {
			const result = await applyVideoSubtitles(ep.search!.searchId, picksFor(ep), mode);
			ep.applied.add(mode);
			files.push(...(result.files ?? []));
		} catch (error) {
			failures.push(isBatch() ? `${episodeLabel(ep)}: ${errorMessage(error)}` : errorMessage(error));
		}
	}
	const succeeded = targets.length - failures.length;
	if (failures.length) setError(failures.join(". "));
	if (!isBatch()) {
		if (succeeded) setStatus(mode === "sidecar" ? `Saved ${files.join(", ")}` : "Queued. The subtitles are added when the job runs.");
	} else if (succeeded)
		setStatus(
			mode === "sidecar"
				? `Saved ${files.length} file${files.length === 1 ? "" : "s"} next to ${succeeded} video${succeeded === 1 ? "" : "s"}`
				: `Queued ${succeeded} video${succeeded === 1 ? "" : "s"}. The subtitles are added when the jobs run.`,
		);
	if (mode === "mux" && succeeded) await update();
	renderResults();
}
