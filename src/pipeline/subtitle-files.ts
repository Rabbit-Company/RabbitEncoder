import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "fs";
import { basename, dirname, extname, join } from "path";
import { mapPool } from "../core/concurrency";
import type {
	JobSettings,
	SubtitleAddFont,
	SubtitleAddPlan,
	SubtitleFileFont,
	SubtitleFileFontSource,
	SubtitleFilesPair,
	SubtitleFilesScan,
} from "../core/types";
import { FONT_EXTS, scanFontNames, scanMkvAttachmentFontNames } from "../fonts/fonts";
import { extractUsedFonts, normalizeFontName } from "../subtitles/ass-classifier";
import { restyleAssDialogueFont } from "../subtitles/ass-style";
import { DEFAULT_STYLE_APPEARANCE } from "../subtitles/subtitle-style";
import { downloadedLanguageTag, downloadedTrackName } from "../subsearch/naming";
import { resolveTranslateLang } from "../translate/translate-languages";
import { identifyMatroska } from "./repair";
import { pairRepairFiles } from "./repair-pairing";

export const SUBTITLE_FILE_EXTS = new Set([".ass", ".ssa", ".srt"]);
const MAX_FILES = 500;
const MAX_FONTS = 300;

const isAss = (path: string) => [".ass", ".ssa"].includes(extname(path).toLowerCase());

function filesIn(dir: string, exts: Set<string>): string[] {
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && !entry.name.startsWith(".") && exts.has(extname(entry.name).toLowerCase()))
		.map((entry) => join(dir, entry.name))
		.sort((a, b) => basename(a).localeCompare(basename(b), undefined, { numeric: true, sensitivity: "base" }));
}

/** Subtitle files directly inside `dir`. */
export function subtitleFilesIn(dir: string): string[] {
	const files = filesIn(dir, SUBTITLE_FILE_EXTS);
	if (files.length > MAX_FILES) throw new Error(`A folder may contain at most ${MAX_FILES} subtitle files`);
	return files;
}

/**
 * Fonts a subtitle folder comes with: inside it, and in a Fonts folder next to
 * it or next to its parent, as releases keep Subs/Group and Fonts side by side.
 */
export function fontFilesNear(dir: string): string[] {
	const found = new Set<string>();
	const walk = (folder: string, depth: number) => {
		let entries;
		try {
			entries = readdirSync(folder, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".") || found.size >= MAX_FONTS) continue;
			const path = join(folder, entry.name);
			if (entry.isDirectory() && depth > 0) walk(path, depth - 1);
			else if (entry.isFile() && FONT_EXTS.has(extname(entry.name).toLowerCase())) found.add(path);
		}
	};
	walk(dir, 3);
	for (const parent of [dirname(dir), dirname(dirname(dir))]) {
		if (parent === dir) continue;
		try {
			for (const entry of readdirSync(parent, { withFileTypes: true })) {
				if (entry.isDirectory() && /^fonts?$/i.test(entry.name)) walk(join(parent, entry.name), 2);
			}
		} catch {}
	}
	return [...found].sort();
}

const bracketTokens = (text: string) => [...text.matchAll(/\[([^\]]*)\]/g)].flatMap((m) => m[1]!.split(/[\s,+&/]+/)).filter(Boolean);

function languageOf(token: string): string | null {
	const t = token.trim();
	if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,4})?$/.test(t) && !/^[A-Za-z]{4,}$/.test(t)) return null;
	return resolveTranslateLang(t)?.code ?? null;
}

/** The language a subtitle folder holds, from suffixes such as .ru.ass, then tags such as [Rus] in its name. */
export function guessSubtitleLanguage(files: string[], folder: string): string | null {
	const votes = new Map<string, number>();
	for (const file of files) {
		const parts = basename(file, extname(file)).split(".");
		const language = parts.length > 1 ? languageOf(parts.at(-1)!) : null;
		if (language) votes.set(language, (votes.get(language) ?? 0) + 1);
	}
	const best = [...votes].sort((a, b) => b[1] - a[1])[0];
	if (best && best[1] * 2 >= files.length) return best[0];
	const tagged = bracketTokens(basename(folder))
		.map(languageOf)
		.filter((l): l is string => !!l);
	return tagged.length === 1 ? tagged[0]! : null;
}

