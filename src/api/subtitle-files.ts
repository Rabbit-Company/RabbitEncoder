import { existsSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { extname, isAbsolute, join, relative, resolve } from "path";
import type { Web } from "@rabbit-company/web";
import type { AppConfig, SubtitleFileFontSource, SubtitleFilesJobRequest } from "../core/types";
import { FONT_EXTS, fontExtension, fontFileName } from "../fonts/fonts";
import { mkvFilesIn } from "../pipeline/release-subs";
import { renameFontFamily } from "../pipeline/repair-fonts";
import { buildSubtitleFilePlan, readFontSource, scanSubtitleFiles, SUBTITLE_FILE_EXTS } from "../pipeline/subtitle-files";
import { normalizeFontName } from "../subtitles/ass-classifier";
import { resolveTranslateLang } from "../translate/translate-languages";
import { addSubtitleAddJob, getAllJobs } from "../queue/store";
import { allowedRoots, resolveAllowedDirectory, resolveAllowedMkv } from "./repair";

const MAX_FONT_BYTES = 64 * 1024 * 1024;
const MAX_PAIRS = 500;
const MAX_FONTS = 300;

function uploadDir(config: AppConfig): string {
	const dir = join(config.tempDir, "subtitle-font-uploads");
	mkdirSync(dir, { recursive: true });
	return realpathSync(dir);
}

const inside = (path: string, root: string) => {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** A file inside Rabbit's media folders with one of `exts`. */
function resolveAllowedFile(raw: unknown, config: AppConfig, exts: Set<string>, label: string): string {
	if (typeof raw !== "string" || !raw.trim()) throw new Error(`${label} path is required`);
	const candidate = resolve(raw.trim());
	if (!existsSync(candidate) || !statSync(candidate).isFile()) throw new Error(`${label} ${raw} does not exist`);
	const real = realpathSync(candidate);
	if (!allowedRoots(config).some((root) => inside(real, root))) throw new Error(`${label} must be inside an input, output, or configured library directory`);
	if (!exts.has(extname(real).toLowerCase())) throw new Error(`${label} ${raw} has an unsupported extension`);
	return real;
}

/** A font from the media folders, or one Rabbit stored from an upload. */
export function resolveFont(raw: unknown, config: AppConfig): string {
	if (typeof raw === "string" && inside(resolve(raw), uploadDir(config))) {
		const path = resolve(raw);
		if (!existsSync(path) || !FONT_EXTS.has(extname(path).toLowerCase())) throw new Error("An uploaded font is no longer available, upload it again");
		return path;
	}
	return resolveAllowedFile(raw, config, FONT_EXTS, "Font");
}

export function registerSubtitleFileRoutes(app: Web, config: AppConfig): void {
	/** Pairs the videos of one folder with the subtitle files of another and reports the fonts they need. */
	app.post("/api/subtitle-files/scan", async (c) => {
		const tempDir = join(config.tempDir, `subtitle-files-${randomUUID()}`);
		try {
			const raw = (await c.req.json()) as { targetDir?: unknown; subtitleDir?: unknown };
			const targetDir = resolveAllowedDirectory(raw.targetDir, config);
			const subtitleDir = resolveAllowedDirectory(raw.subtitleDir, config);
			const targets = mkvFilesIn(targetDir);
			if (!targets.length) throw new Error("The videos folder has no MKV files");
			if (targets.length > MAX_PAIRS) throw new Error(`A folder may contain at most ${MAX_PAIRS} MKV files`);
			mkdirSync(tempDir, { recursive: true });
			return c.json(await scanSubtitleFiles({ targetDir, subtitleDir, targets, settings: config.defaults, tempDir, signal: c.req.signal }));
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	/**
	 * Stores an uploaded font for a font the subtitles name. One with another
	 * family is renamed to that name, so the subtitles find it.
	 */
	app.post("/api/subtitle-files/font", async (c) => {
		const dir = uploadDir(config);
		const id = randomUUID();
		let uploaded = "";
		try {
			// Without a name the font keeps its own, and the page matches it to the fonts the subtitles use.
			const name = (c.query().get("name") ?? "").trim();
			if (name.length > 200) throw new Error("The font name is too long");
			if (Number(c.req.headers.get("content-length") ?? 0) > MAX_FONT_BYTES) throw new Error("The font file is too large");
			const bytes = new Uint8Array(await c.req.arrayBuffer());
			if (bytes.length > MAX_FONT_BYTES) throw new Error("The font file is too large");
			const ext = fontExtension(bytes);
			if (!ext) throw new Error("The file is not a TrueType or OpenType font");
			uploaded = join(dir, `${id}.upload${ext}`);
			writeFileSync(uploaded, bytes);
			const scanned = await readFontSource(uploaded, c.req.signal);
			if (!scanned) throw new Error("The font could not be read");
			const out = join(dir, id);
			mkdirSync(out);
			const fileName = fontFileName(name || scanned.family, ext);
			const path = join(out, fileName);
			let result: SubtitleFileFontSource;
			if (!name || scanned.names.includes(normalizeFontName(name))) {
				writeFileSync(path, bytes);
				result = { ...scanned, path, fileName };
			} else {
				if (!(await renameFontFamily(uploaded, path, scanned.family, name, c.req.signal)))
					throw new Error(
						`The font is named "${scanned.family}" and could not be renamed to "${name}". Upload a single TTF or OTF font instead of a collection.`,
					);
				const renamed = await readFontSource(path, c.req.signal);
				if (!renamed?.names.includes(normalizeFontName(name))) throw new Error(`The font could not be renamed to "${name}"`);
				result = { ...renamed, fileName, renamedFrom: scanned.family };
			}
			return c.json(result, 201);
		} catch (error: any) {
			rmSync(join(dir, id), { recursive: true, force: true });
			return c.json({ error: error?.message || String(error) }, 400);
		} finally {
			if (uploaded) rmSync(uploaded, { force: true });
		}
	});

	/** One subtitle-add job per paired video. */
	app.post("/api/subtitle-files/jobs", async (c) => {
		const workDirs: string[] = [];
		try {
			const raw = (await c.req.json()) as Partial<SubtitleFilesJobRequest>;
			if (!Array.isArray(raw.pairs) || !raw.pairs.length) throw new Error("Pair at least one video with a subtitle file");
			if (raw.pairs.length > MAX_PAIRS) throw new Error(`At most ${MAX_PAIRS} videos can be queued at once`);
			const language = typeof raw.language === "string" ? raw.language.trim() : "";
			if (!resolveTranslateLang(language)) throw new Error("Choose the language of the subtitles");
			const credit = typeof raw.credit === "string" ? raw.credit.replace(/[[\]]/g, "").trim().slice(0, 60) : "";
			if (!Array.isArray(raw.fonts) || raw.fonts.length > MAX_FONTS) throw new Error("Invalid font list");
			const fontPaths = [...new Set(raw.fonts.map((path) => resolveFont(path, config)))];
			const fonts = (await Promise.all(fontPaths.map((path) => readFontSource(path, c.req.signal)))).filter((f): f is SubtitleFileFontSource => !!f);

			const pairs = raw.pairs.map((pair) => ({
				targetPath: resolveAllowedMkv(pair?.targetPath, config, "Video"),
				subtitlePath: resolveAllowedFile(pair?.sourcePath, config, SUBTITLE_FILE_EXTS, "Subtitle file"),
			}));
			if (new Set(pairs.map((p) => p.targetPath)).size !== pairs.length) throw new Error("A video is paired more than once");
			const busy = new Set(
				getAllJobs()
					.filter((job) => !["done", "error", "cancelled"].includes(job.status))
					.flatMap((job) => [job.inputPath, job.repairPlan?.targetPath]),
			);
			const queued = pairs.find((p) => busy.has(p.targetPath));
			if (queued) throw new Error(`${queued.targetPath.split("/").at(-1)} already has a job waiting. Let it finish first.`);

			const plans = pairs.map((pair) => {
				const workDir = join(config.tempDir, "subtitle-add", randomUUID());
				workDirs.push(workDir);
				return buildSubtitleFilePlan({ ...pair, language, credit, fonts, settings: config.defaults, workDir });
			});
			const jobIds = plans.map((plan) => addSubtitleAddJob(plan).id);
			return c.json({ jobIds }, 201);
		} catch (error: any) {
			for (const dir of workDirs) rmSync(dir, { recursive: true, force: true });
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});
}
