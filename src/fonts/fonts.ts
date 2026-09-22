import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { join, extname, basename, relative, resolve } from "path";
import { run } from "../core/process";
import { Logger } from "../core/logger";
import { normalizeFontName } from "../subtitles/ass-classifier";
import { detectScript, extractDialogueText, faceCandidateKeys } from "./script-detect";
import { readFontAxes, type FontAxis } from "./font-instance";
import { resolveStyleAppearance, type GroupStyleConfig, type StyleAppearance } from "../subtitles/subtitle-style";

const FONT_EXTS = new Set([".ttf", ".otf", ".ttc", ".otc"]);

export interface MkvAttachment {
	id: number;
	fileName: string;
}
export interface FontFace {
	fileName: string;
	path: string;
	keys: string[]; // normalized filename stem(s) + metadata keys
	family: string; // internal family name (fc-scan) — written as ASS Fontname
	names: string[]; // all normalized internal names (for cleanup matching)
	mime: string;
	axes: FontAxis[];
}
export interface FontFamily {
	label: string; // dropdown label = folder name (or internal family for a loose file)
	dir: string | null;
	faces: FontFace[];
	style?: GroupStyleConfig;
}
export interface ResolvedFace {
	family: string;
	names: string[];
	path: string;
	fileName: string;
	mime: string;
	axes: FontAxis[];
}

function mimeForFont(p: string): string {
	const ext = extname(p).toLowerCase();
	if (ext === ".otf" || ext === ".otc") return "font/otf";
	if (ext === ".ttc") return "font/collection";
	return "font/ttf";
}

async function scanFontNames(p: string, signal?: AbortSignal): Promise<{ family: string; names: string[] }> {
	const res = await run(["fc-scan", "--format", "%{family}\n%{fullname}\n%{postscriptname}\n", p], { signal });
	if (res.code !== 0) return { family: "", names: [] };
	const names = new Set<string>();
	let family = "";
	for (const raw of res.stdout.split("\n")) {
		for (const piece of raw.split(",")) {
			const n = piece.trim();
			if (!n) continue;
			if (!family) family = n;
			names.add(normalizeFontName(n));
		}
	}
	return { family, names: [...names] };
}

interface Metadata {
	label?: string;
	faces?: Record<string, { family?: string; keys?: string[] }>;
	style?: GroupStyleConfig["style"];
	overrides?: GroupStyleConfig["overrides"];
}

async function buildFace(path: string, stemKey: string, meta: Metadata | null, signal?: AbortSignal): Promise<FontFace> {
	const { family, names } = await scanFontNames(path, signal);
	const fileName = basename(path);
	const override = meta?.faces?.[fileName];
	const keys = new Set<string>([stemKey.toLowerCase()]);
	for (const k of override?.keys ?? []) keys.add(k.toLowerCase());
	const fam = override?.family || family || basename(fileName, extname(fileName));
	const allNames = new Set(names);
	allNames.add(normalizeFontName(fam));
	return { fileName, path, keys: [...keys], family: fam, names: [...allNames], mime: mimeForFont(path), axes: [] };
}

class FontRegistry {
	private stockDir = "/app/fonts";
	private userDir = "/config/fonts";
	private families: FontFamily[] = [];

	configure(seedDir: string, userDir: string): void {
		this.stockDir = seedDir;
		this.userDir = userDir;
	}

	/** Copy shipped groups into the user dir if missing. First-run only. */
	seed(names: string[]): void {
		if (!existsSync(this.userDir)) {
			try {
				mkdirSync(this.userDir, { recursive: true });
			} catch {}
		}
		for (const name of names) {
			const dst = join(this.userDir, name);
			const src = join(this.stockDir, name);
			if (existsSync(dst) || !existsSync(src)) continue;
			try {
				cpSync(src, dst, { recursive: true });
				Logger.info(`[fonts] Seeded "${name}" into ${this.userDir}`);
			} catch (err: any) {
				Logger.warn(`[fonts] Failed to seed "${name}": ${err?.message || err}`);
			}
		}
	}

	async reload(signal?: AbortSignal): Promise<void> {
		const byLabel = new Map<string, FontFamily>();
		for (const fam of await this.scanDir(this.userDir, "user", signal)) byLabel.set(fam.label, fam);
		this.families = [...byLabel.values()];
		const faceCount = this.families.reduce((n, f) => n + f.faces.length, 0);
		Logger.info(`[fonts] Loaded ${this.families.length} font group(s), ${faceCount} face(s) from ${this.userDir}`);
	}

