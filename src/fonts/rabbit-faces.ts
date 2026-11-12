import { existsSync, readFileSync } from "fs";
import { basename, extname, join } from "path";
import { Logger } from "../core/logger";
import { run } from "../core/process";
import type { JobSettings } from "../core/types";
import { normalizeFontName } from "../subtitles/ass-classifier";
import { faceStyle, faceUsage, type FaceStyle } from "../subtitles/face-usage";
import { resolveStyleAppearance } from "../subtitles/subtitle-style";
import { axisSuffix, fontAttachmentFileName, instanceFont, readFontMarks, type FaceRecipe } from "./font-instance";
import { cutFonts, fontSha, originalPath, readOriginalMarker, storeOriginal, type CutRequest } from "./font-cut";
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

/** A font attached to a file, extracted for reading. */
export interface FileFont {
	id: number;
	fileName: string;
	path: string;
	family: string;
	names: string[];
	recipe: FaceRecipe | null;
	/** Hash of the full original, for a font Rabbit cut down. */
	original: string | null;
}

/** The fonts of a file as the font pass sees them. */
export interface FileFontState {
	fonts: FileFont[];
	rabbit: FileRabbitFaces;
	/** Fonts of the release Rabbit cut down earlier. */
	cutCount: number;
	/** The fonts could be read. When false, the pass leaves them as they are. */
	readable: boolean;
}

/** Rabbit only gives its faces file names like these. */
const RABBIT_FILE_NAME = /^[a-z0-9_]+\.(ttf|otf)$/;

/** A file attached as mkvmerge needs it. */
export interface FontAttachment {
	fileName: string;
	path: string;
	mime: string;
}

/**
 * Read every font attached to `mkvPath`: its names, the recipe of a face
 * Rabbit made and the original of a font Rabbit cut down. Rabbit's faces are
 * gathered by family with their recipes. A face from before recipes were
 * stored is recognised by its file name and given the group's current look.
 */
export async function fileFontState(mkvPath: string, settings: JobSettings, tempDir: string, signal?: AbortSignal): Promise<FileFontState> {
	const rabbit: FileRabbitFaces = { families: [], attachmentIds: new Map(), styles: new Map(), cut: new Set() };
	const empty = (readable: boolean): FileFontState => ({ fonts: [], rabbit, cutCount: 0, readable });
	const attached = (await listMkvAttachments(mkvPath, signal)).filter((a) => FONT_EXTS.has(extname(a.fileName).toLowerCase()));
	if (!attached.length) return empty(true);

	const paths = new Map(attached.map((a) => [a.id, join(tempDir, `filefont_${a.id}${extname(a.fileName).toLowerCase()}`)]));
	const extracted = await run(["mkvextract", mkvPath, "attachments", ...attached.map((a) => `${a.id}:${paths.get(a.id)}`)], { signal });
	if (extracted.code !== 0) {
		Logger.warn(`[fonts] Could not read the fonts of ${basename(mkvPath)}: ${(extracted.stderr || extracted.stdout).slice(-200)}`);
		return empty(false);
	}
	const present = attached.filter((a) => existsSync(paths.get(a.id)!));
	const marks = await readFontMarks(
		present.map((a) => paths.get(a.id)!),
		signal,
	);
	const fonts: FileFont[] = [];
	for (const a of present) {
		const path = paths.get(a.id)!;
		const { family, names } = await scanFontNames(path, signal);
		const mark = marks.get(path);
		fonts.push({ id: a.id, fileName: a.fileName, path, family, names, recipe: mark?.recipe ?? null, original: readOriginalMarker(mark?.original) });
	}

	for (const font of fonts) {
		if (!font.family || !RABBIT_FILE_NAME.test(font.fileName)) continue;
		const recipe = font.recipe ?? (isRabbitGroupFace(font.fileName, font.family, settings.fontGroup) ? legacyRecipe(settings.fontGroup, font.family) : null);
		if (!recipe) continue;
		const key = normalizeFontName(font.family);
		if (!rabbit.attachmentIds.has(key)) {
			rabbit.attachmentIds.set(key, []);
			rabbit.styles!.set(key, new Set());
			rabbit.families.push({ family: font.family, recipe: { ...recipe, subset: undefined } });
		}
		rabbit.attachmentIds.get(key)!.push(font.id);
		rabbit.styles!.get(key)!.add(styleOfFile(font.fileName, font.family, recipe));
		if (font.recipe?.subset) rabbit.cut!.add(key);
	}
	const rabbitIds = new Set([...rabbit.attachmentIds.values()].flat());
	const cutCount = fonts.filter((f) => !rabbitIds.has(f.id) && f.original).length;
	return { fonts, rabbit, cutCount, readable: true };
}

