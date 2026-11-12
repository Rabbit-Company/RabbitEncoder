import { existsSync, readFileSync } from "fs";
import { basename, extname, join } from "path";
import { Logger } from "../core/logger";
import { run } from "../core/process";
import type { JobSettings } from "../core/types";
import { normalizeFontName } from "../subtitles/ass-classifier";
import { faceStyle, faceUsage, type FaceStyle } from "../subtitles/face-usage";
import { resolveStyleAppearance } from "../subtitles/subtitle-style";
import { axisSuffix, fontAttachmentFileName, instanceFont, readFontRecipes, type FaceRecipe } from "./font-instance";
import { FONT_EXTS, fontRegistry, listMkvAttachments, scanFontNames, type FontFace, type ResolvedFace } from "./fonts";
import { isRabbitGroupFace } from "./inject";

/** A family the subtitles name that Rabbit makes from its font group. */
export interface RabbitFamily {
	family: string;
	/** How to make it. Taken from `base` when omitted. */
	recipe?: FaceRecipe;
	/** The face the materializer already made for the style, reused when it fits. */
	base?: ResolvedFace;
}

/** Characters kept in every cut-down face, so a small edit or a stray symbol still has a glyph. */
const KEPT_CODEPOINTS: number[] = [];
for (const [lo, hi] of [
	[0x20, 0x7e],
	[0xa0, 0xff],
	[0x2010, 0x2027],
	[0x2030, 0x203a],
]) {
	for (let cp = lo!; cp <= hi!; cp++) KEPT_CODEPOINTS.push(cp);
}

/** A weight step between a regular face and its bold. */
const BOLD_STEP = 300;

export interface BuiltRabbitFaces {
	faces: ResolvedFace[];
	/** Families no face could be made for, as their group or face is gone. Their old faces should stay. */
	unbuilt: Set<string>;
}

/**
 * The faces each Rabbit family needs for `texts`, the final ASS of every track
 * the file will have: the face the style names, plus a real bold, italic or
 * bold italic face wherever the text asks for one and the group can make it.
 * With `subset`, every face keeps only the characters the family draws. A
 * family no text uses gets no face, so a removed track takes its faces along.
 */
export async function buildRabbitFaces(options: {
	families: readonly RabbitFamily[];
	texts: readonly string[];
	subset: boolean;
	tempDir: string;
	signal?: AbortSignal;
	instance?: typeof instanceFont;
}): Promise<BuiltRabbitFaces> {
	const { texts, subset, tempDir, signal } = options;
	const instance = options.instance ?? instanceFont;
	const usage = faceUsage(texts);
	const faces: ResolvedFace[] = [];
	const unbuilt = new Set<string>();

	const byFamily = new Map<string, RabbitFamily>();
	for (const f of options.families) {
		const key = normalizeFontName(f.family);
		const seen = byFamily.get(key);
		if (!seen || (!seen.base && f.base)) byFamily.set(key, { ...seen, ...f, recipe: f.recipe ?? seen?.recipe });
	}

	for (const [key, entry] of byFamily) {
		const used = usage.get(key);
		if (!used) continue;
		const { family, base } = entry;
		const recipe = entry.recipe ?? base?.recipe;
		const upright = recipe ? fontRegistry.findFaceFile(recipe.group, recipe.face) : undefined;
		if (!recipe || !upright) {
			if (base) faces.push(base);
			else unbuilt.add(key);
			continue;
		}

		const unicodes = subset ? [...new Set([...KEPT_CODEPOINTS, ...used.codepoints])].sort((a, b) => a - b) : undefined;
		const own = faceStyle(recipe.bold, false);
		for (const style of new Set<FaceStyle>([own, ...used.styles])) {
			const bold = style === "bold" || style === "bold italic";
			const italic = style === "italic" || style === "bold italic";
			const isOwn = style === own;
			// The materializer's face is the style's face already, unless it has to be cut down.
			if (isOwn && base && !subset) {
				faces.push(base);
				continue;
			}
			const source = italic ? fontRegistry.italicPartner(recipe.group, recipe.face) : upright;
			const coords = source && coordsFor(source, recipe, bold);
			if (!source || !coords) {
				if (isOwn && base) faces.push(base);
				continue; // libass fakes this style, as it would without Rabbit
			}
			const ext = extname(source.fileName).toLowerCase() === ".otf" ? ".otf" : ".ttf";
			const out = join(tempDir, `face_${Buffer.from(`${key}|${style}`).toString("base64url").slice(0, 48)}${ext}`);
			const made = await instance(source.path, coords, family, bold, out, signal, { italic, recipe, unicodes });
			if (!made) {
				Logger.warn(`[fonts] Could not make the ${style} face of "${family}"`);
				if (isOwn && base) faces.push(base);
				continue;
			}
			faces.push({
				family,
				names: made.names,
				path: made.path,
				fileName: fontAttachmentFileName(family, ext, isOwn ? undefined : style),
				mime: fontRegistry.mime(made.path),
				axes: [],
				group: recipe.group,
				recipe,
				bold,
				italic,
			});
		}
	}
	return { faces, unbuilt };
}

