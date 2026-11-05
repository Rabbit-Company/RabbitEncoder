import { mkdirSync, rmSync } from "fs";
import { randomUUID } from "crypto";
import { join } from "path";
import type { Web } from "@rabbit-company/web";
import type { AppConfig, FontCheckJobRequest, FontCheckProgress, SubtitleFileFontSource } from "../core/types";
import { Logger } from "../core/logger";
import { CancelledError } from "../core/process";
import { buildFontCheckPlans, checkFolderFonts, type FontCheckUpload } from "../pipeline/font-check";
import { fontRegistry } from "../fonts/fonts";
import { readFontSource } from "../pipeline/subtitle-files";
import { normalizeFontName } from "../subtitles/ass-classifier";
import { addRepairJob, getAllJobs } from "../queue/store";
import { mkvFiles } from "./hdr";
import { resolveAllowedDirectory } from "./repair";
import { resolveFont } from "./subtitle-files";

const TTL_MS = 6 * 3_600_000;
const MAX_SCANS = 10;

interface Scan extends FontCheckProgress {
	controller: AbortController;
	startedAt: number;
}

const scans = new Map<string, Scan>();

function prune(): void {
	const now = Date.now();
	for (const [id, scan] of scans) if (now - scan.startedAt > TTL_MS) scans.delete(id);
	while (scans.size >= MAX_SCANS) {
		const oldest = [...scans.values()].sort((a, b) => a.startedAt - b.startedAt)[0]!;
		oldest.controller.abort();
		scans.delete(oldest.id);
	}
}

const view = ({ controller, startedAt, ...progress }: Scan): FontCheckProgress => progress;

export function registerFontCheckRoutes(app: Web, config: AppConfig): void {
	/** Starts reading the subtitles of every MKV in a folder for fonts they use but do not carry. */
	app.post("/api/font-check/scan", async (c) => {
		try {
			const raw = (await c.req.json()) as { folder?: unknown; recursive?: unknown };
			const folder = resolveAllowedDirectory(raw.folder, config);
			const paths = mkvFiles(folder, raw.recursive === true);
			if (!paths.length) throw new Error("The folder has no MKV files");
			prune();
			const id = randomUUID();
			const scan: Scan = { id, done: 0, total: paths.length, current: "", controller: new AbortController(), startedAt: Date.now() };
			scans.set(id, scan);
			const tempDir = join(config.tempDir, `font-check-${id}`);
			mkdirSync(tempDir, { recursive: true });
			void checkFolderFonts(folder, paths, tempDir, (done, current) => Object.assign(scan, { done, current }), scan.controller.signal)
				.then((result) => (scan.result = result))
				.catch((error) => {
					scan.error = error instanceof CancelledError ? "The font check was cancelled" : error instanceof Error ? error.message : String(error);
					if (!(error instanceof CancelledError)) Logger.error(`[fonts] Font check of ${folder} failed: ${scan.error}`);
				})
				.finally(() => rmSync(tempDir, { recursive: true, force: true }));
			return c.json(view(scan), 201);
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});

	app.get("/api/font-check/scan/:id", (c) => {
		const scan = scans.get(c.params.id!);
		if (!scan) return c.json({ error: "The font check has expired. Check the folder again." }, 404);
		return c.json(view(scan));
	});

	app.delete("/api/font-check/scan/:id", (c) => {
		const scan = scans.get(c.params.id!);
		scan?.controller.abort();
		scans.delete(c.params.id!);
		return c.json({ ok: true });
	});

	/** One repair per video a fix reaches: uploaded fonts attached, mapped fonts pointed at fonts the video carries. */
	app.post("/api/font-check/jobs", async (c) => {
		let workRoot = "";
		try {
			const raw = (await c.req.json()) as Partial<FontCheckJobRequest>;
			const result = typeof raw.scanId === "string" ? scans.get(raw.scanId)?.result : undefined;
			if (!result) throw new Error("The font check has expired. Check the folder again.");
			const requested = raw.library ?? [];
			if (!Array.isArray(raw.uploads) || !Array.isArray(raw.maps) || !Array.isArray(requested) || raw.uploads.length + raw.maps.length + requested.length > 300)
				throw new Error("Invalid font fixes");
			const keys = new Set(result.missing.map((m) => m.key));
			const uploads: FontCheckUpload[] = [];
			for (const upload of raw.uploads) {
				if (!keys.has(upload?.key)) throw new Error("A fix names a font the check did not find missing");
				const font = await readFontSource(resolveFont(upload.path, config), c.req.signal);
				if (!font) throw new Error("An uploaded font could not be read, upload it again");
				uploads.push({ ...font, key: upload.key });
			}
			const maps = raw.maps.map((map) => {
				const to = typeof map?.to === "string" ? map.to.trim() : "";
				if (!keys.has(map?.key) || !to || /[,\\{}]/.test(to)) throw new Error("Invalid font mapping");
				if (normalizeFontName(to) === map.key) throw new Error("A font cannot be mapped to itself");
				return { key: map.key, to };
			});
			const faces = fontRegistry.list().flatMap((group) => group.faces);
			const libraryFamily = (family: string) => faces.filter((face) => normalizeFontName(face.family) === normalizeFontName(family));
			const library = requested.map((entry) => {
				const family = typeof entry?.family === "string" ? entry.family : "";
				if (!keys.has(entry?.key) || !family) throw new Error("Invalid library font");
				if (!libraryFamily(family).some((face) => face.names.includes(entry.key))) throw new Error(`The library has no font named "${entry.key}" in ${family}`);
				return { key: entry.key, family };
			});
			if (!uploads.length && !maps.length && !library.length) throw new Error("Choose a fix for at least one font");
			const wanted = new Set([...library.map((l) => l.family), ...maps.map((m) => m.to)].map(normalizeFontName));
			const libraryFonts: SubtitleFileFontSource[] = faces
				.filter((face) => wanted.has(normalizeFontName(face.family)))
				.map(({ path, fileName, family, names }) => ({ path, fileName, family, names }));

			workRoot = join(config.tempDir, "font-fix", randomUUID());
			const { plans, unreachable } = buildFontCheckPlans(
				result,
				{ maps, library, replaceTarget: raw.replaceTarget !== false },
				uploads,
				workRoot,
				libraryFonts,
			);
			if (!plans.length) throw new Error("None of the videos can be fixed with these choices");
			const busy = new Set(
				getAllJobs()
					.filter((job) => !["done", "error", "cancelled"].includes(job.status))
					.flatMap((job) => [job.inputPath, job.repairPlan?.targetPath]),
			);
			const queued = plans.find((plan) => busy.has(plan.targetPath));
			if (queued) throw new Error(`${queued.targetPath.split("/").at(-1)} already has a job waiting. Let it finish first.`);
			const jobIds = plans.map((plan) => addRepairJob(plan).id);
			return c.json({ jobIds, unreachable }, 201);
		} catch (error: any) {
			if (workRoot) rmSync(workRoot, { recursive: true, force: true });
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});
}
