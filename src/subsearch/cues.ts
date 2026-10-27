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
export function retimeDocument(doc: SubDocument, map: TimeMap, endMs?: number): SubDocument {
	const limit = endMs && endMs > 0 ? endMs : Infinity;
	const clip = <T extends Interval>(cue: T): T => ({ ...cue, endMs: Math.min(cue.endMs, limit) });
	if (doc.format === "srt") {
		const cues = parseSrt(doc.content)
			.map((cue) => clip(mapCue(cue, map)))
			.filter((cue) => cue.endMs > 0 && cue.startMs < limit)
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
		const mapped = clip(mapCue({ startMs: start, endMs: end }, map));
		if (mapped.endMs <= 0 || mapped.startMs >= limit) continue;
		out.push(`${m[1]}${assTime(mapped.startMs)},${assTime(mapped.endMs)},${line.slice(m[0].length)}`);
	}
	return { format: "ass", content: out.join("\n") };
}
