import { parseSrt } from "../subtitles/srt-edit";
import { dialogueStyleNames } from "../subtitles/ass-classifier";
import { dialogueLines } from "../translate/subtitle-translate";

export type SubFormat = "srt" | "ass";

export interface SubDocument {
	format: SubFormat;
	content: string;
}

export interface Interval {
	startMs: number;
	endMs: number;
}

export interface TextCue extends Interval {
	text: string;
}

/** Cues longer than this are usually a broken end time, so they are cut down. */
const MAX_CUE_MS = 12_000;

/** Visible dialogue cues of a document, sorted by start. ASS signs and songs are left out. */
export function dialogueCues(doc: SubDocument): TextCue[] {
	let isDialogue = (_style: string) => true;
	if (doc.format === "ass") {
		const styles = dialogueStyleNames(doc.content);
		if (styles.size > 0) isDialogue = (style) => styles.has(style);
	}
	return dialogueLines(doc.content, doc.format, isDialogue)
		.map((line) => ({
			startMs: line.startMs,
			endMs: Math.min(line.endMs, line.startMs + MAX_CUE_MS),
			text: line.text
				.replace(/<[^>]+>/g, "")
				.replace(/\s+/g, " ")
				.trim(),
		}))
		.filter((cue) => cue.text && cue.endMs > cue.startMs)
		.sort((a, b) => a.startMs - b.startMs);
}

/** Sorted, non-overlapping union of intervals. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
	const sorted = intervals.filter((i) => i.endMs > i.startMs).sort((a, b) => a.startMs - b.startMs);
	const out: Interval[] = [];
	for (const i of sorted) {
		const last = out[out.length - 1];
		if (last && i.startMs <= last.endMs) last.endMs = Math.max(last.endMs, i.endMs);
		else out.push({ startMs: i.startMs, endMs: i.endMs });
	}
	return out;
}

export function totalMs(intervals: Interval[]): number {
	let sum = 0;
	for (const i of intervals) sum += i.endMs - i.startMs;
	return sum;
}

/**
 * Turns a cue's original start time into its synced start. Each piece shifts
 * the cues that start at or after its `fromMs`, after the whole file is
 * scaled for a frame rate change.
 */
export interface TimeMap {
	scale: number;
	pieces: Array<{ fromMs: number; offsetMs: number }>;
}

export const IDENTITY_MAP: TimeMap = { scale: 1, pieces: [{ fromMs: 0, offsetMs: 0 }] };

export function offsetAt(map: TimeMap, startMs: number): number {
	let offset = map.pieces[0]?.offsetMs ?? 0;
	for (const piece of map.pieces) {
		if (piece.fromMs > startMs) break;
		offset = piece.offsetMs;
	}
	return offset;
}

/** Both ends of a cue move with the piece its start belongs to, so no cue is stretched. */
export function mapCue<T extends Interval>(cue: T, map: TimeMap): T {
	const offset = offsetAt(map, cue.startMs);
	return { ...cue, startMs: Math.round(cue.startMs * map.scale + offset), endMs: Math.round(cue.endMs * map.scale + offset) };
}

/**
 * Maps a cue through a map whose pieces are real cuts, as found between two
 * releases, and `removed`, the sorted parts of the source the target lacks.
 * A cue inside a removed part is dropped and one reaching into it is cut to
 * the rest. A cue running across a cut ends by its own piece, so it closes
 * the gap a removed part leaves. Where the target has footage the source
 * lacks, the cue ends where that footage starts, not after it. Returns null
 * for a cue with nothing left.
 */
export function mapCueAcrossCuts<T extends Interval>(cue: T, map: TimeMap, removed: Interval[] = []): T | null {
	// Zero-length lines, such as comments, keep their length unless they fall in a removed part.
	if (cue.endMs <= cue.startMs) {
		if (removed.some((r) => cue.startMs >= r.startMs && cue.startMs < r.endMs)) return null;
		return mapCue(cue, map);
	}
	let start = cue.startMs;
	let end = cue.endMs;
	for (const r of removed) {
		if (start >= r.startMs && start < r.endMs) start = r.endMs;
		if (end > r.startMs && end <= r.endMs) end = r.startMs;
	}
	if (end <= start) return null;
	let offset = offsetAt(map, start);
	for (const piece of map.pieces) {
		if (piece.fromMs <= start) continue;
		if (piece.fromMs > end) break;
		if (piece.offsetMs > offset) {
			end = piece.fromMs;
			break;
		}
		offset = piece.offsetMs;
	}
	const mappedStart = Math.round(start * map.scale + offsetAt(map, start));
	const mappedEnd = Math.round(end * map.scale + offset);
	return mappedEnd > mappedStart ? { ...cue, startMs: mappedStart, endMs: mappedEnd } : null;
}