	private async scanDir(dir: string, origin: "stock" | "user", signal?: AbortSignal): Promise<FontFamily[]> {
		const families: FontFamily[] = [];
		if (!existsSync(dir)) {
			Logger.debug(`[fonts] ${origin} dir does not exist: ${dir}`);
			return families;
		}
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch (err: any) {
			Logger.warn(`[fonts] Failed to read ${origin} dir ${dir}: ${err?.message || err}`);
			return families;
		}
		for (const entry of entries) {
			const full = join(dir, entry);
			let isDir = false;
			try {
				isDir = statSync(full).isDirectory();
			} catch {
				continue;
			}
			if (isDir) {
				let meta: Metadata | null = null;
				const metaPath = join(full, "metadata.json");
				if (existsSync(metaPath)) {
					try {
						meta = JSON.parse(readFileSync(metaPath, "utf-8"));
					} catch (err: any) {
						Logger.warn(`[fonts] Bad metadata.json in ${origin}/${entry}: ${err?.message || err}`);
					}
				}
				const faces: FontFace[] = [];
				for (const f of readdirSync(full)) {
					if (!FONT_EXTS.has(extname(f).toLowerCase())) continue;
					faces.push(await buildFace(join(full, f), basename(f, extname(f)), meta, signal));
				}
				if (faces.length || meta) {
					families.push({
						label: meta?.label || entry,
						dir: full,
						faces,
						style: meta ? { style: meta.style, overrides: meta.overrides } : undefined,
					});
				}
			} else if (FONT_EXTS.has(extname(entry).toLowerCase())) {
				const face = await buildFace(full, "default", null, signal);
				families.push({ label: face.family, dir: null, faces: [face] });
			}
		}
		const axesByPath = await readFontAxes(
			families.flatMap((f) => f.faces).map((f) => f.path),
			signal,
		);
		for (const fam of families) for (const f of fam.faces) f.axes = axesByPath.get(f.path) ?? [];
		return families;
	}

	list(): FontFamily[] {
		return this.families;
	}

	findFamily(label: string): FontFamily | undefined {
		return this.families.find((f) => f.label === label);
	}

	findFaceFile(label: string, fileName: string): FontFace | undefined {
		return this.findFamily(label)?.faces.find((f) => f.fileName === fileName);
	}

	/** Pick the face for a track given its language tag and a text sample. */
	resolve(label: string, langCode: string | undefined, text: string): ResolvedFace | null {
		const fam = this.findFamily(label);
		if (!fam || fam.faces.length === 0) return null;
		const script = detectScript(extractDialogueText(text));
		for (const cand of faceCandidateKeys(langCode, script)) {
			const face = fam.faces.find((f) => f.keys.includes(cand));
			if (face) return { family: face.family, names: face.names, path: face.path, fileName: face.fileName, mime: face.mime, axes: face.axes };
		}
		const f = fam.faces[0]!;
		return { family: f.family, names: f.names, path: f.path, fileName: f.fileName, mime: f.mime, axes: f.axes };
	}

	private toResolved(f: FontFace): ResolvedFace {
		return { family: f.family, names: f.names, path: f.path, fileName: f.fileName, mime: f.mime, axes: f.axes };
	}

	/** Resolve face + appearance together (one script detection). */
	resolveFaceAndStyle(label: string, langCode: string | undefined, text: string): { face: ResolvedFace | null; appearance: StyleAppearance } {
		const fam = this.findFamily(label);
		const script = detectScript(extractDialogueText(text));
		const appearance = resolveStyleAppearance(fam?.style ?? null, langCode, script);
		let face: ResolvedFace | null = null;
		if (fam && fam.faces.length > 0) {
			for (const cand of faceCandidateKeys(langCode, script)) {
				const hit = fam.faces.find((f) => f.keys.includes(cand));
				if (hit) {
					face = this.toResolved(hit);
					break;
				}
			}
			if (!face) face = this.toResolved(fam.faces[0]!);
		}
		return { face, appearance };
	}

	/** Stored appearance config for a group (for the style editor API). */
	getGroupStyle(label: string): GroupStyleConfig {
		return this.findFamily(label)?.style ?? {};
	}

