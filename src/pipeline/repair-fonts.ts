import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { basename, extname, join } from "path";
import { Logger } from "../core/logger";
import { run } from "../core/process";
import { FONT_EXTS, fontRegistry, listMkvAttachments, scanFontNames, type KeptAttachment } from "../fonts/fonts";
import { normalizeFontName } from "../subtitles/ass-classifier";

/** A font attached to one input of a repair: the target (-1) or a source by index. */
export interface InputFont {
	input: number;
	id: number;
	fileName: string;
	/** Extracted copy. */
	path: string;
	hash: string;
	family: string;
	/** Normalized family, full and PostScript names. */
	names: string[];
}

/** The fonts of one MKV, extracted to `dir` and fingerprinted. */
export async function readInputFonts(mkvPath: string, input: number, dir: string, signal?: AbortSignal): Promise<InputFont[]> {
	const attachments = (await listMkvAttachments(mkvPath, signal)).filter((a) => FONT_EXTS.has(extname(a.fileName).toLowerCase()));
	if (!attachments.length) return [];
	mkdirSync(dir, { recursive: true });
	const outOf = (id: number, fileName: string) => join(dir, `input${input}_${id}${extname(fileName).toLowerCase()}`);
	const extracted = await run(["mkvextract", mkvPath, "attachments", ...attachments.map((a) => `${a.id}:${outOf(a.id, a.fileName)}`)], { signal });
	if (extracted.code !== 0) throw new Error(`Could not read the fonts of ${basename(mkvPath)}: ${(extracted.stderr || extracted.stdout).slice(-300)}`);
	const fonts: InputFont[] = [];
	for (const a of attachments) {
		const path = outOf(a.id, a.fileName);
		if (!existsSync(path)) continue;
		const { family, names } = await scanFontNames(path, signal);
		fonts.push({
			input,
			id: a.id,
			fileName: a.fileName,
			path,
			hash: createHash("sha256").update(readFileSync(path)).digest("hex"),
			family: family || basename(a.fileName, extname(a.fileName)),
			names: names.length ? names : [normalizeFontName(basename(a.fileName, extname(a.fileName)))],
		});
	}
	return fonts;
}

export interface FontRename {
	font: InputFont;
	family: string;
	fileName: string;
}

export interface SourceFontPlan {
	/** Source fonts attached as they are. */
	keep: InputFont[];
	/** Source fonts the target or an earlier source already has, byte for byte. */
	duplicates: InputFont[];
	/** Source fonts whose names an earlier input already uses for another font, with the family each gets instead. */
	renames: FontRename[];
}

const psName = (family: string) => family.replace(/\s+/g, "");

/** The names a font answers to once its family is renamed. */
export function renamedNames(font: Pick<InputFont, "family" | "names">, family: string): string[] {
	const from = normalizeFontName(font.family);
	const to = normalizeFontName(family);
	const out = new Set([to, normalizeFontName(psName(family))]);
	for (const name of font.names) {
		if (name.startsWith(from)) out.add(to + name.slice(from.length));
		else if (name.startsWith(psName(from))) out.add(psName(to) + name.slice(psName(from).length));
	}
	return [...out];
}

/**
 * Which source fonts to attach. A font the target or an earlier source has
 * with the same bytes is left out. One whose names or file name an earlier
 * input already uses for different bytes would leave the player to pick
 * either, so it gets a free family, "Gandhi Sans 2", the same for every face
 * of that family in one source so they stay one family.
 */
export function planSourceFonts(target: InputFont[], sources: InputFont[]): SourceFontPlan {
	const hashes = new Set(target.map((f) => f.hash));
	const occupied = new Set(target.flatMap((f) => f.names));
	const fileNames = new Set(target.map((f) => f.fileName.toLowerCase()));
	const plan: SourceFontPlan = { keep: [], duplicates: [], renames: [] };

	// Faces of one family from one source, in source order.
	const families = new Map<string, InputFont[]>();
	for (const font of [...sources].sort((a, b) => a.input - b.input || a.id - b.id)) {
		if (hashes.has(font.hash)) {
			plan.duplicates.push(font);
			continue;
		}
		hashes.add(font.hash);
		const key = `${font.input}\n${normalizeFontName(font.family)}`;
		families.set(key, [...(families.get(key) ?? []), font]);
	}

	for (const faces of families.values()) {
		const collides = faces.some((f) => f.names.some((n) => occupied.has(n)) || fileNames.has(f.fileName.toLowerCase()));
		if (!collides) {
			for (const font of faces) {
				plan.keep.push(font);
				for (const n of font.names) occupied.add(n);
				fileNames.add(font.fileName.toLowerCase());
			}
			continue;
		}
		const base = faces[0]!.family;
		let family = "";
		for (let index = 2; !family; index++) {
			const candidate = `${base} ${index}`;
			if (!occupied.has(normalizeFontName(candidate)) && !occupied.has(normalizeFontName(psName(candidate)))) family = candidate;
		}
		const suffix = family.slice(base.length).trim();
		for (const font of faces) {
			const ext = extname(font.fileName).toLowerCase();
			const stem = basename(font.fileName, extname(font.fileName));
			let fileName = `${stem}_${suffix}${ext}`;
			for (let n = 2; fileNames.has(fileName.toLowerCase()); n++) fileName = `${stem}_${suffix}_${n}${ext}`;
			fileNames.add(fileName.toLowerCase());
			for (const n of renamedNames(font, family)) occupied.add(n);
			plan.renames.push({ font, family, fileName });
		}
	}
	return plan;
}

