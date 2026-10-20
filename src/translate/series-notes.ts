import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { Logger } from "../core/logger";
import { chatComplete, type LlmChatOptions } from "./llm-client";
import { stripCodeFences } from "./generic";
import type { TranslateLang } from "./translate-languages";

/**
 * Per-series notes for translators: characters with their gender, who speaks
 * formally to whom, and recurring terms. Built once from the first translated
 * episode, extended with new characters by later ones, and editable by hand.
 */
export interface SeriesNotes {
	key: string;
	title: string;
	notes: string;
	/** Episode file names already used to build or extend the notes. */
	episodes: string[];
	updatedAt: number;
}

const SECTIONS = ["Characters", "Forms of address", "Terms"];
/** Enough dialogue for a full episode, small enough to stay cheap. */
const MAX_TRANSCRIPT_CHARS = 60_000;

const EPISODE_MARKERS = [/\bS\d{1,2}\s?E\d{1,4}\b/i, /\b\d{1,2}x\d{2,3}\b/, /\s-\s\d{1,4}(?:v\d)?(?=\s|$)/, /\bE(?:p(?:isode)?)?\s?\d{1,4}\b/i];

/**
 * Series title from an episode file name, or null when nothing usable is left.
 * "[Group] Show - 01 [1080p].mkv", "Show (2023) - S01E01 - Title.mkv" and
 * "Show.S01E01.1080p.mkv" all give "Show". Seasons share one title on purpose.
 */
export function seriesTitleFromFilename(filename: string): string | null {
	let name = filename.replace(/\.[a-z0-9]{2,4}$/i, "");
	name = name.replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, " ");
	if (!/\s/.test(name.trim())) name = name.replace(/[._]/g, " ");
	let cut = name.length;
	for (const re of EPISODE_MARKERS) {
		const m = re.exec(name);
		if (m && m.index < cut) cut = m.index;
	}
	const title = name
		.slice(0, cut)
		.replace(/\s+/g, " ")
		.replace(/^[\s\-–_.]+|[\s\-–_.]+$/g, "");
	return /[\p{L}\p{N}]/u.test(title) ? title : null;
}

/** File-safe key for a title. Case and punctuation do not matter. */
export function seriesKey(title: string): string {
	return title
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 120);
}

/** Series notes live next to the persisted queue and settings. */
export function seriesNotesDir(config: { tempDir: string }): string {
	return join(config.tempDir, "series-notes");
}

function notesPath(dir: string, key: string): string {
	return join(dir, `${key}.json`);
}

export function loadSeriesNotes(dir: string, key: string): SeriesNotes | null {
	const file = notesPath(dir, key);
	if (!existsSync(file)) return null;
	try {
		const data = JSON.parse(readFileSync(file, "utf-8")) as Partial<SeriesNotes>;
		return {
			key,
			title: String(data.title ?? key),
			notes: String(data.notes ?? ""),
			episodes: Array.isArray(data.episodes) ? data.episodes.map(String) : [],
			updatedAt: Number(data.updatedAt) || 0,
		};
	} catch (err) {
		Logger.warn(`[translate] Could not read series notes ${file}: ${(err as Error).message}`);
		return null;
	}
}

export function saveSeriesNotes(dir: string, notes: SeriesNotes): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(notesPath(dir, notes.key), JSON.stringify(notes, null, 2));
}

export function listSeriesNotes(dir: string): SeriesNotes[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.map((f) => loadSeriesNotes(dir, f.slice(0, -5)))
		.filter((n): n is SeriesNotes => n !== null)
		.sort((a, b) => a.title.localeCompare(b.title));
}

export function deleteSeriesNotes(dir: string, key: string): boolean {
	const file = notesPath(dir, key);
	if (!existsSync(file)) return false;
	unlinkSync(file);
	return true;
}

const FORMAT = [
	`Characters:`,
	`- Name: gender (male, female or unknown); age group; role. Add known cover names and disguises, especially ones as another gender. Add a short note on speech style only when it is distinctive (very formal, childish, rough, archaic).`,
	`Forms of address:`,
	`- Who speaks formally or informally to whom, with the reason (e.g. "Ai -> Aqua: informal, mother and son").`,
	`Terms:`,
	`- Recurring names of places, groups, ranks, skills or items, with a short explanation.`,
].join("\n");

const RULES = [
	`- State only what the lines show or what is well known about this series. Write "unknown" rather than guessing a gender.`,
	`- Do not describe personality beyond speech style. No plot summaries and no spoilers.`,
	`- Write character names exactly as the subtitles spell them.`,
	`- Write the notes in English, even when the subtitles are in another language.`,
	`- Output only the notes, with no introduction and no markdown fences.`,
].join("\n");

export function buildCreatePrompt(title: string, source: TranslateLang, transcript: string): string {
	return [
		`You are preparing notes for translators of the series "${title}". The subtitles are in ${source.name}.`,
		`Using the subtitle lines below and what you reliably know about this series, write concise notes in this format:`,
		``,
		FORMAT,
		``,
		`Rules:`,
		RULES,
		`- Keep it under 40 lines.`,
		``,
		`Subtitle lines:`,
		transcript,
	].join("\n");
}

export function buildExtendPrompt(title: string, source: TranslateLang, existing: string, transcript: string): string {
	return [
		`You are maintaining notes for translators of the series "${title}". The subtitles are in ${source.name}.`,
		``,
		`Existing notes:`,
		existing,
		``,
		`Below are the subtitle lines of another episode. List only the characters, forms of address and terms that appear in these lines and are missing from the existing notes, using the same sections and format:`,
		``,
		FORMAT,
		``,
		`Rules:`,
		RULES,
		`- Do not repeat, correct or remove existing entries. Leave out sections with nothing new.`,
		`- If nothing is missing, reply with exactly NONE.`,
		``,
		`Subtitle lines:`,
		transcript,
	].join("\n");
}