	/** Persist appearance into <userDir>/<label>/metadata.json, preserving faces/label. */
	saveGroupStyle(label: string, cfg: GroupStyleConfig): boolean {
		const fam = this.findFamily(label);
		const dir = join(this.userDir, label);
		let meta: Metadata = {};
		const userMeta = join(dir, "metadata.json");
		const stockMeta = fam?.dir ? join(fam.dir, "metadata.json") : "";
		for (const p of [userMeta, stockMeta]) {
			if (p && existsSync(p)) {
				try {
					meta = JSON.parse(readFileSync(p, "utf-8"));
					break;
				} catch {}
			}
		}
		meta.style = cfg.style;
		meta.overrides = cfg.overrides;
		try {
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			writeFileSync(userMeta, JSON.stringify(meta, null, "\t"), "utf-8");
			return true;
		} catch (err: any) {
			Logger.warn(`[fonts] Failed to save style for "${label}": ${err?.message || err}`);
			return false;
		}
	}

	// group management

	getUserDir(): string {
		return this.userDir;
	}

	/** Resolve <userDir>/<label>, rejecting traversal / nested paths. */
	private safeGroupDir(label: string): string | null {
		const name = label.trim();
		if (!name || name.startsWith(".") || name.includes("/") || name.includes("\\")) return null;
		const dir = join(this.userDir, name);
		const rel = relative(this.userDir, dir);
		if (!rel || rel.startsWith("..") || rel.includes("/") || rel.includes("\\")) return null;
		return dir;
	}

	private readMeta(dir: string): Metadata {
		const p = join(dir, "metadata.json");
		if (existsSync(p)) {
			try {
				return JSON.parse(readFileSync(p, "utf-8"));
			} catch {}
		}
		return {};
	}

	private writeMeta(dir: string, meta: Metadata): boolean {
		try {
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "metadata.json"), JSON.stringify(meta, null, "\t"), "utf-8");
			return true;
		} catch (err: any) {
			Logger.warn(`[fonts] Failed to write metadata in ${dir}: ${err?.message || err}`);
			return false;
		}
	}

	createGroup(label: string): { ok: boolean; error?: string } {
		const name = label.trim();
		const dir = this.safeGroupDir(name);
		if (!dir) return { ok: false, error: "Invalid group name" };
		if (existsSync(dir)) return { ok: false, error: "A group with that name already exists" };
		try {
			mkdirSync(dir, { recursive: true });
		} catch (err: any) {
			return { ok: false, error: err?.message || "mkdir failed" };
		}
		this.writeMeta(dir, { label: name });
		return { ok: true };
	}

	renameGroup(oldLabel: string, newLabel: string): { ok: boolean; error?: string } {
		const fam = this.findFamily(oldLabel);
		if (!fam || !fam.dir) return { ok: false, error: "Group not found or not editable" };
		const name = newLabel.trim();
		if (name === oldLabel) return { ok: true };
		const newDir = this.safeGroupDir(name);
		if (!newDir) return { ok: false, error: "Invalid group name" };
		if (existsSync(newDir)) return { ok: false, error: "A group with that name already exists" };
		try {
			renameSync(fam.dir, newDir);
		} catch (err: any) {
			return { ok: false, error: err?.message || "rename failed" };
		}
		const meta = this.readMeta(newDir);
		meta.label = name;
		this.writeMeta(newDir, meta);
		return { ok: true };
	}

	deleteGroup(label: string): { ok: boolean; error?: string } {
		const fam = this.findFamily(label);
		if (!fam || !fam.dir) return { ok: false, error: "Group not found or not editable" };
		// Guard: only delete inside userDir.
		const guard = this.safeGroupDir(basename(fam.dir));
		if (!guard || resolve(guard) !== resolve(fam.dir)) return { ok: false, error: "Refusing to delete outside the user fonts dir" };
		try {
			rmSync(fam.dir, { recursive: true, force: true });
		} catch (err: any) {
			return { ok: false, error: err?.message || "delete failed" };
		}
		return { ok: true };
	}

	/** Copy a host font file into the group and record its keys. Never writes to the source. */
	async importFace(label: string, sourcePath: string, keys: string[]): Promise<{ ok: boolean; fileName?: string; error?: string }> {
		const fam = this.findFamily(label);
		const dir = fam?.dir ?? this.safeGroupDir(label);
		if (!dir) return { ok: false, error: "Group not found or not editable" };
		const ext = extname(sourcePath).toLowerCase();
		if (!FONT_EXTS.has(ext)) return { ok: false, error: "Not a font file" };
		if (!existsSync(sourcePath)) return { ok: false, error: "Source font no longer exists" };
		if (!existsSync(dir)) {
			try {
				mkdirSync(dir, { recursive: true });
			} catch {}
		}
		let fileName = basename(sourcePath);
		if (existsSync(join(dir, fileName))) {
			const stem = basename(fileName, ext);
			let n = 2;
			while (existsSync(join(dir, `${stem}_${n}${ext}`))) n++;
			fileName = `${stem}_${n}${ext}`;
		}
		try {
			copyFileSync(sourcePath, join(dir, fileName));
		} catch (err: any) {
			return { ok: false, error: err?.message || "copy failed" };
		}
		const meta = this.readMeta(dir);
		meta.faces ??= {};
		meta.faces[fileName] = { ...(meta.faces[fileName] ?? {}), keys: this.cleanKeys(keys) };
		this.writeMeta(dir, meta);
		return { ok: true, fileName };
	}

	deleteFace(label: string, fileName: string): { ok: boolean; error?: string } {
		const fam = this.findFamily(label);
		if (!fam || !fam.dir) return { ok: false, error: "Group not found or not editable" };
		const safeName = basename(fileName);
		if (safeName !== fileName) return { ok: false, error: "Invalid file name" };
		const target = join(fam.dir, safeName);
		if (!existsSync(target)) return { ok: false, error: "Font not found in group" };
		try {
			rmSync(target, { force: true });
		} catch (err: any) {
			return { ok: false, error: err?.message || "delete failed" };
		}
		const meta = this.readMeta(fam.dir);
		if (meta.faces?.[safeName]) {
			delete meta.faces[safeName];
			this.writeMeta(fam.dir, meta);
		}
		return { ok: true };
	}

	setFaceKeys(label: string, fileName: string, keys: string[], family?: string): { ok: boolean; error?: string } {
		const fam = this.findFamily(label);
		if (!fam || !fam.dir) return { ok: false, error: "Group not found or not editable" };
		const safeName = basename(fileName);
		if (!fam.faces.some((f) => f.fileName === safeName)) return { ok: false, error: "Font not found in group" };
		const meta = this.readMeta(fam.dir);
		meta.faces ??= {};
		const entry: { family?: string; keys?: string[] } = { ...(meta.faces[safeName] ?? {}), keys: this.cleanKeys(keys) };
		if (family && family.trim()) entry.family = family.trim();
		else delete entry.family;
		meta.faces[safeName] = entry;
		this.writeMeta(fam.dir, meta);
		return { ok: true };
	}

	private cleanKeys(keys: string[]): string[] {
		return [...new Set(keys.map((k) => k.trim().toLowerCase()).filter(Boolean))];
	}

	mime = mimeForFont;
}