export interface RetimeOptions {
	/** The map's pieces are real cuts, so cues are mapped with `mapCueAcrossCuts`. */
	acrossCuts?: boolean;
	/** With `acrossCuts`, parts of the source the target lacks. */
	removed?: Interval[];
}

function pad(n: number, width = 2): string {
	return String(n).padStart(width, "0");
}

function srtTime(ms: number): string {
	const v = Math.max(0, Math.round(ms));
	return `${pad(Math.floor(v / 3_600_000))}:${pad(Math.floor(v / 60_000) % 60)}:${pad(Math.floor(v / 1000) % 60)},${pad(v % 1000, 3)}`;
}

function assTime(ms: number): string {
	const v = Math.max(0, Math.round(ms / 10) * 10);
	return `${Math.floor(v / 3_600_000)}:${pad(Math.floor(v / 60_000) % 60)}:${pad(Math.floor(v / 1000) % 60)}.${pad(Math.floor((v % 1000) / 10))}`;
}

const ASS_EVENT_RE = /^(\s*(?:Dialogue|Comment)\s*:\s*[^,]*,)([^,]*),([^,]*),/i;

function parseAssTime(tc: string): number | null {
	const m = tc.trim().match(/^(\d+):(\d{2}):(\d{2})[.:](\d{1,3})$/);
	if (!m) return null;
	return parseInt(m[1]!, 10) * 3_600_000 + parseInt(m[2]!, 10) * 60_000 + parseInt(m[3]!, 10) * 1000 + parseInt(m[4]!.padEnd(2, "0").slice(0, 2), 10) * 10;
}

/**
 * Rewrites every timestamp of a document with the time map. SRT is rebuilt
 * from its cues, ASS keeps every line and only its Start and End fields change.
 * Cues that would end before zero are dropped. With `endMs`, the video's
 * length, cues after it are dropped and cues running past it are cut, so the
 * track never makes the file longer than its video.
 */
export function retimeDocument(doc: SubDocument, map: TimeMap, endMs?: number, options: RetimeOptions = {}): SubDocument {
	const limit = endMs && endMs > 0 ? endMs : Infinity;
	const removed = options.acrossCuts ? mergeIntervals(options.removed ?? []) : [];
	const retime = <T extends Interval>(cue: T): T | null => {
		const mapped = options.acrossCuts ? mapCueAcrossCuts(cue, map, removed) : mapCue(cue, map);
		if (!mapped) return null;
		mapped.endMs = Math.min(mapped.endMs, limit);
		return mapped.endMs > 0 && mapped.startMs < limit ? mapped : null;
	};
	if (doc.format === "srt") {
		const cues = parseSrt(doc.content)
			.map(retime)
			.filter((cue) => cue !== null)
			.sort((a, b) => a.startMs - b.startMs);
		const out = cues.map((cue, i) => `${i + 1}\n${srtTime(cue.startMs)} --> ${srtTime(cue.endMs)}\n${cue.text}\n`);
		return { format: "srt", content: out.join("\n") };
	}
	const lines = doc.content.split(/\r?\n/);
	const out: string[] = [];
	for (const line of lines) {
		const m = line.match(ASS_EVENT_RE);
		const start = m ? parseAssTime(m[2]!) : null;
		const end = m ? parseAssTime(m[3]!) : null;
		if (!m || start === null || end === null) {
			out.push(line);
			continue;
		}
		const mapped = retime({ startMs: start, endMs: end });
		if (!mapped) continue;
		out.push(`${m[1]}${assTime(mapped.startMs)},${assTime(mapped.endMs)},${line.slice(m[0].length)}`);
	}
	return { format: "ass", content: out.join("\n") };
}
