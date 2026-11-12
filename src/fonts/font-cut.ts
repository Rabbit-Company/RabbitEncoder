import { createHash } from "crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { extname, join } from "path";
import { run } from "../core/process";
import { fontRegistry } from "./fonts";

/**
 * The name record a cut font keeps the hash of its full original in. IDs from
 * 256 up are free for a font's own use, and nothing that matches fonts reads them.
 */
export const ORIGINAL_NAME_ID = 21061;
const ORIGINAL_PREFIX = "RabbitEncoderOriginal;";

export function originalMarker(sha: string): string {
	return ORIGINAL_PREFIX + sha;
}

export function readOriginalMarker(value: string | null | undefined): string | null {
	if (!value?.startsWith(ORIGINAL_PREFIX)) return null;
	const sha = value.slice(ORIGINAL_PREFIX.length);
	return /^[0-9a-f]{64}$/.test(sha) ? sha : null;
}

/**
 * Full copies of the fonts Rabbit cut down, one file per content hash, so a
 * season sharing its fonts stores each once. A cut font names its original by
 * hash, and Rabbit restores characters from it when later text needs them.
 */
export function originalsDir(): string {
	return join(fontRegistry.getUserDir(), ".originals");
}

export function fontSha(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Keep a full copy of `path` under its hash, unless one is there already. */
export function storeOriginal(path: string, sha: string): void {
	const dir = originalsDir();
	mkdirSync(dir, { recursive: true });
	const dest = join(dir, `${sha}${extname(path).toLowerCase()}`);
	if (!existsSync(dest)) copyFileSync(path, dest);
}

export function originalPath(sha: string): string | null {
	const dir = originalsDir();
	for (const ext of [".ttf", ".otf"]) {
		const p = join(dir, `${sha}${ext}`);
		if (existsSync(p)) return p;
	}
	return null;
}

export function originalsUsage(): { count: number; bytes: number } {
	const dir = originalsDir();
	if (!existsSync(dir)) return { count: 0, bytes: 0 };
	let count = 0;
	let bytes = 0;
	for (const f of readdirSync(dir)) {
		try {
			bytes += statSync(join(dir, f)).size;
			count++;
		} catch {}
	}
	return { count, bytes };
}

export function clearOriginals(): void {
	rmSync(originalsDir(), { recursive: true, force: true });
}

const CUT_PY = `
import sys, json, os
from fontTools.ttLib import TTFont
from fontTools import subset
out = []
for j in json.load(open(sys.argv[1])):
    try:
        orig = TTFont(j["original"], recalcTimestamp=False)
        if "OS/2" in orig and orig["OS/2"].fsType & 0x0100:
            out.append({"restricted": True})
            continue
        cur = TTFont(j["current"], lazy=True)
        cmap = cur.getBestCmap() or {}
        missing = sum(1 for u in j["needed"] if u not in cmap)
        have = orig.getBestCmap() or {}
        opts = subset.Options()
        opts.layout_features = ["*"]
        opts.name_IDs = ["*"]
        opts.name_languages = ["*"]
        opts.name_legacy = True
        opts.notdef_outline = True
        opts.legacy_kern = True
        sub = subset.Subsetter(opts)
        sub.populate(unicodes=[u for u in j["unicodes"] if u in have])
        sub.subset(orig)
        nm = orig["name"]
        nm.names = [r for r in nm.names if r.nameID != ${ORIGINAL_NAME_ID}]
        nm.setName(j["marker"], ${ORIGINAL_NAME_ID}, 3, 1, 0x409)
        orig.save(j["out"])
        out.append({"missing": missing, "size": os.path.getsize(j["out"])})
    except Exception as e:
        out.append({"error": str(e)})
print(json.dumps(out))
`;

export interface CutRequest {
	/** The font the file carries now. */
	current: string;
	/** The full font to cut from. */
	original: string;
	out: string;
	/** Characters the text draws in it. */
	needed: number[];
	/** Characters to keep: `needed` plus a small fixed set. */
	unicodes: number[];
	sha: string;
}

export type CutResult = { restricted: true } | { missing: number; size: number } | { error: string };

/**
 * Cut fonts to characters, from their full originals. Each result also says
 * how many needed characters the current font lacks. A font whose licence
 * forbids subsetting is reported and left alone.
 */
export async function cutFonts(requests: readonly CutRequest[], workDir: string, signal?: AbortSignal): Promise<CutResult[] | null> {
	if (!requests.length) return [];
	const jobs = requests.map((r) => ({
		current: r.current,
		original: r.original,
		out: r.out,
		needed: r.needed,
		unicodes: r.unicodes,
		marker: originalMarker(r.sha),
	}));
	// A batch for a CJK show can pass the size one command-line argument may have.
	const jobsPath = join(workDir, `fontcut_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
	writeFileSync(jobsPath, JSON.stringify(jobs));
	const res = await run(["python3", "-c", CUT_PY, jobsPath], { signal });
	if (res.code !== 0) return null;
	try {
		return JSON.parse(res.stdout) as CutResult[];
	} catch {
		return null;
	}
}
