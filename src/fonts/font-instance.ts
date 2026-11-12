import { run } from "../core/process";
import { normalizeFontName } from "../subtitles/ass-classifier";
import type { FaceStyle } from "../subtitles/face-usage";

const AXES_PY = `
import sys, json
from fontTools.ttLib import TTFont
out = {}
for p in sys.argv[1:]:
    rec = {"variable": False, "axes": []}
    try:
        f = TTFont(p, lazy=True)
        if "fvar" in f:
            rec["variable"] = True
            nm = f["name"]
            for a in f["fvar"].axes:
                rec["axes"].append({"tag": a.axisTag, "min": a.minValue,
                    "default": a.defaultValue, "max": a.maxValue,
                    "name": (nm.getDebugName(a.axisNameID) or a.axisTag)})
    except Exception as e:
        rec["error"] = str(e)
    out[p] = rec
print(json.dumps(out))
`;

const INSTANCE_PY = `
import sys, json
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
cfg = json.loads(sys.argv[1])
family, bold, italic = cfg["family"], cfg["bold"], cfg["italic"]
f = TTFont(cfg["src"])
if "fvar" in f:
    instantiateVariableFont(f, cfg["coords"], inplace=True)  # coords cover all axes -> fully static
nm = f["name"]
subfamily = "Bold Italic" if bold and italic else "Bold" if bold else "Italic" if italic else "Regular"
full = family if subfamily == "Regular" else family + " " + subfamily
ps = "".join(family.split()) + ("" if subfamily == "Regular" else "-" + subfamily.replace(" ", ""))

# Remove stale localized/typographic/WWS names left by the variable instance,
# then publish one deterministic family/style identity. Name 3 carries the
# recipe, so a later remux can rebuild this face from the font group.
for nid in (1, 2, 3, 4, 6, 16, 17, 21, 22):
    nm.names = [r for r in nm.names if r.nameID != nid]
for nid, val in [(1, family), (16, family), (21, family),
                 (2, subfamily), (17, subfamily), (22, subfamily),
                 (3, cfg.get("recipe") or ps), (4, full), (6, ps)]:
    nm.setName(val, nid, 3, 1, 0x409)
    nm.setName(val, nid, 1, 0, 0)

# The chosen variable coordinates define the glyph appearance, but libass and
# fontconfig must match this attachment as the ASS style requested by the user.
# Otherwise a source/system Regular face can beat an instanced face even when
# the ASS document points at the intended collision-free family.
if "OS/2" in f:
    os2 = f["OS/2"]
    os2.usWeightClass = 700 if bold else 400
    os2.usWidthClass = 5
    os2.fsSelection &= ~((1 << 0) | (1 << 5) | (1 << 6) | (1 << 9))
    if italic:
        os2.fsSelection |= 1 << 0
    if bold:
        os2.fsSelection |= 1 << 5
    if not bold and not italic:
        os2.fsSelection |= 1 << 6
if "head" in f:
    f["head"].macStyle &= ~0x3
    f["head"].macStyle |= (0x1 if bold else 0) | (0x2 if italic else 0)
if "post" in f and not italic:
    f["post"].italicAngle = 0

if cfg.get("unicodes"):
    from fontTools import subset
    opts = subset.Options()
    opts.layout_features = ["*"]
    opts.name_IDs = ["*"]
    opts.name_languages = ["*"]
    opts.name_legacy = True
    opts.notdef_outline = True
    opts.legacy_kern = True
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=cfg["unicodes"])
    sub.subset(f)
f.save(cfg["out"])
print(json.dumps({"family": family, "ps": ps}))
`;

const RECIPES_PY = `
import sys, json
from fontTools.ttLib import TTFont
out = {}
for p in sys.argv[1:]:
    try:
        out[p] = TTFont(p, lazy=True)["name"].getDebugName(3)
    except Exception:
        out[p] = None
print(json.dumps(out))
`;

/**
 * How Rabbit made a face from its font group: the upright file of the group,
 * the axes it pinned and whether the style is bold. Stored in the face itself,
 * so any later remux can rebuild the face and its variants for the text the
 * file then has.
 */
export interface FaceRecipe {
	group: string;
	face: string;
	coords: Record<string, number>;
	bold: boolean;
	/** Set on a face cut down to the characters the subtitles used. */
	subset?: boolean;
}

const RECIPE_PREFIX = "RabbitEncoder;";

export function encodeRecipe(recipe: FaceRecipe): string {
	return RECIPE_PREFIX + JSON.stringify(recipe);
}

export function decodeRecipe(value: string | null | undefined): FaceRecipe | null {
	if (!value?.startsWith(RECIPE_PREFIX)) return null;
	try {
		const r = JSON.parse(value.slice(RECIPE_PREFIX.length));
		if (typeof r?.group !== "string" || typeof r?.face !== "string" || typeof r?.coords !== "object" || r.coords === null) return null;
		const coords: Record<string, number> = {};
		for (const [tag, v] of Object.entries(r.coords)) if (typeof v === "number" && Number.isFinite(v)) coords[tag] = v;
		return { group: r.group, face: r.face, coords, bold: !!r.bold, ...(r.subset ? { subset: true } : {}) };
	} catch {
		return null;
	}
}

/** The recipe each font carries, or null for a font Rabbit did not make. */
export async function readFontRecipes(paths: string[], signal?: AbortSignal): Promise<Map<string, FaceRecipe | null>> {
	const map = new Map<string, FaceRecipe | null>();
	if (paths.length === 0) return map;
	const res = await run(["python3", "-c", RECIPES_PY, ...paths], { signal });
	if (res.code !== 0) return map;
	try {
		for (const [p, v] of Object.entries(JSON.parse(res.stdout) as Record<string, string | null>)) map.set(p, decodeRecipe(v));
	} catch {
		/* leave empty */
	}
	return map;
}