/** The folder name as a credit, "Kogarasi & Exmel [Rus]" giving "Kogarasi & Exmel". Generic names give none. */
export function subtitleFolderCredit(folder: string): string {
	const name = basename(folder)
		.replace(/\[([^\]]*)\]/g, (match, inner: string) => (inner.split(/[\s,+&/]+/).every((t) => !t || languageOf(t)) ? " " : match))
		.replace(/\s+/g, " ")
		.trim();
	if (!name || /^(subs?|subtitles?|fonts?)$/i.test(name) || languageOf(name)) return "";
	return name.replace(/[[\]]/g, "").slice(0, 60);
}

/** Font names as an ASS document writes them, by normalized name. */
export function assFontSpellings(text: string): Map<string, string> {
	const out = new Map<string, string>();
	const add = (raw: string) => {
		const name = raw.trim().replace(/^@/, "");
		if (name && !out.has(normalizeFontName(name))) out.set(normalizeFontName(name), name);
	};
	let section = "";
	let fontField = 1;
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (/^\[.*\]$/.test(trimmed)) section = trimmed.toLowerCase();
		else if (section.includes("styles")) {
			const format = trimmed.match(/^Format\s*:(.*)$/i);
			if (format)
				fontField = Math.max(
					0,
					format[1]!.split(",").findIndex((f) => f.trim().toLowerCase() === "fontname"),
				);
			const style = trimmed.match(/^Style\s*:(.*)$/i);
			if (style) add(style[1]!.split(",")[fontField] ?? "");
		} else if (section === "[events]") for (const m of line.matchAll(/\\fn([^\\}]*)/g)) add(m[1]!);
	}
	return out;
}

/** The ASS text as the add job will mux it: with the dialogue font swapped for the font group when the settings say so. */
function asMuxed(text: string, settings: JobSettings): string {
	if (!settings.restyleAssFont || !(settings.assRestyleTargets ?? []).includes("full")) return text;
	return restyleAssDialogueFont(text, { ...DEFAULT_STYLE_APPEARANCE, fontName: settings.fontGroup }, true);
}

/** The fonts a subtitle file needs once muxed, and the ones the font group replaces. */
export function subtitleFontNeeds(text: string, settings: JobSettings): { needed: Set<string>; replaced: Set<string> } {
	const before = extractUsedFonts(text);
	const after = extractUsedFonts(asMuxed(text, settings));
	after.delete(normalizeFontName(settings.fontGroup));
	return { needed: after, replaced: new Set([...before].filter((name) => !after.has(name))) };
}

export async function readFontSource(path: string, signal?: AbortSignal): Promise<SubtitleFileFontSource | null> {
	const { family, names } = await scanFontNames(path, signal);
	if (!names.length) return null;
	return { path, fileName: basename(path), family, names };
}

export interface ScannedPair extends SubtitleFilesPair {
	/** Font names attached to the video. */
	attached: Set<string>;
}

/**
 * Pairs every video of `targetDir` with a subtitle file of `subtitleDir` by
 * episode, and finds out which fonts the subtitles use that neither the
 * videos nor the folder's own fonts have.
 */