/** The styles of `used` the group can make a real face for, with the style's own face always first. */
function makeableStyles(recipe: FaceRecipe, used: Iterable<FaceStyle>): FaceStyle[] {
	const own = faceStyle(recipe.bold, false);
	const upright = fontRegistry.findFaceFile(recipe.group, recipe.face);
	if (!upright) return [];
	const out: FaceStyle[] = [own];
	for (const style of used) {
		if (out.includes(style)) continue;
		const italic = style === "italic" || style === "bold italic";
		const source = italic ? fontRegistry.italicPartner(recipe.group, recipe.face) : upright;
		if (source && coordsFor(source, recipe, style === "bold" || style === "bold italic")) out.push(style);
	}
	return out;
}

/**
 * Axis values for one style of a recipe. The style's own weight is the
 * recipe's. The other weight is a bold step away, which needs a weight axis
 * with room left, so a face already at its heaviest gets no bolder face.
 */
function coordsFor(source: FontFace, recipe: FaceRecipe, bold: boolean): Record<string, number> | null {
	const wght = source.axes.find((a) => a.tag === "wght");
	const chosen = { ...recipe.coords };
	if (bold !== recipe.bold) {
		if (!wght) return null;
		const from = recipe.coords.wght ?? wght.default;
		const to = Math.min(wght.max, Math.max(wght.min, from + (bold ? BOLD_STEP : -BOLD_STEP)));
		if (to === from) return null;
		chosen.wght = to;
	}
	return axisSuffix(source.axes, chosen).coords;
}

export interface FileRabbitFaces {
	families: RabbitFamily[];
	/** Attachment ids of each family's faces, by normalized family. */
	attachmentIds: Map<string, number[]>;
	/** The styles each family has a face for, by normalized family. */
	styles?: Map<string, Set<FaceStyle>>;
	/** Families with a face cut down to some characters. */
	cut?: Set<string>;
}

/** Rabbit only gives its faces file names like these. */
const RABBIT_FILE_NAME = /^[a-z0-9_]+\.(ttf|otf)$/;

/**
 * The faces an earlier pass of Rabbit attached to `mkvPath`, with the recipe
 * each was made from. A face from before recipes were stored is recognised by
 * its file name and given the group's current look.
 */
