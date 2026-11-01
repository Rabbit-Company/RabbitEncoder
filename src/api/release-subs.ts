import type { Web } from "@rabbit-company/web";
import { basename } from "path";
import { mapPool } from "../core/concurrency";
import type { AppConfig, RepairInspectionFile, RepairPlan } from "../core/types";
import { inspectRepairFile } from "../pipeline/repair";
import { alignmentProblem, describeTiming } from "../pipeline/repair-timing";
import {
	buildReleaseRepairPlan,
	mkvFilesIn,
	planReleaseSubtitles,
	scanReleaseSubtitles,
	type ReleaseFolder,
	type ReleaseSubsOptions,
} from "../pipeline/release-subs";
import { addRepairJob, getAllJobs } from "../queue/store";
import { cleanPreferredSources } from "../subsearch/naming";
import { alignReleaseFiles } from "../sync/release-align";
import { resolveAllowedDirectory, resolveAllowedMkv } from "./repair";

const MAX_FILES = 500;
const MAX_SOURCE_DIRS = 10;
const MAX_ROW_SOURCES = 10;

function planOptions(config: AppConfig, raw: { preferredSources?: unknown; replaceWorse?: unknown }): ReleaseSubsOptions {
	const defaults = config.defaults;
	return {
		preferredSources: Array.isArray(raw.preferredSources)
			? cleanPreferredSources(raw.preferredSources)
			: cleanPreferredSources(defaults.subtitleDownloadPreferredSources),
		formatPriority: defaults.subtitleFormatPriority,
		renameTracks: defaults.renameSubtitleTracks,
		languagePriority: defaults.subtitleLanguagePriority,
		replaceWorse: raw.replaceWorse === true,
	};
}

function resolveSources(raw: unknown, config: AppConfig): string[] {
	if (!Array.isArray(raw)) throw new Error("Each episode needs its list of releases");
	if (raw.length > MAX_ROW_SOURCES) throw new Error(`An episode can take subtitles from at most ${MAX_ROW_SOURCES} releases`);
	return [...new Set(raw.map((path) => resolveAllowedMkv(path, config, "Release")))];
}

/** Choices per cell from the grid: a source track, or null to leave the cell as the encode has it. */
function resolveChoices(raw: unknown, sources: string[], config: AppConfig): NonNullable<ReleaseSubsOptions["choices"]> {
	if (raw === undefined) return {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid subtitle choices");
	const out: NonNullable<ReleaseSubsOptions["choices"]> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(0, 500)) {
		if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,4})?:[a-z]+$/.test(key)) throw new Error(`Invalid subtitle choice ${key.slice(0, 40)}`);
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