export const fontRegistry = new FontRegistry();

export async function listMkvAttachments(mkvPath: string, signal?: AbortSignal): Promise<MkvAttachment[]> {
	const res = await run(["mkvmerge", "-J", mkvPath], { signal });
	if (res.code !== 0) return [];
	try {
		const j = JSON.parse(res.stdout);
		return (j.attachments ?? []).map((a: any) => ({ id: Number(a.id), fileName: String(a.file_name) }));
	} catch {
		return [];
	}
}

/**
 * Read the internal family/full/PostScript names of source font attachments
 * which will actually survive the mux.
 *
 * When `dropUnusedFonts` is enabled, only attachments whose names intersect
 * `usedFonts` reserve their identities. This prevents an unused source font
 * from unnecessarily forcing `Family 2` before that source font is dropped.
 * When unused-font removal is disabled, every source font reserves its names.
 *
 * Returns null when attachment extraction fails. The caller may continue, but
 * should preserve all source attachments and treat numbering as best-effort.
 */
export async function scanMkvAttachmentFontNames(
	mkvPath: string,
	tempDir: string,
	usedFonts: ReadonlySet<string>,
	dropUnusedFonts: boolean,
	signal?: AbortSignal,
): Promise<Set<string> | null> {
	const attachments = (await listMkvAttachments(mkvPath, signal)).filter((a) => FONT_EXTS.has(extname(a.fileName).toLowerCase()));
	if (attachments.length === 0) return new Set();

	const specs: string[] = [];
	const outById = new Map<number, string>();
	for (const a of attachments) {
		const sourceExt = extname(a.fileName).toLowerCase();
		const safeExt = FONT_EXTS.has(sourceExt) ? sourceExt : ".font";
		const out = join(tempDir, `fontscan_att_${a.id}${safeExt}`);
		specs.push(`${a.id}:${out}`);
		outById.set(a.id, out);
	}

	const ext = await run(["mkvextract", mkvPath, "attachments", ...specs], { signal });
	if (ext.code !== 0) {
		Logger.warn(`[fonts] Could not scan source font attachments (${ext.stderr || ext.stdout})`);
		return null;
	}

	const occupied = new Set<string>();
	for (const a of attachments) {
		const out = outById.get(a.id)!;
		if (!existsSync(out)) continue;

		const { names } = await scanFontNames(out, signal);
		const retained = !dropUnusedFonts || names.some((name) => usedFonts.has(name));
		if (!retained) continue;

		for (const name of names) occupied.add(name);

		// If scanning failed and the attachment is being preserved, reserve its
		// visible stem as a conservative fallback.
		if (names.length === 0) {
			const stem = basename(a.fileName, extname(a.fileName));
			if (stem) occupied.add(normalizeFontName(stem));
		}
	}
	return occupied;
}