export async function rabbitFacesInFile(mkvPath: string, settings: JobSettings, tempDir: string, signal?: AbortSignal): Promise<FileRabbitFaces> {
	const families: RabbitFamily[] = [];
	const attachmentIds = new Map<string, number[]>();
	const styles = new Map<string, Set<FaceStyle>>();
	const cut = new Set<string>();
	const candidates = (await listMkvAttachments(mkvPath, signal)).filter(
		(a) => FONT_EXTS.has(extname(a.fileName).toLowerCase()) && RABBIT_FILE_NAME.test(a.fileName),
	);
	if (!candidates.length) return { families, attachmentIds, styles, cut };

	const paths = new Map(candidates.map((a) => [a.id, join(tempDir, `rabbitface_${a.id}${extname(a.fileName).toLowerCase()}`)]));
	const extracted = await run(["mkvextract", mkvPath, "attachments", ...candidates.map((a) => `${a.id}:${paths.get(a.id)}`)], { signal });
	if (extracted.code !== 0) {
		Logger.warn(`[fonts] Could not read the fonts of ${basename(mkvPath)}: ${(extracted.stderr || extracted.stdout).slice(-200)}`);
		return { families, attachmentIds, styles, cut };
	}
	const present = candidates.filter((a) => existsSync(paths.get(a.id)!));
	const recipes = await readFontRecipes(
		present.map((a) => paths.get(a.id)!),
		signal,
	);
	for (const a of present) {
		const path = paths.get(a.id)!;
		const { family } = await scanFontNames(path, signal);
		if (!family) continue;
		const stored = recipes.get(path);
		const recipe = stored ?? (isRabbitGroupFace(a.fileName, family, settings.fontGroup) ? legacyRecipe(settings.fontGroup, family) : null);
		if (!recipe) continue;
		const key = normalizeFontName(family);
		if (!attachmentIds.has(key)) {
			attachmentIds.set(key, []);
			styles.set(key, new Set());
			families.push({ family, recipe: { ...recipe, subset: undefined } });
		}
		attachmentIds.get(key)!.push(a.id);
		styles.get(key)!.add(styleOfFile(a.fileName, family, recipe));
		if (stored?.subset) cut.add(key);
	}
	return { families, attachmentIds, styles, cut };
}

/** The style a face Rabbit attached is for, read from its file name. */
function styleOfFile(fileName: string, family: string, recipe: FaceRecipe): FaceStyle {
	const ext = extname(fileName).toLowerCase();
	for (const style of ["bold italic", "italic", "bold", "regular"] as FaceStyle[]) {
		if (fileName.toLowerCase() === fontAttachmentFileName(family, ext, style)) return style;
	}
	return faceStyle(recipe.bold, false);
}

/** A recipe for a face attached before recipes were stored: the group face of its family, in the group's look. */
function legacyRecipe(group: string, family: string): FaceRecipe | null {
	const fam = fontRegistry.findFamily(group);
	const base = normalizeFontName(family.replace(/ \d+$/, ""));
	const face = fam?.faces.find((f) => !f.italic && normalizeFontName(f.family) === base);
	if (!fam || !face) return null;
	const appearance = resolveStyleAppearance(fam.style ?? null, face.keys[0], "latin");
	return { group, face: face.fileName, coords: axisSuffix(face.axes, appearance.fontAxes ?? {}).coords, bold: appearance.bold };
}

/** The ASS text of tracks of `mkvPath`, or null when one cannot be read. */
export async function readAssTracks(mkvPath: string, trackIds: readonly number[], tempDir: string, signal?: AbortSignal): Promise<string[] | null> {
	if (!trackIds.length) return [];
	const outs = trackIds.map((id) => join(tempDir, `rabbitface_track_${id}.ass`));
	const res = await run(["mkvextract", mkvPath, "tracks", ...trackIds.map((id, i) => `${id}:${outs[i]}`)], { signal });
	if (res.code !== 0 || outs.some((p) => !existsSync(p))) {
		Logger.warn(`[fonts] Could not read the subtitles of ${basename(mkvPath)}: ${(res.stderr || res.stdout).slice(-200)}`);
		return null;
	}
	return outs.map((p) => readFileSync(p, "utf-8"));
}

/** mkvmerge arguments attaching faces under their file names. */
export function rabbitFaceArgs(faces: readonly ResolvedFace[]): string[] {
	const args: string[] = [];
	const seen = new Set<string>();
	for (const face of faces) {
		if (seen.has(face.fileName.toLowerCase())) continue;
		seen.add(face.fileName.toLowerCase());
		args.push("--attachment-mime-type", face.mime || "font/ttf", "--attachment-name", face.fileName, "--attach-file", face.path);
	}
	return args;
}