export interface FontAxis {
	tag: string;
	min: number;
	default: number;
	max: number;
	name: string;
}

export async function readFontAxes(paths: string[], signal?: AbortSignal): Promise<Map<string, FontAxis[]>> {
	const map = new Map<string, FontAxis[]>();
	if (paths.length === 0) return map;
	const res = await run(["python3", "-c", AXES_PY, ...paths], { signal });
	if (res.code !== 0) return map;
	try {
		const parsed = JSON.parse(res.stdout) as Record<string, { variable: boolean; axes: FontAxis[] }>;
		for (const [p, rec] of Object.entries(parsed)) map.set(p, rec.variable ? rec.axes : []);
	} catch {
		/* leave empty */
	}
	return map;
}

export interface InstancedFace {
	path: string;
	family: string;
	names: string[];
}

/**
 * Materialize a font at `outPath`, pinning variable axes when present and
 * stamping the family name supplied by the caller. `coords` may be empty for a
 * static font that only needs a collision-free internal family alias.
 *
 * Axis coordinates never appear in the visible family or attachment name.
 * Returns null on failure so the caller can fall back to the original face.
 */
export interface InstanceOptions {
	italic?: boolean;
	/** Stored in the face so a later remux can rebuild it. */
	recipe?: FaceRecipe;
	/** Keep only these code points. Every code point is kept when omitted. */
	unicodes?: number[];
}

export async function instanceFont(
	src: string,
	coords: Record<string, number>,
	family: string,
	styleBold: boolean,
	outPath: string,
	signal?: AbortSignal,
	options: InstanceOptions = {},
): Promise<InstancedFace | null> {
	const italic = !!options.italic;
	const cfg = {
		src,
		out: outPath,
		family,
		bold: styleBold,
		italic,
		coords,
		recipe: options.recipe
			? encodeRecipe({
					group: options.recipe.group,
					face: options.recipe.face,
					coords: options.recipe.coords,
					bold: options.recipe.bold,
					...(options.unicodes ? { subset: true } : {}),
				})
			: null,
		unicodes: options.unicodes ?? null,
	};
	const res = await run(["python3", "-c", INSTANCE_PY, JSON.stringify(cfg)], { signal });
	if (res.code !== 0) return null;
	let ps = styleName(family, styleBold, italic).ps;
	try {
		ps = JSON.parse(res.stdout).ps ?? ps;
	} catch {
		/* keep default ps */
	}
	return { path: outPath, family, names: instancedFontNames(family, styleBold, ps, italic) };
}

function styleName(family: string, bold: boolean, italic: boolean): { full: string; ps: string } {
	const sub = bold && italic ? "Bold Italic" : bold ? "Bold" : italic ? "Italic" : "";
	return { full: sub ? `${family} ${sub}` : family, ps: `${family.replace(/\s+/g, "")}${sub ? `-${sub.replace(" ", "")}` : ""}` };
}

/**
 * All normalized names published by `instanceFont` for collision checks.
 * `postScriptName` is optional so callers can use the exact value returned by
 * fontTools, while the normal resolver uses the deterministic local value.
 */
export function instancedFontNames(family: string, styleBold: boolean, postScriptName?: string, italic = false): string[] {
	const { full, ps } = styleName(family, styleBold, italic);
	return [...new Set([family, full, postScriptName ?? ps].map((name) => normalizeFontName(name)))];
}

/** The names of every style Rabbit may attach under one family. */
export function familyVariantNames(family: string): string[] {
	const names = new Set<string>();
	for (const bold of [false, true]) for (const italic of [false, true]) for (const n of instancedFontNames(family, bold, undefined, italic)) names.add(n);
	return [...names];
}

/**
 * Build the on-disk / MKV attachment filename for an injected face. libass
 * matches embedded fonts by their internal name table, not the filename, so the
 * family ("Noto Sans 2") keeps spaces while the file becomes "noto_sans_2.ttf".
 * A face built next to the one the style names adds its style: "noto_sans_2_bold_italic.ttf".
 * `ext` includes the leading dot.
 */
export function fontAttachmentFileName(family: string, ext: string, style?: FaceStyle): string {
	if (style) family = `${family} ${style}`;
	const slug = family
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return `${slug || "font"}${ext}`;
}

/**
 * Pick the first family identity not already present in source attachments or
 * reserved by another injected face:
 *
 *   Noto Sans -> Noto Sans 2 -> Noto Sans 3 -> ...
 */
export function chooseAvailableFontFamily(baseFamily: string, occupiedNames: ReadonlySet<string>): string {
	for (let index = 1; ; index++) {
		const candidate = index === 1 ? baseFamily : `${baseFamily} ${index}`;
		// Bold and italic faces may join the family later, so their names must be free too.
		if (familyVariantNames(candidate).every((name) => !occupiedNames.has(name))) return candidate;
	}
}

/** Suffix encoding the non-default axis values, e.g. "wght350 wdth87". Empty if all default. */
export function axisSuffix(axes: FontAxis[], chosen: Record<string, number>): { suffix: string; coords: Record<string, number> } {
	const coords: Record<string, number> = {};
	const parts: string[] = [];
	for (const a of axes) {
		const raw = chosen[a.tag];
		const v = typeof raw === "number" ? Math.min(a.max, Math.max(a.min, raw)) : a.default;
		coords[a.tag] = v;
		if (v !== a.default) parts.push(`${a.tag}${Math.round(v)}`);
	}
	return { suffix: parts.join(" "), coords };
}
