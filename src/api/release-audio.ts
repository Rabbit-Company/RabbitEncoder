import type { Web } from "@rabbit-company/web";
import { basename } from "path";
import { mapPool } from "../core/concurrency";
import type { AppConfig, ReleaseAudioPlan } from "../core/types";
import {
	buildReleaseAudioPlan,
	inspectReleaseAudioFile,
	planReleaseAudio,
	releaseAudioDefaults,
	scanReleaseAudio,
	type ReleaseAudioFile,
	type ReleaseAudioOptions,
} from "../pipeline/release-audio";
import { mkvFilesIn, type ReleaseFolder } from "../pipeline/release-subs";
import { addAudioJob, getAllJobs } from "../queue/store";
import { resolveAllowedDirectory, resolveAllowedMkv } from "./repair";

const MAX_FILES = 500;
const MAX_SOURCE_DIRS = 10;
const MAX_ROW_SOURCES = 10;

function resolveSources(raw: unknown, config: AppConfig): string[] {
	if (!Array.isArray(raw)) throw new Error("Each episode needs its list of releases");
	if (raw.length > MAX_ROW_SOURCES) throw new Error(`An episode can take audio from at most ${MAX_ROW_SOURCES} releases`);
	return [...new Set(raw.map((path) => resolveAllowedMkv(path, config, "Release")))];
}

function resolveFolders(raw: unknown, config: AppConfig): ReleaseFolder[] {
	if (!Array.isArray(raw) || !raw.length) throw new Error("Choose at least one folder of other releases");
	if (raw.length > MAX_SOURCE_DIRS) throw new Error(`Choose at most ${MAX_SOURCE_DIRS} folders of other releases`);
	const seen = new Set<string>();
	const folders: ReleaseFolder[] = [];
	for (const item of raw as unknown[]) {
		const folder = typeof item === "string" ? { path: item } : (item as { path?: unknown; offset?: unknown });
		const path = resolveAllowedDirectory(folder?.path, config);
		if (seen.has(path)) continue;
		seen.add(path);
		const offset = folder.offset === undefined || folder.offset === null || folder.offset === "" ? undefined : Number(folder.offset);
		if (offset !== undefined && (!Number.isInteger(offset) || offset < 1 || offset > 5000))
			throw new Error("A numbering offset must be a whole number from 1 to 5000");
		folders.push({ path, ...(offset !== undefined ? { offset } : {}) });
	}
	return folders;
}

/** Choices per cell from the grid: a source track, or null to leave the cell as the video has it. */
function resolveChoices(raw: unknown, sources: string[], config: AppConfig): NonNullable<ReleaseAudioOptions["choices"]> {
	if (raw === undefined) return {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid audio choices");
	const out: NonNullable<ReleaseAudioOptions["choices"]> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(0, 500)) {
		if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,4})?:[a-z]+$/.test(key)) throw new Error(`Invalid audio choice ${key.slice(0, 40)}`);
		if (value === null) {
			out[key] = null;
			continue;
		}
		const choice = value as { sourcePath?: unknown; trackId?: unknown };
		const sourcePath = resolveAllowedMkv(choice?.sourcePath, config, "Release");
		const trackId = Number(choice?.trackId);
		if (!sources.includes(sourcePath) || !Number.isInteger(trackId) || trackId < 0)
			throw new Error(`The choice for ${key} names a release the episode was not paired with`);
		out[key] = { sourcePath, trackId };
	}
	return out;
}

export function registerReleaseAudioRoutes(app: Web, config: AppConfig): void {
	app.post("/api/release-audio/scan", async (c) => {
		try {
			const raw = (await c.req.json()) as { targets?: unknown; targetDir?: unknown; sourceDirs?: unknown };
			const targets = Array.isArray(raw.targets)
				? raw.targets.map((path) => resolveAllowedMkv(path, config, "Video"))
				: mkvFilesIn(resolveAllowedDirectory(raw.targetDir, config));
			if (!targets.length) throw new Error("Choose at least one MKV");
			const sourceDirs = resolveFolders(raw.sourceDirs, config);
			if (targets.length > MAX_FILES || sourceDirs.some((dir) => mkvFilesIn(dir.path).length > MAX_FILES))
				throw new Error(`Copying audio from releases is limited to ${MAX_FILES} files per folder`);
			const scan = await scanReleaseAudio({
				targets: [...new Set(targets)],
				sourceDirs,
				options: releaseAudioDefaults(config.defaults),
				signal: c.req.signal,
			});
			return c.json(scan);
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});

	app.post("/api/release-audio/jobs", async (c) => {
		try {
			const raw = (await c.req.json()) as { rows?: unknown; replaceTarget?: unknown; applySettings?: unknown };
			if (!Array.isArray(raw.rows) || !raw.rows.length) throw new Error("Choose at least one episode");
			if (raw.rows.length > MAX_FILES) throw new Error(`Copying audio from releases is limited to ${MAX_FILES} episodes`);
			const rows = raw.rows.map((row: any) => {
				const targetPath = resolveAllowedMkv(row?.targetPath, config, "Video");
				const sourcePaths = resolveSources(row?.sourcePaths, config);
				return { targetPath, sourcePaths, choices: resolveChoices(row?.choices, sourcePaths, config) };
			});
			const targets = rows.map((row) => row.targetPath);
			if (new Set(targets).size !== targets.length) throw new Error("The same video was chosen more than once");
			const busy = getAllJobs().find((job) => targets.includes(job.inputPath) && !["done", "error", "cancelled"].includes(job.status));
			if (busy) throw new Error(`${basename(busy.inputPath)} already has an unfinished job. Finish or remove it first.`);

			// Read again, so the jobs follow the files as they are now, not as they were scanned.
			const files = [...new Set(rows.flatMap((row) => [row.targetPath, ...row.sourcePaths]))];
			const inspected = new Map<string, ReleaseAudioFile>();
			await mapPool(files, 4, async (path) => {
				inspected.set(path, await inspectReleaseAudioFile(path, c.req.signal));
			});
			const applySettings = raw.applySettings === true;
			const defaults = releaseAudioDefaults(config.defaults, applySettings);
			const plans: ReleaseAudioPlan[] = [];
			for (const row of rows) {
				const planned = planReleaseAudio(
					inspected.get(row.targetPath)!,
					row.sourcePaths.map((path) => inspected.get(path)!),
					{ ...defaults, choices: row.choices },
				);
				const plan = buildReleaseAudioPlan(planned, raw.replaceTarget !== false, applySettings);
				if (plan) plans.push(plan);
			}
			const jobs = plans.map((plan) => addAudioJob(plan));
			return c.json({ jobIds: jobs.map((job) => job.id), unchanged: rows.length - plans.length }, 201);
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});
}
