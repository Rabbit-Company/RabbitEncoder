import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { extname, join, resolve } from "path";
import type { Web } from "@rabbit-company/web";
import type { AppConfig, HdrPlan } from "../core/types";
import { inspectHdrFile, sanitizeHdrPlan } from "../pipeline/hdr-tool";
import { addHdrJob } from "../queue/store";
import { resolveAllowedDirectory, resolveAllowedMediaFile, resolveAllowedMkv } from "./repair";

/** HDR10+ JSON for a 2 hour film is around 100 MB. */
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const MAX_BATCH_FILES = 500;

function uploadDir(config: AppConfig): string {
	const dir = join(config.tempDir, "hdr-uploads");
	mkdirSync(dir, { recursive: true });
	return realpathSync(dir);
}

/** An uploaded metadata file, which must be one Rabbit stored itself. */
function resolveUpload(raw: unknown, config: AppConfig): string {
	if (typeof raw !== "string" || !raw) throw new Error("Upload the HDR10+ JSON file first");
	const path = resolve(raw);
	const dir = uploadDir(config);
	if (!path.startsWith(`${dir}/`) || extname(path) !== ".json" || !existsSync(path))
		throw new Error("The uploaded HDR10+ metadata is no longer available, upload it again");
	return path;
}

/** Checks every path of a plan against Rabbit's media folders. */
function resolvePlanPaths(plan: HdrPlan, config: AppConfig): HdrPlan {
	const resolved: HdrPlan = { ...plan, targetPath: resolveAllowedMkv(plan.targetPath, config, "Video") };
	if (plan.sourcePath)
		resolved.sourcePath = resolveAllowedMediaFile(plan.sourcePath, config, plan.hdr10Plus === "dolby-vision" ? "Dolby Vision original" : "HDR10+ video");
	if (plan.metadataPath) resolved.metadataPath = resolveUpload(plan.metadataPath, config);
	if (resolved.sourcePath === resolved.targetPath) throw new Error("Choose another video than the one being changed");
	return resolved;
}

/** The MKV files of a folder, in name order. */
export function mkvFiles(folder: string, recursive: boolean, found: string[] = []): string[] {
	for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
		if (entry.name.startsWith(".")) continue;
		const path = join(folder, entry.name);
		if (entry.isDirectory() && recursive) mkvFiles(path, true, found);
		else if (entry.isFile() && extname(entry.name).toLowerCase() === ".mkv") found.push(path);
		if (found.length > MAX_BATCH_FILES) throw new Error(`A folder may contain at most ${MAX_BATCH_FILES} MKV files`);
	}
	return found;
}

export function registerHdrRoutes(app: Web, config: AppConfig): void {
	app.get("/api/hdr/inspect", async (c) => {
		try {
			const path = resolveAllowedMediaFile(c.query().get("path"), config, "Video");
			return c.json(await inspectHdrFile(path, c.req.signal));
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});

	app.post("/api/hdr/upload", async (c) => {
		try {
			const length = Number(c.req.headers.get("content-length") ?? 0);
			if (length > MAX_UPLOAD_BYTES) throw new Error("The metadata file is too large");
			const text = await c.req.text();
			if (text.length > MAX_UPLOAD_BYTES) throw new Error("The metadata file is too large");
			let frames = 0;
			try {
				const parsed = JSON.parse(text) as { SceneInfo?: unknown };
				frames = Array.isArray(parsed.SceneInfo) ? parsed.SceneInfo.length : 0;
			} catch {
				throw new Error("The file is not JSON");
			}
			if (frames === 0) throw new Error("The file has no HDR10+ metadata, its SceneInfo list is missing or empty");
			const path = join(uploadDir(config), `${randomUUID()}.json`);
			writeFileSync(path, text);
			return c.json({ path, frames }, 201);
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});

	app.post("/api/hdr/jobs", async (c) => {
		try {
			const raw = (await c.req.json()) as Partial<HdrPlan>;
			const plan = resolvePlanPaths({ ...sanitizeHdrPlan({ ...raw, batch: false }), sourcePath: raw.sourcePath, metadataPath: raw.metadataPath }, config);
			return c.json(addHdrJob(plan), 201);
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});

	app.post("/api/hdr/batch", async (c) => {
		try {
			const raw = (await c.req.json()) as { folder?: unknown; recursive?: unknown; plan?: Partial<HdrPlan> };
			const folder = resolveAllowedDirectory(raw.folder, config);
			const template = sanitizeHdrPlan({ ...(raw.plan ?? {}), targetPath: "", batch: true });
			const files = mkvFiles(folder, raw.recursive === true);
			if (files.length === 0) throw new Error("The folder has no MKV files");
			const jobIds: string[] = [];
			const skipped: string[] = [];
			for (const file of files) {
				try {
					jobIds.push(addHdrJob(resolvePlanPaths({ ...template, targetPath: file }, config)).id);
				} catch (error: any) {
					skipped.push(`${file}: ${error?.message || error}`);
				}
			}
			return c.json({ jobIds, skipped }, 201);
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});
}
