import type { Web } from "@rabbit-company/web";
import { existsSync, realpathSync, statSync } from "fs";
import { basename, resolve } from "path";
import { FILM_GRAIN_RANGES, FILM_GRAIN_SAMPLINGS, type AppConfig, type FilmGrainRange, type FilmGrainSampling } from "../core/types";
import { browseFolder, isAlreadyEncoded, isPathAllowed, listMediaFiles } from "../queue/library";
import { Logger } from "../core/logger";
import { getAllJobs, scanLibraryPath } from "../queue/store";
import { resolveAllowedDirectory, resolveAllowedMediaFile } from "./repair";
import { pairOriginalSources } from "../video/source-pairing";

function selectedTargets(rawPaths: unknown, config: AppConfig): { paths: string[]; files: string[] } {
	if (!Array.isArray(rawPaths) || rawPaths.length === 0 || rawPaths.length > 100 || rawPaths.some((path) => typeof path !== "string"))
		throw new Error("Choose 1 to 100 library files or folders");
	const paths = rawPaths.map((path: string) => resolve(path));
	for (const path of paths) {
		if (!existsSync(path)) throw new Error(`Path does not exist: ${path}`);
		const real = realpathSync(path);
		const roots = config.libraryDirs.filter((root) => existsSync(root)).map((root) => realpathSync(root));
		if (!isPathAllowed(real, roots)) throw new Error(`Path is outside configured library directories: ${path}`);
	}
	const files = [...new Set(paths.flatMap(listMediaFiles))];
	if (files.length > 500) throw new Error("Select at most 500 videos at once");
	return { paths, files };
}

export function registerLibraryRoutes(app: Web, config: AppConfig): void {
	app.get("/api/library", (c) => {
		return c.json({
			dirs: config.libraryDirs.map((dir) => ({
				path: dir,
				name: dir.split("/").filter(Boolean).pop() || dir,
			})),
		});
	});

	app.get("/api/library/browse", (c) => {
		const path = c.query().get("path");
		if (!path) {
			return c.json({ error: "Missing 'path' query parameter" }, 400);
		}

		if (!isPathAllowed(path, config.libraryDirs)) {
			return c.json({ error: "Path is not within any configured library directory" }, 403);
		}

		const entries = browseFolder(path, config.organization);
		return c.json({ path, entries });
	});

	app.post("/api/library/encode", async (c) => {
		let body: { paths?: unknown; path?: unknown; sourceMap?: unknown; autoFilmGrain?: unknown; filmGrainSampling?: unknown; filmGrainRange?: unknown };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid request body" }, 400);
		}
		let paths: string[];
		let files: string[];
		const sourceMap: Record<string, string> = {};
		try {
			({ paths, files } = selectedTargets(body.paths ?? (body.path ? [body.path] : []), config));
			if (body.autoFilmGrain !== undefined && typeof body.autoFilmGrain !== "boolean") throw new Error("autoFilmGrain must be a boolean");
			if (body.filmGrainSampling !== undefined && !FILM_GRAIN_SAMPLINGS.includes(body.filmGrainSampling as FilmGrainSampling))
				throw new Error("filmGrainSampling must be all, half, or quarter");
			if (body.filmGrainRange !== undefined && !FILM_GRAIN_RANGES.includes(body.filmGrainRange as FilmGrainRange))
				throw new Error("filmGrainRange must be representative or full");
			if (body.sourceMap !== undefined) {
				if (!body.sourceMap || typeof body.sourceMap !== "object" || Array.isArray(body.sourceMap)) throw new Error("sourceMap must be an object");
				const selected = new Set(files);
				const usedSources = new Set<string>();
				for (const [target, rawSource] of Object.entries(body.sourceMap)) {
					if (!selected.has(target)) throw new Error(`Source mapping target was not selected: ${target}`);
					if (!rawSource) continue;
					const source = resolveAllowedMediaFile(rawSource, config, "Original source");
					if (source === realpathSync(target)) throw new Error(`Original source and encode input are the same file: ${target}`);
					if (usedSources.has(source)) throw new Error(`Original source is mapped more than once: ${source}`);
					usedSources.add(source);
					sourceMap[target] = source;
				}
			}
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
		}

		let totalAdded = 0;
		let totalSkipped = 0;
		let totalAlreadyEncoded = 0;

		for (const p of paths) {
			Logger.info(`[library] Encoding: ${p}`);
			const result = scanLibraryPath(
				p,
				sourceMap,
				body.autoFilmGrain === true,
				body.filmGrainSampling as FilmGrainSampling | undefined,
				body.filmGrainRange as FilmGrainRange | undefined,
			);
			totalAdded += result.added;
			totalSkipped += result.skipped;
			totalAlreadyEncoded += result.alreadyEncoded;
		}

		Logger.info(`[library] Queued ${totalAdded} files (${totalSkipped} already queued, ${totalAlreadyEncoded} already encoded)`);
		return c.json({ ok: true, added: totalAdded, skipped: totalSkipped, alreadyEncoded: totalAlreadyEncoded });
	});

	app.post("/api/library/source-pairs", async (c) => {
		let body: { paths?: unknown; sourcePath?: unknown };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid request body" }, 400);
		}
		try {
			const { files } = selectedTargets(body.paths, config);
			const activeInputs = new Set(
				getAllJobs()
					.filter((job) => job.status !== "done" && job.status !== "error")
					.map((job) => job.inputPath),
			);
			const targets = files.filter(
				(path) => !activeInputs.has(path) && (config.defaults.subtitleProcessing === "translate" || !isAlreadyEncoded(basename(path), config.organization)),
			);
			if (!targets.length) throw new Error("No new videos in the selection");
			if (typeof body.sourcePath !== "string" || !body.sourcePath.trim()) throw new Error("Choose an original file or folder");
			const sourceSelection = resolve(body.sourcePath);
			if (!existsSync(sourceSelection)) throw new Error("Original file or folder does not exist");
			const sources = statSync(sourceSelection).isDirectory()
				? listMediaFiles(resolveAllowedDirectory(sourceSelection, config)).map((path) => resolveAllowedMediaFile(path, config, "Original source"))
				: [resolveAllowedMediaFile(sourceSelection, config, "Original source")];
			if (sources.length > 500) throw new Error("Select a source folder with at most 500 videos");
			if (!sources.length) throw new Error("Original folder contains no video files");
			const pairs = pairOriginalSources(targets, sources).map((pair) => ({
				...pair,
				...(pair.sourcePath && realpathSync(pair.targetPath) === pair.sourcePath ? { sourcePath: "", method: "none" as const } : {}),
				targetName: basename(pair.targetPath),
				sourceName: pair.sourcePath ? basename(pair.sourcePath) : "",
			}));
			return c.json({ pairs, sources: [...new Set(sources)].map((path) => ({ path, name: basename(path) })) });
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
		}
	});
}