function sectionOf(line: string): string | null {
	const t = line
		.trim()
		.replace(/^#+\s*/, "")
		.replace(/\*+/g, "")
		.replace(/:$/, "")
		.trim()
		.toLowerCase();
	return SECTIONS.find((s) => s.toLowerCase() === t) ?? null;
}

/** The text before the first ":" of a bullet, used to spot entries that already exist. */
function entryKey(line: string): string {
	return line
		.replace(/^\s*[-*]\s*/, "")
		.split(":")[0]!
		.trim()
		.toLowerCase();
}

/**
 * Add new bullets to the end of their section in the existing notes. Bullets
 * whose name already exists in that section are dropped, so the model cannot
 * overwrite what was there, including hand edits.
 */
export function mergeNotes(existing: string, additions: string): string {
	const add = stripCodeFences(additions).trim();
	if (!add || /^none\.?$/i.test(add)) return existing;

	const lines = existing.replace(/\s+$/, "").split("\n");
	const known = new Map<string, Set<string>>();
	let current: string | null = null;
	for (const line of lines) {
		const s = sectionOf(line);
		if (s) current = s;
		else if (current && /^\s*[-*]/.test(line)) {
			if (!known.has(current)) known.set(current, new Set());
			known.get(current)!.add(entryKey(line));
		}
	}

	const bySection = new Map<string, string[]>();
	current = null;
	for (const line of add.split("\n")) {
		const s = sectionOf(line);
		if (s) {
			current = s;
			continue;
		}
		if (!current || !/^\s*[-*]\s*\S/.test(line)) continue;
		const k = entryKey(line);
		if (known.get(current)?.has(k)) continue;
		if (!known.has(current)) known.set(current, new Set());
		known.get(current)!.add(k);
		if (!bySection.has(current)) bySection.set(current, []);
		bySection.get(current)!.push(line.trim());
	}
	if (bySection.size === 0) return existing;

	for (const [section, bullets] of bySection) {
		const header = lines.findIndex((l) => sectionOf(l) === section);
		if (header < 0) {
			if (lines.length && lines[lines.length - 1]!.trim()) lines.push("");
			lines.push(`${section}:`, ...bullets);
			continue;
		}
		let end = header + 1;
		while (end < lines.length && !sectionOf(lines[end]!)) end++;
		while (end > header + 1 && !lines[end - 1]!.trim()) end--;
		lines.splice(end, 0, ...bullets);
	}
	return lines.join("\n");
}

/** Dialogue as "Name: text" lines, trimmed to a size that keeps the request cheap. */
export function buildTranscript(lines: Array<{ name?: string; text: string }>): string {
	const out: string[] = [];
	let size = 0;
	for (const l of lines) {
		const text = l.text
			.replace(/\{[^}]*\}/g, "")
			.replace(/\\[Nnh]/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		if (!text) continue;
		const row = l.name?.trim() ? `${l.name.trim()}: ${text}` : text;
		if (size + row.length > MAX_TRANSCRIPT_CHARS) break;
		out.push(row);
		size += row.length + 1;
	}
	return out.join("\n");
}

export interface PrepareSeriesNotesParams {
	dir: string;
	/** Episode file name, used for the title and to skip episodes already seen. */
	filename: string;
	source: TranslateLang;
	lines: Array<{ name?: string; text: string }>;
	llm: LlmChatOptions;
}

const locks = new Map<string, Promise<unknown>>();

/** Run one series' updates one after another, so parallel episodes don't overwrite each other. */
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const prev = locks.get(key) ?? Promise.resolve();
	const next = prev.then(fn, fn);
	locks.set(
		key,
		next.catch(() => {}),
	);
	return next;
}

/**
 * Notes for this episode's series, creating or extending them first when the
 * episode is new. A failed request only logs a warning and translation goes
 * on with whatever notes exist. Throws only when the job was cancelled.
 */
export async function prepareSeriesNotes(p: PrepareSeriesNotesParams): Promise<string | undefined> {
	const title = seriesTitleFromFilename(p.filename);
	if (!title) return undefined;
	const key = seriesKey(title);
	if (!key) return undefined;

	return withLock(key, async () => {
		const stored = loadSeriesNotes(p.dir, key);
		if (stored?.episodes.includes(p.filename)) return stored.notes || undefined;

		const transcript = buildTranscript(p.lines);
		if (!transcript) return stored?.notes || undefined;

		const hasNotes = !!stored?.notes.trim();
		const prompt = hasNotes ? buildExtendPrompt(stored!.title, p.source, stored!.notes, transcript) : buildCreatePrompt(title, p.source, transcript);
		try {
			const reply = await chatComplete(prompt, p.llm);
			const notes = hasNotes ? mergeNotes(stored!.notes, reply) : stripCodeFences(reply).trim();
			const next: SeriesNotes = {
				key,
				title: stored?.title ?? title,
				notes,
				episodes: [...(stored?.episodes ?? []), p.filename],
				updatedAt: Date.now(),
			};
			saveSeriesNotes(p.dir, next);
			Logger.info(`[translate] ${hasNotes ? (notes === stored!.notes ? "No new" : "Extended") : "Created"} series notes for "${next.title}"`);
			return notes || undefined;
		} catch (err) {
			if (p.llm.signal?.aborted) throw err;
			Logger.warn(`[translate] Could not ${hasNotes ? "extend" : "create"} series notes for "${title}": ${(err as Error).message}`);
			return stored?.notes || undefined;
		}
	});
}