/**
 * Rebuild the Rabbit faces of a file whose subtitles are being rewritten
 * without an encode: an earlier pass's faces are dropped and made again, with
 * the faces of `added` families, for the text the file will have. A face that
 * cannot be made again stays as it is.
 */
export async function refreshRabbitFaces(options: {
	mkvPath: string;
	/** Final ASS text of every track the output keeps or adds. */
	texts: readonly string[];
	/** Families the tracks added by this pass use. */
	added?: readonly RabbitFamily[];
	/** The file's faces, when the caller already read them. */
	existing?: FileRabbitFaces;
	settings: JobSettings;
	tempDir: string;
	signal?: AbortSignal;
}): Promise<{ attachArgs: string[]; dropAttachmentIds: number[]; faces: ResolvedFace[] }> {
	const existing = options.existing ?? (await rabbitFacesInFile(options.mkvPath, options.settings, options.tempDir, options.signal));
	if (!options.added?.length && alreadyCovered(existing, options.texts, !!options.settings.subsetFonts)) {
		return { attachArgs: [], dropAttachmentIds: [], faces: [] };
	}
	const built = await buildRabbitFaces({
		families: [...existing.families, ...(options.added ?? [])],
		texts: options.texts,
		subset: !!options.settings.subsetFonts,
		tempDir: options.tempDir,
		signal: options.signal,
	});
	const dropAttachmentIds: number[] = [];
	for (const [key, ids] of existing.attachmentIds) if (!built.unbuilt.has(key)) dropAttachmentIds.push(...ids);
	if (dropAttachmentIds.length || built.faces.length) {
		Logger.info(`[fonts] Rebuilt the font group faces: ${built.faces.map((f) => f.fileName).join(", ") || "none needed"}`);
	}
	return { attachArgs: rabbitFaceArgs(built.faces), dropAttachmentIds, faces: built.faces };
}

/**
 * Whether the file's faces already serve `texts`: full faces, not cut down,
 * with every style the text needs that the group can make. Faces left over
 * from a removed track do no harm, so rebuilding them only to drop them is
 * skipped. Cut-down faces are always rebuilt, as the characters may change.
 */
function alreadyCovered(existing: FileRabbitFaces, texts: readonly string[], subset: boolean): boolean {
	if (subset || !existing.families.length) return !existing.families.length;
	const usage = faceUsage(texts);
	for (const { family, recipe } of existing.families) {
		const key = normalizeFontName(family);
		if (existing.cut?.has(key)) return false;
		const used = usage.get(key);
		if (!used || !recipe) continue;
		const have = existing.styles?.get(key) ?? new Set<FaceStyle>();
		if (makeableStyles(recipe, used.styles).some((style) => !have.has(style))) return false;
	}
	return true;
}

/** mkvmerge arguments, placed before an input, that leave out the given attachments of it. */
export function dropAttachmentArgs(ids: readonly number[]): string[] {
	return ids.length ? ["--attachments", `!${[...new Set(ids)].join(",")}`] : [];
}

/** Ids of the ASS and SSA subtitle tracks of `mkvPath`, or null when it cannot be read. */
export async function assTrackIds(mkvPath: string, signal?: AbortSignal): Promise<number[] | null> {
	const res = await run(["mkvmerge", "-J", mkvPath], { signal });
	if (res.code !== 0) return null;
	try {
		const tracks = (JSON.parse(res.stdout).tracks ?? []) as { id: number; type: string; properties?: { codec_id?: string } }[];
		return tracks.filter((t) => t.type === "subtitles" && /^S_TEXT\/(ASS|SSA)$/i.test(t.properties?.codec_id ?? "")).map((t) => t.id);
	} catch {
		return null;
	}
}