const RENAME_PY = `
import sys, json
from fontTools.ttLib import TTFont
src, out, old, new = sys.argv[1:5]
f = TTFont(src)
nm = f["name"]
old_ps, new_ps = old.replace(" ", ""), new.replace(" ", "")
# PostScript names: the font's, the variation prefix, and each named instance's.
ps_ids = {6, 25}
if "fvar" in f:
    for inst in f["fvar"].instances:
        if getattr(inst, "postscriptNameID", 0xFFFF) != 0xFFFF:
            ps_ids.add(inst.postscriptNameID)
for r in nm.names:
    if r.nameID not in (1, 3, 4, 16, 18, 21) and r.nameID not in ps_ids:
        continue
    try:
        s = r.toUnicode()
    except Exception:
        continue
    if r.nameID in ps_ids:
        if old_ps in s:
            t = s.replace(old_ps, new_ps, 1)
        elif r.nameID == 6:
            t = new_ps + "-" + s
        else:
            continue
    elif r.nameID == 3:
        t = s + ";" + new
    elif old in s:
        t = s.replace(old, new, 1)
    elif r.nameID in (1, 16, 21):
        t = new
    else:
        continue
    r.string = t
f.save(out)
`;

/**
 * A copy of `src` whose family is `family` in place of `oldFamily`, with its
 * style left as it is, so a Bold Italic face stays Bold Italic. False when it
 * cannot be renamed, such as a font collection.
 */
export async function renameFontFamily(src: string, out: string, oldFamily: string, family: string, signal?: AbortSignal): Promise<boolean> {
	const ext = extname(src).toLowerCase();
	if (ext === ".ttc" || ext === ".otc") return false;
	const res = await run(["python3", "-c", RENAME_PY, src, out, oldFamily, family], { signal });
	if (res.code !== 0) {
		Logger.warn(`[fonts] Could not rename ${basename(src)} to "${family}": ${(res.stderr || res.stdout).slice(-300)}`);
		return false;
	}
	return existsSync(out);
}

export interface AssFontRename {
	/** Normalized names of the original font. */
	names: Set<string>;
	from: string;
	to: string;
}

function renamedFontRef(value: string, renames: AssFontRename[]): string {
	const vertical = value.trimStart().startsWith("@");
	const core = value.trim().replace(/^@/, "");
	const rename = renames.find((r) => r.names.has(normalizeFontName(core)));
	if (!rename) return value;
	const to = core.toLowerCase().startsWith(rename.from.toLowerCase()) ? rename.to + core.slice(rename.from.length) : rename.to;
	return `${vertical ? "@" : ""}${to}`;
}

/** Points the styles and \\fn overrides of an ASS document that use renamed fonts at their new names. */
export function renameAssFonts(text: string, renames: AssFontRename[]): string {
	if (!renames.length) return text;
	let section = "";
	let fontField = 1;
	const lines = text.split(/(\r?\n)/);
	for (let i = 0; i < lines.length; i += 2) {
		const line = lines[i]!;
		const trimmed = line.trim();
		if (/^\[.*\]$/.test(trimmed)) {
			section = trimmed.toLowerCase();
			continue;
		}
		if (section.includes("styles")) {
			const format = trimmed.match(/^Format\s*:(.*)$/i);
			if (format) {
				const at = format[1]!.split(",").findIndex((f) => f.trim().toLowerCase() === "fontname");
				if (at >= 0) fontField = at;
				continue;
			}
			const style = line.match(/^(\s*Style\s*:\s*)(.*)$/i);
			if (style) {
				const fields = style[2]!.split(",");
				if (fields[fontField] !== undefined) fields[fontField] = renamedFontRef(fields[fontField]!, renames);
				lines[i] = style[1] + fields.join(",");
			}
		} else if (section === "[events]" && /^\s*(Dialogue|Comment)\s*:/i.test(line)) {
			lines[i] = line.replace(/\\fn([^\\}]*)/g, (match, name: string) => (name.trim() ? `\\fn${renamedFontRef(name, renames)}` : match));
		}
	}
	return lines.join("");
}

/** A planned source font as an attachment to add. */
export function fontAttachment(path: string, fileName: string, names: string[]): KeptAttachment {
	return { fileName, path, mime: fontRegistry.mime(path), isFont: true, names };
}