export function registerReleaseSubtitleRoutes(app: Web, config: AppConfig): void {
	app.post("/api/release-subs/scan", async (c) => {
		try {
			const raw = (await c.req.json()) as { targets?: unknown; targetDir?: unknown; sourceDirs?: unknown; preferredSources?: unknown; replaceWorse?: unknown };
			const targets = Array.isArray(raw.targets)
				? raw.targets.map((path) => resolveAllowedMkv(path, config, "Encoded target"))
				: mkvFilesIn(resolveAllowedDirectory(raw.targetDir, config));
			if (!targets.length) throw new Error("Choose at least one encoded MKV");
			if (!Array.isArray(raw.sourceDirs) || !raw.sourceDirs.length) throw new Error("Choose at least one folder of other releases");
			if (raw.sourceDirs.length > MAX_SOURCE_DIRS) throw new Error(`Choose at most ${MAX_SOURCE_DIRS} folders of other releases`);
			const seen = new Set<string>();
			const sourceDirs: ReleaseFolder[] = [];
			for (const item of raw.sourceDirs as unknown[]) {
				const folder = typeof item === "string" ? { path: item } : (item as { path?: unknown; offset?: unknown });
				const path = resolveAllowedDirectory(folder?.path, config);
				if (seen.has(path)) continue;
				seen.add(path);
				const offset = folder.offset === undefined || folder.offset === null || folder.offset === "" ? undefined : Number(folder.offset);
				if (offset !== undefined && (!Number.isInteger(offset) || offset < 1 || offset > 5000))
					throw new Error("A numbering offset must be a whole number from 1 to 5000");
				sourceDirs.push({ path, ...(offset !== undefined ? { offset } : {}) });
			}
			if (targets.length > MAX_FILES || sourceDirs.some((dir) => mkvFilesIn(dir.path).length > MAX_FILES))
				throw new Error(`Copying subtitles from releases is limited to ${MAX_FILES} files per folder`);
			const scan = await scanReleaseSubtitles({ targets: [...new Set(targets)], sourceDirs, options: planOptions(config, raw), signal: c.req.signal });
			return c.json(scan);
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});

	// Decodes the audio of every file, so it is asked for one episode at a time.
	app.post("/api/release-subs/check", async (c) => {
		try {
			const raw = (await c.req.json()) as { targetPath?: unknown; sourcePaths?: unknown };
			const targetPath = resolveAllowedMkv(raw.targetPath, config, "Encoded target");
			const sources = resolveSources(raw.sourcePaths, config);
			const results = [];
			for (const sourcePath of sources) {
				const alignment = await alignReleaseFiles(targetPath, sourcePath, { cacheDir: config.tempDir, signal: c.req.signal });
				const problem = alignmentProblem(alignment);
				results.push({
					sourcePath,
					matched: !problem,
					coveredShare: alignment.coveredShare,
					detail: problem ?? `${describeTiming(alignment.map, alignment.removed)}, ${Math.round(alignment.coveredShare * 100)}% matched`,
				});
			}
			return c.json({ results });
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});

	app.post("/api/release-subs/jobs", async (c) => {
		try {
			const raw = (await c.req.json()) as { rows?: unknown; replaceTarget?: unknown; preferredSources?: unknown; replaceWorse?: unknown };
			if (!Array.isArray(raw.rows) || !raw.rows.length) throw new Error("Choose at least one episode");
			if (raw.rows.length > MAX_FILES) throw new Error(`Copying subtitles from releases is limited to ${MAX_FILES} episodes`);
			const options = planOptions(config, raw);
			const rows = raw.rows.map((row: any) => {
				const targetPath = resolveAllowedMkv(row?.targetPath, config, "Encoded target");
				const sourcePaths = resolveSources(row?.sourcePaths, config);
				return { targetPath, sourcePaths, choices: resolveChoices(row?.choices, sourcePaths, config) };
			});
			const targets = rows.map((row) => row.targetPath);
			if (new Set(targets).size !== targets.length) throw new Error("The same encode was chosen more than once");
			const busy = getAllJobs().find((job) => targets.includes(job.inputPath) && !["done", "error", "cancelled"].includes(job.status));
			if (busy) throw new Error(`${basename(busy.inputPath)} already has an unfinished job. Finish or remove it first.`);

			// Read again, so the jobs follow the files as they are now, not as they were scanned.
			const files = [...new Set(rows.flatMap((row) => [row.targetPath, ...row.sourcePaths]))];
			const inspected = new Map<string, RepairInspectionFile>();
			await mapPool(files, 4, async (path) => {
				inspected.set(path, await inspectRepairFile(path, c.req.signal));
			});
			const plans: RepairPlan[] = [];
			for (const row of rows) {
				const target = inspected.get(row.targetPath)!;
				const planned = planReleaseSubtitles(
					target,
					row.sourcePaths.map((path) => inspected.get(path)!),
					{ ...options, choices: row.choices },
				);
				const plan = buildReleaseRepairPlan(target, planned, {
					replaceTarget: raw.replaceTarget !== false,
					languagePriority: config.defaults.subtitleLanguagePriority,
					formatPriority: config.defaults.subtitleFormatPriority,
					compression: config.defaults.compressSubtitles ? "auto" : "none",
				});
				if (plan) plans.push(plan);
			}
			const jobs = plans.map((plan) => addRepairJob(plan));
			return c.json({ jobIds: jobs.map((job) => job.id), unchanged: rows.length - plans.length }, 201);
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});
}
