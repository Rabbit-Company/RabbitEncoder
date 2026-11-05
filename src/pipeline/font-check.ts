import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { basename, join } from "path";
import { randomUUID } from "crypto";
import { mapPool } from "../core/concurrency";
import { CancelledError, run } from "../core/process";
import type { FontCheckFile, FontCheckJobRequest, FontCheckMissing, FontCheckResult, RepairPlan, SubtitleAddFont, SubtitleFileFontSource } from "../core/types";
import { extractUsedFonts, normalizeFontName } from "../subtitles/ass-classifier";
import { auditTrack, identifyMatroska, sanitizeRepairPlan } from "./repair";
import { readInputFonts } from "./repair-fonts";
import { assFontSpellings, isWindowsFont } from "./subtitle-files";

const isAssCodec = (codecId: string | undefined) => codecId === "S_TEXT/ASS" || codecId === "S_TEXT/SSA";

/** The fonts one video's ASS tracks use that it does not carry, read from its whole subtitle text. */
export async function checkFileFonts(path: string, tempDir: string, signal?: AbortSignal): Promise<{ file: FontCheckFile; spellings: Map<string, string> }> {
	const identified = await identifyMatroska(path, signal);
	const tracks = (identified.tracks ?? []).filter((t) => t.type === "audio" || t.type === "subtitles");
	const file: FontCheckFile = { path, fileName: basename(path), families: [], missing: [], tracks: tracks.map(auditTrack) };
	const spellings = new Map<string, string>();
	const ass = tracks.filter((t) => t.type === "subtitles" && isAssCodec(t.properties.codec_id));
	if (!ass.length) return { file, spellings };

	const dir = join(tempDir, randomUUID());
	mkdirSync(dir, { recursive: true });
	try {
		const fonts = await readInputFonts(path, -1, join(dir, "fonts"), signal);
		file.families = [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
		const attached = new Set(fonts.flatMap((f) => f.names));
		// One mkvextract pass reads every ASS track, as the file is read through once either way.
		const outOf = (id: number) => join(dir, `track_${id}.ass`);
		const extract = await run(["mkvextract", path, "tracks", ...ass.map((t) => `${t.id}:${outOf(t.id)}`)], { signal });
		if (signal?.aborted) throw new CancelledError();
		if (extract.code !== 0 && extract.code !== 1) {
			file.error = `Could not read its subtitles: ${(extract.stderr || extract.stdout).trim().slice(-200)}`;
			return { file, spellings };
		}
		const used = new Set<string>();
		for (const track of ass) {
			if (!existsSync(outOf(track.id))) continue;
			const text = readFileSync(outOf(track.id), "utf-8");
			for (const name of extractUsedFonts(text)) used.add(name);
			for (const [key, name] of assFontSpellings(text)) if (!spellings.has(key)) spellings.set(key, name);
		}
		file.missing = [...used].filter((name) => !attached.has(name)).sort();
		return { file, spellings };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Checks every video, two at a time as each is read through from disk. */
export async function checkFolderFonts(
	folder: string,
	paths: string[],
	tempDir: string,
	onProgress: (done: number, current: string) => void,
	signal?: AbortSignal,
): Promise<FontCheckResult> {
	let done = 0;
	const spellings = new Map<string, string>();
	const files = await mapPool(paths, 2, async (path) => {
		onProgress(done, basename(path));
		let checked: FontCheckFile;
		try {
			const result = await checkFileFonts(path, tempDir, signal);
			for (const [key, name] of result.spellings) if (!spellings.has(key)) spellings.set(key, name);
			checked = result.file;
		} catch (error) {
			if (error instanceof CancelledError || signal?.aborted) throw new CancelledError();
			checked = { path, fileName: basename(path), families: [], missing: [], tracks: [], error: error instanceof Error ? error.message : String(error) };
		}
		onProgress(++done, basename(path));
		return checked;
	});
	return summarizeFontCheck(folder, files, spellings);
}

export function summarizeFontCheck(folder: string, files: FontCheckFile[], spellings: Map<string, string>): FontCheckResult {
	const missing = new Map<string, FontCheckMissing>();
	for (const file of files) {
		for (const key of file.missing) {
			const entry = missing.get(key) ?? { key, name: spellings.get(key) ?? key, files: 0, ...(isWindowsFont(key) ? { windows: true } : {}) };
			entry.files++;
			missing.set(key, entry);
		}
	}
	const families = new Map<string, number>();
	for (const file of files) for (const family of file.families) families.set(family, (families.get(family) ?? 0) + 1);
	const carried = [...families].map(([family, count]) => ({ family, files: count })).sort((a, b) => b.files - a.files || a.family.localeCompare(b.family));
	for (const entry of missing.values()) {
		const closest = closestFamily(entry.name, carried);
		if (closest) entry.closest = closest;
	}
	return {
		folder,
		files,
		missing: [...missing.values()].sort((a, b) => b.files - a.files || a.name.localeCompare(b.name)),
		families: carried,
	};
}

type FontKind = "sans" | "serif" | "mono" | "script" | "display";

const KNOWN_KINDS: Record<string, FontKind> = {
	arial: "sans",
	calibri: "sans",
	candara: "sans",
	corbel: "sans",
	tahoma: "sans",
	verdana: "sans",
	helvetica: "sans",
	"segoe ui": "sans",
	"trebuchet ms": "sans",
	"century gothic": "sans",
	"franklin gothic medium": "sans",
	"lucida sans unicode": "sans",
	"microsoft sans serif": "sans",
	"book antiqua": "serif",
	"bookman old style": "serif",
	cambria: "serif",
	constantia: "serif",
	garamond: "serif",
	georgia: "serif",
	"palatino linotype": "serif",
	sylfaen: "serif",
	"times new roman": "serif",
	"courier new": "mono",
	consolas: "mono",
	"lucida console": "mono",
	"comic sans ms": "script",
	gabriola: "script",
	"monotype corsiva": "script",
	"segoe print": "script",
	"segoe script": "script",
	impact: "display",
	"arial black": "display",
};

const STYLE_WORDS =
	/\b(?:bold|italic|oblique|regular|book|roman|light|thin|hairline|medium|black|heavy|semi ?bold|demi ?bold|extra ?bold|ultra ?bold|extra ?light|ultra ?light|condensed|cond|narrow|bd|bi|it|lt|md|std|pro|mt|ms)\b/g;

/** "Arial-BoldItalic" as "arial", so faces of one family read alike. */
function fontStem(name: string): string {
	return normalizeFontName(name.replace(/([a-z])([A-Z])/g, "$1 $2"))
		.replace(/[-_]+/g, " ")
		.replace(STYLE_WORDS, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** What kind of letters a font draws, guessed from its name. */
export function fontKind(name: string): FontKind | undefined {
	const key = normalizeFontName(name);
	if (KNOWN_KINDS[key]) return KNOWN_KINDS[key];
	const stem = fontStem(name);
	if (KNOWN_KINDS[stem]) return KNOWN_KINDS[stem];
	if (/mono|code|courier|consol|typewriter/.test(stem)) return "mono";
	if (/script|hand|brush|comic|marker|callig|cursive|\bpen\b|print|chalk|crayon/.test(stem)) return "script";
	if (/sans|gothic|grotesk|grotesque|\bui\b/.test(stem)) return "sans";
	if (/serif|antiqua|garamond|times|mincho|\bsong\b|\bming\b|\bslab\b/.test(stem)) return "serif";
	return undefined;
}

/**
 * The carried family most like a missing font, from its name alone: the same
 * family in another weight first, then one of the same kind, then the one most
 * videos carry, which is usually the dialogue font.
 */
export function closestFamily(name: string, families: { family: string; files: number }[]): string | undefined {
	const key = normalizeFontName(name);
	const candidates = families.filter((f) => normalizeFontName(f.family) !== key);
	if (!candidates.length) return undefined;
	const stem = fontStem(name);
	const kind = fontKind(name);
	const score = (family: string) => {
		const other = fontStem(family);
		if (stem && other && (stem === other || stem.startsWith(`${other} `) || other.startsWith(`${stem} `))) return 2;
		return kind && fontKind(family) === kind ? 1 : 0;
	};
	let best = candidates[0]!;
	let bestScore = score(best.family);
	for (const candidate of candidates.slice(1)) {
		const s = score(candidate.family);
		if (s > bestScore) [best, bestScore] = [candidate, s];
	}
	return best.family;
}

export interface FontCheckUpload extends SubtitleFileFontSource {
	key: string;
}

/** Every face of each family, so a family's bold and italic files travel together. */
function byFamily(fonts: SubtitleFileFontSource[]): Map<string, SubtitleFileFontSource[]> {
	const families = new Map<string, SubtitleFileFontSource[]>();
	for (const font of fonts) {
		const key = normalizeFontName(font.family);
		families.set(key, [...(families.get(key) ?? []), font]);
	}
	return families;
}

/**
 * One repair per video that a chosen fix applies to. An uploaded font, or a
 * library font that already has the missing name, is attached to the videos
 * missing its font. A mapping points the subtitles at a family the video
 * carries. A video that lacks it gets the uploaded or library font of that
 * family attached instead. Videos a fix cannot reach are left as they are.
 */
export function buildFontCheckPlans(
	result: FontCheckResult,
	request: Pick<FontCheckJobRequest, "maps" | "replaceTarget"> & Partial<Pick<FontCheckJobRequest, "library">>,
	uploads: FontCheckUpload[],
	workRoot: string,
	library: SubtitleFileFontSource[] = [],
): { plans: RepairPlan[]; unreachable: { fileName: string; font: string; to: string }[] } {
	const nameOf = new Map(result.missing.map((m) => [m.key, m.name]));
	const uploadByKey = new Map(uploads.map((u) => [u.key, u]));
	const uploadByFamily = byFamily(uploads);
	const libraryByFamily = byFamily(library);
	const plans: RepairPlan[] = [];
	const unreachable: { fileName: string; font: string; to: string }[] = [];
	for (const file of result.files) {
		if (file.error || !file.missing.length) continue;
		const attach = new Map<string, SubtitleFileFontSource>();
		const maps: { from: string; to: string }[] = [];
		for (const key of file.missing) {
			const upload = uploadByKey.get(key);
			if (upload) {
				attach.set(upload.path, upload);
				continue;
			}
			const fromLibrary = request.library?.find((l) => l.key === key);
			if (fromLibrary) {
				for (const font of libraryByFamily.get(normalizeFontName(fromLibrary.family)) ?? []) attach.set(font.path, font);
				continue;
			}
			const map = request.maps.find((m) => m.key === key);
			if (!map) continue;
			const target = normalizeFontName(map.to);
			const carried = file.families.find((family) => normalizeFontName(family) === target);
			const brought = uploadByFamily.get(target) ?? libraryByFamily.get(target);
			if (carried) maps.push({ from: nameOf.get(key) ?? key, to: carried });
			else if (brought) {
				maps.push({ from: nameOf.get(key) ?? key, to: brought[0]!.family });
				for (const font of brought) attach.set(font.path, font);
			} else unreachable.push({ fileName: file.fileName, font: nameOf.get(key) ?? key, to: map.to });
		}
		if (!maps.length && !attach.size) continue;

		const workDir = join(workRoot, randomUUID());
		mkdirSync(workDir, { recursive: true });
		const taken = new Set<string>();
		const attachments: SubtitleAddFont[] = [...attach.values()].map((font) => {
			let fileName = font.fileName;
			for (let n = 2; taken.has(fileName.toLowerCase()); n++) fileName = fileName.replace(/(\.[^.]+)$/, `_${n}$1`);
			taken.add(fileName.toLowerCase());
			const copy = join(workDir, fileName);
			copyFileSync(font.path, copy);
			return { file: copy, fileName, names: font.names };
		});
		plans.push(
			sanitizeRepairPlan({
				targetPath: file.path,
				replaceTarget: request.replaceTarget,
				tracks: file.tracks
					.filter((track) => track.type === "subtitles")
					.map((track, order) => ({
						source: "target",
						trackId: track.id,
						mode: "copy",
						order,
						title: track.title,
						language: track.language,
						compression: "preserve",
						isDefault: track.isDefault,
						isForced: track.isForced,
						isEnabled: track.isEnabled,
						isHearingImpaired: track.isHearingImpaired,
						isOriginal: track.isOriginal,
						isCommentary: track.isCommentary,
					})),
				fontFix: { maps, attachments, workDir },
			}),
		);
	}
	return { plans, unreachable };
}
