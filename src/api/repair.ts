import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from "fs";
import { randomUUID } from "crypto";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "path";
import type { Web } from "@rabbit-company/web";
import type { AppConfig, RepairAuditGroupEdit, RepairPlan } from "../core/types";
import {
	buildRepairAuditGroupPlans,
	buildSourceReplacementPlan,
	groupRepairAuditFiles,
	inspectRepairAuditFile,
	inspectRepairFile,
	sanitizeRepairPlan,
} from "../pipeline/repair";
import { addRepairJob, getAllJobs, getJob } from "../queue/store";
import { browseFolder } from "../queue/library";

function isInside(path: string, root: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function allowedRoots(config: AppConfig): string[] {
	return [config.inputDir, config.outputDir, ...config.libraryDirs].filter((root) => existsSync(root)).map((root) => realpathSync(root));
}

export function resolveAllowedMkv(raw: unknown, config: AppConfig, label: string): string {
	if (typeof raw !== "string" || !raw.trim()) throw new Error(`${label} path is required`);
	const candidate = resolve(raw.trim());
	if (!existsSync(candidate) || !statSync(candidate).isFile()) throw new Error(`${label} file does not exist`);
	const real = realpathSync(candidate);
	if (!allowedRoots(config).some((root) => isInside(real, root))) throw new Error(`${label} must be inside an input, output, or configured library directory`);
	if (extname(real).toLowerCase() !== ".mkv") throw new Error(`${label} must be an MKV file`);
	return real;
}

function resolveAllowedDirectory(raw: unknown, config: AppConfig): string {
	if (typeof raw !== "string" || !raw.trim()) throw new Error("Folder path is required");
	const candidate = resolve(raw.trim());
	if (!existsSync(candidate) || !statSync(candidate).isDirectory()) throw new Error("Folder does not exist");
	const real = realpathSync(candidate);
	if (!allowedRoots(config).some((root) => isInside(real, root))) throw new Error("Folder is outside Rabbit's configured media directories");
	return real;
}

function repairRoots(config: AppConfig): { path: string; name: string }[] {
	const candidates = [
		{ path: config.inputDir, name: `Input: ${basename(config.inputDir) || config.inputDir}` },
		{ path: config.outputDir, name: `Output: ${basename(config.outputDir) || config.outputDir}` },
		...config.libraryDirs.map((path) => ({ path, name: `Library: ${basename(path) || path}` })),
	];
	const seen = new Set<string>();
	return candidates.flatMap((candidate) => {
		if (!existsSync(candidate.path) || !statSync(candidate.path).isDirectory()) return [];
		const path = realpathSync(candidate.path);
		if (seen.has(path)) return [];
		seen.add(path);
		return [{ path, name: candidate.name }];
	});
}

function outputPathForJob(jobId: string, config: AppConfig): { targetPath: string; sourcePath?: string } {
	const job = getJob(jobId);
	if (!job) throw new Error("Job not found");
	let targetPath: string;
	if (job.kind === "repair" && job.outputFilename) {
		targetPath = job.outputFilename;
	} else if (job.status === "done" && job.outputFilename) {
		targetPath = job.replaceSource ? join(dirname(job.inputPath), basename(job.outputFilename)) : join(config.outputDir, job.outputFilename);
	} else {
		targetPath = job.inputPath;
	}
	return { targetPath, sourcePath: existsSync(job.inputPath) && resolve(job.inputPath) !== resolve(targetPath) ? job.inputPath : undefined };
}

async function inspectAuditPaths(inputs: { path: string; sourcePath?: string }[], folderPath: string | undefined, signal?: AbortSignal) {
	if (inputs.length > 500) throw new Error("A folder audit may contain at most 500 MKV files");
	const files = [];
	for (let offset = 0; offset < inputs.length; offset += 8) {
		files.push(
			...(await Promise.all(
				inputs.slice(offset, offset + 8).map(async (input) => ({ ...(await inspectRepairAuditFile(input.path, signal)), sourcePath: input.sourcePath })),
			)),
		);
	}
	return groupRepairAuditFiles(files, folderPath);
}

export function registerRepairRoutes(app: Web, config: AppConfig): void {
	app.get("/api/repair/roots", (c) => c.json({ roots: repairRoots(config) }));

	app.get("/api/repair/browse", (c) => {
		try {
			const path = resolveAllowedDirectory(c.query().get("path"), config);
			const entries = browseFolder(path, config.organization).filter((entry) => entry.type === "directory" || extname(entry.name).toLowerCase() === ".mkv");
			return c.json({ path, entries });
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});

	app.get("/api/repair/inspect", async (c) => {
		try {
			const query = c.query();
			const fromJob = query.get("jobId") ? outputPathForJob(query.get("jobId")!, config) : undefined;
			const targetPath = resolveAllowedMkv(query.get("targetPath") || fromJob?.targetPath, config, "Encoded target");
			const rawSource = query.get("sourcePath") || fromJob?.sourcePath;
			const sourcePath = rawSource ? resolveAllowedMkv(rawSource, config, "Subtitle source") : undefined;
			const [target, source] = await Promise.all([
				inspectRepairFile(targetPath, c.req.signal),
				sourcePath ? inspectRepairFile(sourcePath, c.req.signal) : undefined,
			]);
			return c.json({ target, source });
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});

	app.post("/api/repair/audit", async (c) => {
		try {
			const raw = (await c.req.json()) as { path?: unknown; jobIds?: unknown };
			let folderPath: string | undefined;
			let inputs: { path: string; sourcePath?: string }[];
			if (typeof raw.path === "string" && raw.path.trim()) {
				folderPath = resolveAllowedDirectory(raw.path, config);
				inputs = readdirSync(folderPath, { withFileTypes: true })
					.filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".mkv")
					.map((entry) => ({ path: resolveAllowedMkv(join(folderPath!, entry.name), config, "Audit file") }))
					.sort((a, b) => basename(a.path).localeCompare(basename(b.path), undefined, { numeric: true }));
			} else if (Array.isArray(raw.jobIds)) {
				const seen = new Set<string>();
				inputs = raw.jobIds.flatMap((value) => {
					if (typeof value !== "string") return [];
					const job = getJob(value);
					if (!job || job.status !== "done") return [];
					const resolved = outputPathForJob(value, config);
					const path = resolveAllowedMkv(resolved.targetPath, config, "Completed output");
					if (seen.has(path)) return [];
					seen.add(path);
					const sourcePath =
						resolved.sourcePath && existsSync(resolved.sourcePath) ? resolveAllowedMkv(resolved.sourcePath, config, "Original source") : undefined;
					return [{ path, sourcePath }];
				});
			} else {
				throw new Error("Choose a folder or a completed encoding folder to audit");
			}
			return c.json(await inspectAuditPaths(inputs, folderPath, c.req.signal));
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});

	app.post("/api/repair/audit/group", async (c) => {
		try {
			const raw = (await c.req.json()) as RepairAuditGroupEdit;
			if (!Array.isArray(raw?.paths) || !raw.paths.length || raw.paths.length > 500) throw new Error("Choose between 1 and 500 group files");
			const paths = raw.paths.map((path) => resolveAllowedMkv(path, config, "Group file"));
			if (new Set(paths).size !== paths.length) throw new Error("Group files must not contain duplicate paths");
			const inspected = await inspectAuditPaths(
				paths.map((path) => ({ path })),
				undefined,
				c.req.signal,
			);
			const plans = buildRepairAuditGroupPlans(inspected.files, raw);
			const busy = getAllJobs().find((job) => paths.includes(job.inputPath) && !["done", "error", "cancelled"].includes(job.status));
			if (busy) throw new Error(`${basename(busy.inputPath)} already has an unfinished job. Finish or remove it before editing this group.`);
			const cancelledRepair = getAllJobs().find((job) => job.kind === "repair" && paths.includes(job.inputPath) && job.status === "cancelled");
			if (cancelledRepair) throw new Error(`${basename(cancelledRepair.inputPath)} has a cancelled repair. Remove it before editing this group.`);
			if (c.req.signal.aborted) throw new Error("Group edit request was cancelled");
			const jobs = plans.map((plan) => addRepairJob(plan));
			return c.json({ jobIds: jobs.map((job) => job.id) }, 201);
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});

	app.post("/api/repair/replace-plan", async (c) => {
		const workDir = join(config.tempDir, `repair-plan-${randomUUID()}`);
		try {
			const raw = (await c.req.json()) as { targetPath?: unknown; sourcePath?: unknown; replaceTarget?: unknown };
			const targetPath = resolveAllowedMkv(raw.targetPath, config, "Encoded target");
			const sourcePath = resolveAllowedMkv(raw.sourcePath, config, "Subtitle source");
			mkdirSync(workDir, { recursive: true });
			const plan = await buildSourceReplacementPlan({
				targetPath,
				sourcePath,
				settings: config.defaults,
				tempDir: workDir,
				replaceTarget: raw.replaceTarget !== false,
				signal: c.req.signal,
			});
			return c.json(plan);
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		} finally {
			try {
				rmSync(workDir, { recursive: true, force: true });
			} catch {}
		}
	});

	app.post("/api/repair/jobs", async (c) => {
		try {
			const raw = (await c.req.json()) as RepairPlan;
			const normalized = sanitizeRepairPlan(raw);
			normalized.targetPath = resolveAllowedMkv(normalized.targetPath, config, "Encoded target");
			if (normalized.sourcePath) normalized.sourcePath = resolveAllowedMkv(normalized.sourcePath, config, "Subtitle source");
			const job = addRepairJob(normalized);
			return c.json(job, 201);
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});
}