/** Whether a remux has font work to do: Rabbit faces to keep right, cut fonts to keep whole enough, or fonts to cut. */
export function needsFontPass(state: FileFontState, added: readonly RabbitFamily[] = [], cutOthers = false): boolean {
	return state.readable && (state.rabbit.families.length > 0 || state.cutCount > 0 || added.length > 0 || (cutOthers && state.fonts.length > 0));
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

/** mkvmerge arguments attaching fonts under their file names. */
export function rabbitFaceArgs(faces: readonly FontAttachment[]): string[] {
	const args: string[] = [];
	const seen = new Set<string>();
	for (const face of faces) {
		if (seen.has(face.fileName.toLowerCase())) continue;
		seen.add(face.fileName.toLowerCase());
		args.push("--attachment-mime-type", face.mime || "font/ttf", "--attachment-name", face.fileName, "--attach-file", face.path);
	}
	return args;
}

export interface FontPassResult {
	attachArgs: string[];
	/** Attachments of the file the new ones replace. */
	dropAttachmentIds: number[];
	attach: FontAttachment[];
	/** Fonts of the release cut down or restored, for the job's summary. */
	cut: number;
	restored: number;
}

/**
 * The font work of a remux that rewrites a file's subtitles without an
 * encode. An earlier pass's Rabbit faces are made again, with the faces of
 * `added` families, for the text the file will have. A face that cannot be
 * made again stays as it is. A font of the release Rabbit cut down earlier
 * gets back from its stored original any character the text now needs. With
 * `cutOthers`, the release's other fonts are cut down too, keeping their
 * originals, and with `uncut` every cut font is made whole again. A file cut
 * once stays cut through later passes. `subset` overrides that for Rabbit's faces.
 */
export async function refreshFonts(options: {
	mkvPath: string;
	/** Final ASS text of every track the output keeps or adds. */
	texts: readonly string[];
	/** Families the tracks added by this pass use. */
	added?: readonly RabbitFamily[];
	/** The file's fonts, when the caller already read them. */
	state?: FileFontState;
	settings: JobSettings;
	tempDir: string;
	signal?: AbortSignal;
	subset?: boolean;
	cutOthers?: boolean;
	uncut?: boolean;
}): Promise<FontPassResult> {
	const { texts, tempDir, signal } = options;
	const state = options.state ?? (await fileFontState(options.mkvPath, options.settings, tempDir, signal));
	const result: FontPassResult = { attachArgs: [], dropAttachmentIds: [], attach: [], cut: 0, restored: 0 };
	if (!state.readable) return result;
	const existing = state.rabbit;
	const subset = options.subset ?? (!!options.settings.subsetFonts || (existing.cut?.size ?? 0) > 0);

	if (options.added?.length || !alreadyCovered(existing, texts, subset)) {
		const built = await buildRabbitFaces({ families: [...existing.families, ...(options.added ?? [])], texts, subset, tempDir, signal });
		for (const [key, ids] of existing.attachmentIds) if (!built.unbuilt.has(key)) result.dropAttachmentIds.push(...ids);
		const unchanged = sameFiles(built.faces, state.fonts, result.dropAttachmentIds);
		result.dropAttachmentIds = result.dropAttachmentIds.filter((id) => !unchanged.ids.has(id));
		result.attach.push(...built.faces.filter((face) => !unchanged.faces.has(face)));
		if (result.attach.length || result.dropAttachmentIds.length) {
			Logger.info(`[fonts] Rebuilt the font group faces: ${result.attach.map((f) => f.fileName).join(", ") || "none needed"}`);
		}
	}

	if (options.uncut) restoreReleaseFonts(state, result);
	else await cutReleaseFonts(state, texts, !!options.cutOthers, tempDir, signal, result);
	result.attachArgs = rabbitFaceArgs(result.attach);
	return result;
}

/** Built faces identical to the attachment they would replace, which then stays. */
function sameFiles(
	faces: readonly FontAttachment[],
	fonts: readonly FileFont[],
	dropping: readonly number[],
): { faces: Set<FontAttachment>; ids: Set<number> } {
	const out = { faces: new Set<FontAttachment>(), ids: new Set<number>() };
	for (const face of faces) {
		const old = fonts.find((f) => dropping.includes(f.id) && f.fileName.toLowerCase() === face.fileName.toLowerCase());
		if (old && !out.ids.has(old.id) && sameBytes(old.path, face.path)) {
			out.faces.add(face);
			out.ids.add(old.id);
		}
	}
	return out;
}

function sameBytes(a: string, b: string): boolean {
	try {
		return readFileSync(a).equals(readFileSync(b));
	} catch {
		return false;
	}
}

/** Put the full original back in place of every release font Rabbit cut down. */
function restoreReleaseFonts(state: FileFontState, result: FontPassResult): void {
	const rabbitIds = new Set([...state.rabbit.attachmentIds.values()].flat());
	for (const font of state.fonts) {
		if (rabbitIds.has(font.id) || !font.original) continue;
		const original = originalPath(font.original);
		if (!original) {
			Logger.warn(`[fonts] The full copy of ${font.fileName} is gone, so it stays cut down`);
			continue;
		}
		result.dropAttachmentIds.push(font.id);
		result.attach.push({ fileName: font.fileName, path: original, mime: fontRegistry.mime(original) });
		result.restored++;
	}
}

/** A cut is only worth a replaced attachment when it saves this much. */
const MIN_CUT_SAVING = (size: number) => Math.max(1024, size * 0.02);

async function cutReleaseFonts(
	state: FileFontState,
	texts: readonly string[],
	cutOthers: boolean,
	tempDir: string,
	signal: AbortSignal | undefined,
	result: FontPassResult,
) {
	const rabbitIds = new Set([...state.rabbit.attachmentIds.values()].flat());
	const usage = faceUsage(texts);
	const requests: Array<CutRequest & { font: FileFont; restoring: boolean }> = [];
	for (const font of state.fonts) {
		if (rabbitIds.has(font.id) || !font.names.length) continue;
		const ext = extname(font.fileName).toLowerCase();
		if (ext !== ".ttf" && ext !== ".otf") continue; // a collection holds several fonts and is left whole
		const needed = new Set<number>();
		for (const name of font.names) for (const cp of usage.get(name)?.codepoints ?? []) needed.add(cp);
		if (!needed.size) continue; // a font no text draws in is not Rabbit's to cut
		let original: string | null = null;
		let sha: string;
		if (font.original) {
			original = originalPath(font.original);
			sha = font.original;
			if (!original) {
				Logger.warn(`[fonts] The full copy of ${font.fileName} is gone, so characters it lacks cannot be restored`);
				continue;
			}
		} else if (cutOthers) {
			original = font.path;
			sha = fontSha(font.path);
		} else continue;
		requests.push({
			font,
			restoring: !!font.original,
			current: font.path,
			original,
			out: join(tempDir, `cut_${font.id}${ext}`),
			needed: [...needed],
			unicodes: [...new Set([...KEPT_CODEPOINTS, ...needed])].sort((a, b) => a - b),
			sha,
		});
	}
	if (!requests.length) return;

	const results = await cutFonts(requests, tempDir, signal);
	if (!results) {
		Logger.warn("[fonts] Could not cut fonts down; leaving them as they are");
		return;
	}
	requests.forEach((req, i) => {
		const r = results[i];
		if (!r || "error" in r) {
			if (r) Logger.warn(`[fonts] Could not cut ${req.font.fileName}: ${r.error}`);
			return;
		}
		if ("restricted" in r) {
			Logger.info(`[fonts] ${req.font.fileName} does not allow cutting down, so it stays whole`);
			return;
		}
		const size = statSafe(req.font.path);
		const restore = req.restoring && r.missing > 0;
		const smaller = cutOthers && r.size <= size - MIN_CUT_SAVING(size);
		if (!restore && !smaller) return;
		if (!req.restoring) storeOriginal(req.font.path, req.sha);
		result.dropAttachmentIds.push(req.font.id);
		result.attach.push({ fileName: req.font.fileName, path: req.out, mime: fontRegistry.mime(req.out) });
		if (restore) result.restored++;
		else result.cut++;
		Logger.info(`[fonts] ${restore ? "Restored characters to" : "Cut down"} ${req.font.fileName}: ${size} -> ${r.size} B`);
	});
}

function statSafe(path: string): number {
	try {
		return Bun.file(path).size;
	} catch {
		return 0;
	}
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
