import { buildSrt, parseSrt } from "./srt-edit";
import { assTimeToMs, parseAssEvents } from "./ass-edit";

export type SubtitleEditorFormat = "srt" | "ass" | "ssa" | "bitmap";
export interface SubtitleEditorCue {
	id: number;
	startMs: number;
	endMs: number;
	text: string;
	style?: string;
}
export interface SubtitleEditorEdit {
	trackId: number;
	offsetMs: number;
	cues: SubtitleEditorCue[];
}

export function editorFormat(codecId: string): SubtitleEditorFormat | null {
	if (codecId === "S_TEXT/UTF8") return "srt";
	if (codecId === "S_TEXT/ASS") return "ass";
	if (codecId === "S_TEXT/SSA") return "ssa";
	if (["S_HDMV/PGS", "S_VOBSUB", "S_DVBSUB"].includes(codecId)) return "bitmap";
	return null;
}

export function editorCues(document: string, format: SubtitleEditorFormat): SubtitleEditorCue[] {
	if (format === "srt") return parseSrt(document).map((cue, id) => ({ id, startMs: cue.startMs, endMs: cue.endMs, text: cue.text }));
	return parseAssEvents(document).events.map((cue) => ({ id: cue.lineNo, startMs: cue.startMs, endMs: cue.endMs, text: cue.rawText, style: cue.style }));
}

export function validateEditorEdit(raw: SubtitleEditorEdit): SubtitleEditorEdit {
	if (!raw || !Number.isInteger(raw.trackId) || raw.trackId < 0) throw new Error("Invalid subtitle track");
	if (!Number.isFinite(raw.offsetMs) || Math.abs(raw.offsetMs) > 86_400_000) throw new Error("Offset must be within 24 hours");
	if (!Array.isArray(raw.cues) || raw.cues.length > 100_000) throw new Error("Invalid subtitle cue edits");
	const seen = new Set<number>();
	for (const cue of raw.cues) {
		if (!cue || !Number.isInteger(cue.id) || cue.id < 0 || seen.has(cue.id)) throw new Error("Invalid or duplicate cue ID");
		seen.add(cue.id);
		if (!Number.isFinite(cue.startMs) || !Number.isFinite(cue.endMs) || cue.startMs < 0 || cue.endMs < cue.startMs || cue.endMs > 86_400_000)
			throw new Error("Cue end cannot precede its start, with times between 0 and 24 hours");
		if (typeof cue.text !== "string" || cue.text.length > 100_000 || cue.text.includes("\0")) throw new Error("Invalid subtitle text");
	}
	return { trackId: raw.trackId, offsetMs: Math.round(raw.offsetMs), cues: raw.cues };
}

/** ASS/SSA timestamps store centiseconds, so quantize the track offset once. */
export function effectiveEditorOffset(offsetMs: number, format: SubtitleEditorFormat): number {
	return format === "ass" || format === "ssa" ? Math.round(offsetMs / 10) * 10 : Math.round(offsetMs);
}

function timecode(ms: number, ass: boolean): string {
	const value = Math.max(0, ass ? Math.round(ms / 10) * 10 : Math.round(ms));
	const hours = Math.floor(value / 3_600_000);
	const minutes = Math.floor(value / 60_000) % 60;
	const seconds = Math.floor(value / 1000) % 60;
	const pad = (n: number, width = 2) => String(n).padStart(width, "0");
	return `${ass ? hours : pad(hours)}:${pad(minutes)}:${pad(seconds)}${ass ? "." + pad(Math.floor((value % 1000) / 10)) : "," + pad(value % 1000, 3)}`;
}

/** Changes actual cue timestamps, preserving ASS styles, tags, actors and event fields. */
export function editSubtitleDocument(document: string, format: SubtitleEditorFormat, raw: SubtitleEditorEdit): string {
	if (format === "bitmap") throw new Error("Bitmap subtitles require a track delay");
	const edit = validateEditorEdit(raw);
	const offset = effectiveEditorOffset(edit.offsetMs, format);
	const originals = editorCues(document, format);
	const known = new Set(originals.map((cue) => cue.id));
	const changes = new Map(edit.cues.map((cue) => [cue.id, cue]));
	if (edit.cues.some((cue) => !known.has(cue.id))) throw new Error("Subtitle cue no longer exists");
	if (format === "srt") {
		if (edit.cues.some((cue) => cue.endMs <= cue.startMs)) throw new Error("Edited SRT cues must last at least one millisecond");
		return buildSrt(
			parseSrt(document).flatMap((cue, id) => {
				const next = changes.get(id) || cue;
				const start = Math.max(0, next.startMs + offset);
				const end = next.endMs + offset;
				if (end <= 0) return [];
				if (Math.round(end) <= Math.round(start)) throw new Error("SRT cues must last at least one millisecond");
				if (/\n\s*\n/.test(next.text)) throw new Error("SRT text cannot contain blank lines inside a cue");
				const suffix = cue.timingLine.split(/\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}/).at(-1) || "";
				return [{ ...cue, text: next.text, timingLine: `${timecode(start, false)} --> ${timecode(end, false)}${suffix}` }];
			}),
		);
	}
	let inEvents = false;
	let fields: string[] = [];
	return document
		.split(/\r?\n/)
		.flatMap((line, id) => {
			if (line.trim().startsWith("[")) inEvents = line.trim().toLowerCase() === "[events]";
			if (!inEvents) return [line];
			if (/^\s*Format:/i.test(line))
				fields = line
					.slice(line.indexOf(":") + 1)
					.split(",")
					.map((field) => field.trim().toLowerCase());
			if (!/^\s*(Dialogue|Comment):/i.test(line)) return [line];
			const startIndex = fields.indexOf("start"),
				endIndex = fields.indexOf("end"),
				textIndex = fields.indexOf("text");
			if (startIndex < 0 || endIndex < 0 || textIndex !== fields.length - 1) throw new Error("Unsupported ASS event format");
			const colon = line.indexOf(":");
			const values = line.slice(colon + 1).split(",");
			const next = changes.get(id);
			if (!next && !offset) return [line];
			const originalStart = assTimeToMs(values[startIndex]!);
			const originalEnd = assTimeToMs(values[endIndex]!);
			const timingChanged = next && (next.startMs !== originalStart || next.endMs !== originalEnd);
			// Existing zero-length dialogue and comment events are common in ASS tracks.
			// Only newly edited timing must have a positive, representable duration.
			if (timingChanged && Math.round(next.endMs / 10) <= Math.round(next.startMs / 10)) throw new Error("Edited ASS cues must last at least one centisecond");
			const shiftedStart = Math.round((next?.startMs ?? originalStart) / 10) * 10 + offset;
			const end = Math.round((next?.endMs ?? originalEnd) / 10) * 10 + offset;
			if (end < 0 || (end === 0 && shiftedStart < 0)) return [];
			const start = Math.max(0, shiftedStart);
			values[startIndex] = timecode(start, true);
			values[endIndex] = timecode(end, true);
			if (next) values.splice(textIndex, values.length - textIndex, next.text.replace(/\r\n?|\n/g, "\\N"));
			return [line.slice(0, colon + 1) + values.join(",")];
		})
		.join("\n");
}
