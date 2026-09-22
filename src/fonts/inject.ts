import { extname, join } from "path";
import { Logger } from "../core/logger";
import { fontRegistry, type ResolvedFace } from "./fonts";
import { axisSuffix, chooseAvailableFontFamily, fontAttachmentFileName, instancedFontNames, instanceFont } from "./font-instance";
import type { StyleAppearance } from "../subtitles/subtitle-style";

/**
 * Attachment extension for an injected face. Anything that is not a known
 * OpenType/collection container is attached as ".ttf".
 */
function cleanAttachmentExtension(fileName: string): string {
	const extension = extname(fileName).toLowerCase();
	if (extension === ".otf") return ".otf";
	if (extension === ".ttc" || extension === ".otc") return extension;
	return ".ttf";
}

/**
 * Turn a font-group face into the face actually written into the ASS and
 * attached to the MKV:
 *
 *  - variable axes (e.g. `wght: 700`) are pinned into a materialized copy, so
 *    the weight survives into the player instead of falling back to the
 *    variable font's default instance;
 *  - the internal family is renamed ("Noto Sans" -> "Noto Sans 2") when the
 *    plain name is already claimed by an attachment we keep, so libass cannot
 *    resolve our dialogue font to somebody else's face of the same name.
 *
 * Both callers (encode and repair) must use this: a track restyled without it
 * renders at the wrong weight, or picks up a same-named attachment left in the
 * file by an earlier pass.
 */
export type FaceMaterializer = (face: ResolvedFace | null, appearance: StyleAppearance) => Promise<ResolvedFace | null>;

/**
 * Build a materializer bound to one job. `occupiedNames` accumulates every
 * identity taken so far (seed it with the names of attachments that survive the
 * mux); repeated calls for the same face+appearance reuse the first result.
 */
export function createFaceMaterializer(options: {
	tempDir: string;
	occupiedNames: Set<string>;
	signal?: AbortSignal;
	/** Seam for tests; defaults to the fontTools-backed instancer. */
	instance?: typeof instanceFont;
}): FaceMaterializer {
	const { tempDir, occupiedNames, signal } = options;
	const instance = options.instance ?? instanceFont;
	const cache = new Map<string, ResolvedFace>();

	return async (face, appearance) => {
		if (!face) return null;
		const axes = face.axes ?? [];
		const { suffix: axisKey, coords } = axisSuffix(axes, appearance.fontAxes ?? {});
		const cacheKey = `${face.path}|${axisKey || "default"}|${appearance.bold ? "bold" : "regular"}`;
		const cached = cache.get(cacheKey);
		if (cached) return cached;

		const family = chooseAvailableFontFamily(face.family, occupiedNames, appearance.bold);
		const familyChanged = family !== face.family;
		const needsMaterializedCopy = axisKey.length > 0 || familyChanged;
		const sourceFontExt = cleanAttachmentExtension(face.fileName);
		const materializedExt = sourceFontExt === ".otf" ? ".otf" : ".ttf";

		let resolved: ResolvedFace;
		if (needsMaterializedCopy) {
			const materializeKey = `${cacheKey}|${family}`;
			const out = join(tempDir, `inst_${Buffer.from(materializeKey).toString("base64url").slice(0, 40)}${materializedExt}`);
			const inst = await instance(face.path, coords, family, appearance.bold, out, signal);
			if (inst) {
				resolved = {
					...face,
					family: inst.family,
					path: inst.path,
					names: inst.names,
					fileName: fontAttachmentFileName(family, materializedExt),
					mime: fontRegistry.mime(inst.path),
				};
			} else {
				Logger.warn(`[fonts] Could not materialize ${face.fileName} as "${family}"; using the original face`);
				resolved = { ...face, fileName: fontAttachmentFileName(face.family, sourceFontExt) };
			}
		} else {
			resolved = { ...face, fileName: fontAttachmentFileName(family, sourceFontExt) };
		}

		for (const name of resolved.names.length > 0 ? resolved.names : instancedFontNames(resolved.family, false)) {
			occupiedNames.add(name);
		}
		cache.set(cacheKey, resolved);
		return resolved;
	};
}
