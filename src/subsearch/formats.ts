import { parseSrt } from "../subtitles/srt-edit";
import type { SubDocument } from "./cues";

/** Codepage most subtitles of a language use when they are not Unicode. */
const LEGACY_CODEPAGE: Record<string, string> = {
	sl: "windows-1250",
	hr: "windows-1250",
	bs: "windows-1250",
	cs: "windows-1250",
	sk: "windows-1250",
	pl: "windows-1250",
	hu: "windows-1250",
	ro: "windows-1250",
	sq: "windows-1250",
	sr: "windows-1250",
	ru: "windows-1251",
	uk: "windows-1251",
	bg: "windows-1251",
	be: "windows-1251",
	mk: "windows-1251",
	el: "windows-1253",
	tr: "windows-1254",
	he: "windows-1255",
	ar: "windows-1256",
	fa: "windows-1256",
	lt: "windows-1257",
	lv: "windows-1257",
	et: "windows-1257",
	vi: "windows-1258",
	th: "windows-874",
	ja: "shift_jis",
	ko: "euc-kr",
	zh: "gbk",
};

/** Serbian subtitles come in Latin (1250) and Cyrillic (1251), so pick by which reads as letters. */
const CYRILLIC_OR_LATIN = new Set(["sr", "bs", "mk"]);

function decodeWith(bytes: Uint8Array, encoding: string): string {
	return new TextDecoder(encoding).decode(bytes);
}

function cyrillicShare(text: string): number {
	const letters = text.match(/\p{L}/gu)?.length ?? 0;
	const cyrillic = text.match(/\p{Script=Cyrillic}/gu)?.length ?? 0;
	return letters ? cyrillic / letters : 0;
}

/** Decodes a subtitle file to text. Unicode is detected, anything else is read with the language's usual codepage. */
export function decodeSubtitleBytes(bytes: Uint8Array, language?: string): string {
	if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return decodeWith(bytes.subarray(3), "utf-8");
	if (bytes[0] === 0xff && bytes[1] === 0xfe) return decodeWith(bytes.subarray(2), "utf-16le");
	if (bytes[0] === 0xfe && bytes[1] === 0xff) return decodeWith(bytes.subarray(2), "utf-16be");
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {}
	const base = (language ?? "").toLowerCase().split("-")[0] ?? "";
	if (CYRILLIC_OR_LATIN.has(base)) {
		const cyrillic = decodeWith(bytes, "windows-1251");
		return cyrillicShare(cyrillic) > 0.5 ? cyrillic : decodeWith(bytes, "windows-1250");
	}
	return decodeWith(bytes, LEGACY_CODEPAGE[base] ?? "windows-1252");
}

function srtFromCues(cues: Array<{ startMs: number; endMs: number; text: string }>): string {
	const pad = (n: number, w = 2) => String(n).padStart(w, "0");
	const tc = (ms: number) => {
		const v = Math.max(0, Math.round(ms));
		return `${pad(Math.floor(v / 3_600_000))}:${pad(Math.floor(v / 60_000) % 60)}:${pad(Math.floor(v / 1000) % 60)},${pad(v % 1000, 3)}`;
	};
	return cues.map((cue, i) => `${i + 1}\n${tc(cue.startMs)} --> ${tc(cue.endMs)}\n${cue.text}\n`).join("\n");
}

const VTT_TIME_RE = /^(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})\s+-->\s+(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})/;

function vttToSrt(text: string): string {
	const cues: Array<{ startMs: number; endMs: number; text: string }> = [];
	for (const block of text.replace(/^﻿/, "").split(/\r?\n\r?\n+/)) {
		const lines = block.split(/\r?\n/);
		const at = lines.findIndex((line) => VTT_TIME_RE.test(line.trim()));
		if (at < 0) continue;
		const m = lines[at]!.trim().match(VTT_TIME_RE)!;
		const ms = (h: string | undefined, mi: string, s: string, f: string) =>
			parseInt(h ?? "0", 10) * 3_600_000 + parseInt(mi, 10) * 60_000 + parseInt(s, 10) * 1000 + parseInt(f, 10);
		const body = lines
			.slice(at + 1)
			.join("\n")
			.replace(/<(?!\/?[ibu]>)[^>]+>/g, "")
			.trim();
		if (body) cues.push({ startMs: ms(m[1], m[2]!, m[3]!, m[4]!), endMs: ms(m[5], m[6]!, m[7]!, m[8]!), text: body });
	}
	return srtFromCues(cues);
}

const MICRODVD_RE = /^\{(\d+)\}\{(\d+)\}(.*)$/;

/** MicroDVD counts frames. A first cue of `{1}{1}25.000` states the frame rate. */
function microDvdToSrt(text: string, fps: number): string {
	const cues: Array<{ startMs: number; endMs: number; text: string }> = [];
	let rate = fps;
	for (const line of text.split(/\r?\n/)) {
		const m = line.trim().match(MICRODVD_RE);
		if (!m) continue;
		const declared = parseFloat(m[3]!);
		if (cues.length === 0 && m[1] === m[2] && /^\d+(?:\.\d+)?$/.test(m[3]!.trim()) && declared > 10 && declared < 121) {
			rate = declared;
			continue;
		}
		const body = m[3]!
			.replace(/\{[^}]*\}/g, "")
			.split("|")
			.join("\n")
			.trim();
		if (body) cues.push({ startMs: (parseInt(m[1]!, 10) / rate) * 1000, endMs: (parseInt(m[2]!, 10) / rate) * 1000, text: body });
	}
	return srtFromCues(cues);
}

/** Turns a downloaded subtitle into SRT or ASS text, or null when the format is unknown. */
export function toSubDocument(text: string, fileName: string, videoFps: number): SubDocument | null {
	const body = text.replace(/^﻿/, "");
	const ext = fileName.toLowerCase().split(".").pop() ?? "";
	if (/^\s*\[Script Info\]/i.test(body) || ext === "ass" || ext === "ssa") return /\[Events\]/i.test(body) ? { format: "ass", content: body } : null;
	if (/^\s*WEBVTT/.test(body) || ext === "vtt") return { format: "srt", content: vttToSrt(body) };
	if (MICRODVD_RE.test(body.trimStart().split(/\r?\n/)[0] ?? "")) return { format: "srt", content: microDvdToSrt(body, videoFps || 23.976) };
	if (parseSrt(body).length > 0) return { format: "srt", content: body };
	return null;
}