/**
 * Extract every attachment from `mkvPath`, then return mkvmerge --attach-file
 * args for all non-font attachments plus source fonts referenced by surviving
 * ASS tracks. When `dropUnusedFonts` is false, every source font is preserved.
 *
 * Injected fonts already use collision-free numbered internal families, so this
 * function must not replace a source font merely because names overlap.
 *
 * Returns null on extraction failure - the caller should then fall back to
 * passing source attachments through untouched rather than dropping them.
 */
export async function buildKeptAttachmentArgs(
	mkvPath: string,
	usedFonts: Set<string>,
	tempDir: string,
	dropUnusedFonts: boolean,
	signal?: AbortSignal,
): Promise<string[] | null> {
	const kept = await collectKeptAttachments(mkvPath, usedFonts, tempDir, dropUnusedFonts, signal);
	return kept && keptAttachmentArgs(kept);
}

/** One attachment that survives the mux, already extracted to `path`. */
export interface KeptAttachment {
	fileName: string;
	path: string;
	mime: string;
	isFont: boolean;
	/** Normalized internal names of a kept font; empty for other attachments. */
	names: string[];
}

/**
 * The attachment-collecting half of `buildKeptAttachmentArgs`, for callers that
 * merge the attachments of more than one input and must dedupe across them.
 * `filePrefix` separates the extraction dirs of two files sharing a temp dir.
 */
export async function collectKeptAttachments(
	mkvPath: string,
	usedFonts: ReadonlySet<string>,
	tempDir: string,
	dropUnusedFonts: boolean,
	signal?: AbortSignal,
	filePrefix = "att",
): Promise<KeptAttachment[] | null> {
	const attachments = await listMkvAttachments(mkvPath, signal);
	if (attachments.length === 0) return [];

	const specs: string[] = [];
	const outById = new Map<number, string>();
	for (const a of attachments) {
		const out = join(tempDir, `${filePrefix}_${a.id}_${a.fileName}`);
		specs.push(`${a.id}:${out}`);
		outById.set(a.id, out);
	}

	const ext = await run(["mkvextract", mkvPath, "attachments", ...specs], { signal });
	if (ext.code !== 0) {
		Logger.warn(`[fonts] mkvextract failed (${ext.stderr || ext.stdout}); keeping all source attachments`);
		return null;
	}

	const kept: KeptAttachment[] = [];
	for (const a of attachments) {
		const out = outById.get(a.id)!;
		if (!existsSync(out)) continue;
		const isFont = FONT_EXTS.has(extname(a.fileName).toLowerCase());
		if (!isFont) {
			kept.push({ fileName: a.fileName, path: out, mime: "", isFont: false, names: [] });
			continue;
		}
		const { names } = await scanFontNames(out, signal);
		if (!dropUnusedFonts || names.some((n) => usedFonts.has(n))) {
			// A font we could not scan still reserves its visible stem, so an
			// injected face cannot take a name this attachment might answer to.
			const reserved = names.length > 0 ? names : [normalizeFontName(basename(a.fileName, extname(a.fileName)))].filter(Boolean);
			kept.push({ fileName: a.fileName, path: out, mime: mimeForFont(out), isFont: true, names: reserved });
		} else {
			Logger.info(`[fonts] Dropping unused font: ${a.fileName}`);
		}
	}
	return kept;
}

/** mkvmerge args attaching each kept attachment under its original name. */
export function keptAttachmentArgs(kept: readonly KeptAttachment[]): string[] {
	const args: string[] = [];
	for (const a of kept) {
		if (a.isFont) args.push("--attachment-mime-type", a.mime);
		args.push("--attachment-name", a.fileName, "--attach-file", a.path);
	}
	return args;
}