export async function scanSubtitleFiles(input: {
	targetDir: string;
	subtitleDir: string;
	targets: string[];
	settings: JobSettings;
	tempDir: string;
	signal?: AbortSignal;
}): Promise<SubtitleFilesScan> {
	const { targetDir, subtitleDir, targets, settings, tempDir, signal } = input;
	const subtitles = subtitleFilesIn(subtitleDir);
	if (!subtitles.length) throw new Error("The subtitles folder has no ASS, SSA or SRT files");
	const { pairs, unmatchedSources } = pairRepairFiles(targets, subtitles);

	const folderFonts = (await mapPool(fontFilesNear(subtitleDir), 4, (path) => readFontSource(path, signal))).filter((f): f is SubtitleFileFontSource => !!f);
	const scanned: ScannedPair[] = await mapPool(pairs, 4, async (pair, index) => {
		const identified = await identifyMatroska(pair.targetPath, signal);
		const existingLanguages = (identified.tracks ?? [])
			.filter((t) => t.type === "subtitles")
			.map((t) => t.properties.language_ietf || t.properties.language || "und");
		const dir = join(tempDir, `fonts_${index}`);
		mkdirSync(dir, { recursive: true });
		const attached =
			pair.sourcePath && isAss(pair.sourcePath)
				? ((await scanMkvAttachmentFontNames(pair.targetPath, dir, new Set(), false, signal)) ?? new Set<string>())
				: new Set<string>();
		return { ...pair, existingLanguages: [...new Set(existingLanguages)], attached };
	});

	const fonts = fontReport(scanned, folderFonts, [], settings);
	return {
		targetDir,
		subtitleDir,
		pairs: scanned.map(({ attached, ...pair }) => pair),
		unmatchedSubtitles: unmatchedSources,
		language: guessSubtitleLanguage(subtitles, subtitleDir),
		credit: subtitleFolderCredit(subtitleDir),
		folderFonts,
		fonts,
		dialogueFontGroup: settings.restyleAssFont && (settings.assRestyleTargets ?? []).includes("full") ? settings.fontGroup : null,
	};
}

/** Fonts Windows comes with, which fansub releases often leave out. */
const WINDOWS_FONTS = new Set(
	[
		"Arial",
		"Arial Black",
		"Arial Narrow",
		"Book Antiqua",
		"Bookman Old Style",
		"Calibri",
		"Cambria",
		"Candara",
		"Century Gothic",
		"Comic Sans MS",
		"Consolas",
		"Constantia",
		"Corbel",
		"Courier New",
		"Franklin Gothic Medium",
		"Gabriola",
		"Garamond",
		"Georgia",
		"Impact",
		"Lucida Console",
		"Lucida Sans Unicode",
		"Microsoft Sans Serif",
		"Monotype Corsiva",
		"Palatino Linotype",
		"Segoe Print",
		"Segoe Script",
		"Segoe UI",
		"Sylfaen",
		"Tahoma",
		"Times New Roman",
		"Trebuchet MS",
		"Verdana",
	].map(normalizeFontName),
);

export function isWindowsFont(name: string): boolean {
	return WINDOWS_FONTS.has(normalizeFontName(name));
}

/** Every font the paired subtitles use, and where each comes from. */
export function fontReport(
	pairs: Pick<ScannedPair, "targetName" | "sourcePath" | "attached">[],
	folderFonts: Pick<SubtitleFileFontSource, "names">[],
	uploads: Pick<SubtitleFileFontSource, "names">[],
	settings: JobSettings,
	read: (path: string) => string = (path) => readFileSync(path, "utf-8"),
): SubtitleFileFont[] {
	const folderNames = new Set(folderFonts.flatMap((f) => f.names));
	const uploadNames = new Set(uploads.flatMap((f) => f.names));
	const report = new Map<string, SubtitleFileFont & { attachedIn: number; needers: number }>();
	const entry = (key: string, name: string) => {
		let found = report.get(key);
		if (!found) {
			found = { name, status: "missing", usedBy: 0, missingIn: [], attachedIn: 0, needers: 0 };
			report.set(key, found);
		}
		return found;
	};
	for (const pair of pairs) {
		if (!pair.sourcePath || !isAss(pair.sourcePath)) continue;
		const text = read(pair.sourcePath);
		const spellings = assFontSpellings(text);
		const { needed, replaced } = subtitleFontNeeds(text, settings);
		for (const key of replaced) {
			const font = entry(key, spellings.get(key) ?? key);
			font.usedBy++;
		}
		for (const key of needed) {
			const font = entry(key, spellings.get(key) ?? key);
			font.usedBy++;
			font.needers++;
			if (pair.attached.has(key)) font.attachedIn++;
			else font.missingIn.push(pair.targetName);
		}
	}
	return [...report.entries()]
		.map(([key, font]): SubtitleFileFont => {
			const status = uploadNames.has(key)
				? "uploaded"
				: folderNames.has(key)
					? "folder"
					: font.needers === 0
						? "replaced"
						: font.missingIn.length === 0
							? "attached"
							: "missing";
			return {
				name: font.name,
				status,
				usedBy: font.usedBy,
				missingIn: status === "missing" ? font.missingIn : [],
				...(WINDOWS_FONTS.has(key) ? { windows: true } : {}),
			};
		})
		.sort((a, b) => Number(b.status === "missing") - Number(a.status === "missing") || b.usedBy - a.usedBy || a.name.localeCompare(b.name));
}

/** The fonts of `fonts` that a subtitle file uses once muxed. */
export function fontsForSubtitle(text: string, fonts: SubtitleFileFontSource[], settings: JobSettings): SubtitleFileFontSource[] {
	const { needed } = subtitleFontNeeds(text, settings);
	return fonts.filter((font) => font.names.some((name) => needed.has(name)));
}

/** A subtitle-add plan for one video: the subtitle file and its fonts copied into `workDir`. */
export function buildSubtitleFilePlan(options: {
	targetPath: string;
	subtitlePath: string;
	language: string;
	credit: string;
	fonts: SubtitleFileFontSource[];
	settings: JobSettings;
	workDir: string;
}): SubtitleAddPlan {
	const { targetPath, subtitlePath, language, credit, settings, workDir } = options;
	mkdirSync(join(workDir, "fonts"), { recursive: true });
	const ext = extname(subtitlePath).toLowerCase() === ".srt" ? ".srt" : ".ass";
	const file = join(workDir, `subtitle${ext}`);
	copyFileSync(subtitlePath, file);
	const fonts: SubtitleAddFont[] = [];
	if (ext === ".ass") {
		const taken = new Set<string>();
		for (const font of fontsForSubtitle(readFileSync(subtitlePath, "utf-8"), options.fonts, settings)) {
			let fileName = font.fileName;
			for (let n = 2; taken.has(fileName.toLowerCase()); n++) fileName = `${basename(font.fileName, extname(font.fileName))}_${n}${extname(font.fileName)}`;
			taken.add(fileName.toLowerCase());
			const copy = join(workDir, "fonts", fileName);
			copyFileSync(font.path, copy);
			fonts.push({ file: copy, fileName, names: font.names });
		}
	}
	return {
		targetPath,
		workDir,
		tracks: [
			{
				file,
				language: downloadedLanguageTag(language),
				trackName: downloadedTrackName("full", "", "", basename(subtitlePath), credit),
				hearingImpaired: false,
				trackType: "full",
			},
		],
		...(fonts.length ? { fonts } : {}),
	};
}

/** The fonts of a plan the video lacks, as mkvmerge arguments. */
export function planFontArgs(fonts: SubtitleAddFont[], occupiedNames: Set<string>, attachedFiles: Set<string>, mime: (path: string) => string): string[] {
	const args: string[] = [];
	for (const font of fonts) {
		if (!existsSync(font.file) || font.names.some((name) => occupiedNames.has(name))) continue;
		let fileName = font.fileName;
		for (let n = 2; attachedFiles.has(fileName.toLowerCase()); n++)
			fileName = `${basename(font.fileName, extname(font.fileName))}_${n}${extname(font.fileName)}`;
		attachedFiles.add(fileName.toLowerCase());
		for (const name of font.names) occupiedNames.add(name);
		args.push("--attachment-mime-type", mime(font.file), "--attachment-name", fileName, "--attach-file", font.file);
	}
	return args;
}
