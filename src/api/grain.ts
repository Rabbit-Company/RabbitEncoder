import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { basename, extname, join, resolve } from "path";
import type { Web } from "@rabbit-company/web";
import type { AppConfig, GrainInspectRun, GrainPlan } from "../core/types";
import { checkFilmGrainTable, exportFilmGrainTable, inspectGrainFile, sanitizeGrainPlan } from "../pipeline/grain-tool";
import { addGrainJob } from "../queue/store";
import { mkvFiles } from "./hdr";
import { resolveAllowedDirectory, resolveAllowedMediaFile, resolveAllowedMkv } from "./repair";

/** A table with an entry for every frame of a 2 hour film is around 50 MB. */
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

function uploadDir(config: AppConfig): string {
	const dir = join(config.tempDir, "grain-uploads");
	mkdirSync(dir, { recursive: true });
	return realpathSync(dir);
}

/** An uploaded table, which must be one Rabbit stored itself. */
function resolveUpload(raw: unknown, config: AppConfig): string {
	if (typeof raw !== "string" || !raw) throw new Error("Upload a film grain table first");
	const path = resolve(raw);
	if (!path.startsWith(`${uploadDir(config)}/`) || extname(path) !== ".tbl" || !existsSync(path))
		throw new Error("The uploaded film grain table is no longer available, upload it again");
	return path;
}

function resolvePlanPaths(plan: GrainPlan, config: AppConfig): GrainPlan {
	const resolved: GrainPlan = { ...plan, targetPath: resolveAllowedMkv(plan.targetPath, config, "Video") };
	if (plan.action === "table") resolved.tablePath = resolveUpload(plan.tablePath, config);
	if (plan.action === "measure") {
		resolved.sourcePath = resolveAllowedMediaFile(plan.sourcePath, config, "Original");
		if (resolved.sourcePath === resolved.targetPath) throw new Error("Choose the original the video was encoded from, not the video itself");
	}
	return resolved;
}

/** Finished inspections are kept this long for the browser to pick them up. */
const KEEP_INSPECTION_MS = 10 * 60 * 1000;

type Inspection = GrainInspectRun & { controller: AbortController; finishedAt?: number };

const inspections = new Map<string, Inspection>();

/** Inspects a video in the background, since reading the grain of a long film can take a while. */
function startInspection(path: string, config: AppConfig): GrainInspectRun {
	const now = Date.now();
	for (const [id, run] of inspections) if (run.status !== "running" && now - (run.finishedAt ?? now) > KEEP_INSPECTION_MS) inspections.delete(id);
	const run: Inspection = {
		id: randomUUID(),
		path,
		status: "running",
		startedAt: now,
		progress: { stage: "video", percent: null, detail: "Reading the video" },
		controller: new AbortController(),
	};
	inspections.set(run.id, run);
	inspectGrainFile(path, config.tempDir, run.controller.signal, (progress) => (run.progress = progress))
		.then((result) => Object.assign(run, { status: "done", result }))
		.catch((error) =>
			Object.assign(
				run,
				run.controller.signal.aborted ? { status: "cancelled" } : { status: "error", error: error instanceof Error ? error.message : String(error) },
			),
		)
		.finally(() => (run.finishedAt = Date.now()));
	const { controller: _, ...state } = run;
	return state;
}

export function registerGrainRoutes(app: Web, config: AppConfig): void {
	app.post("/api/grain/inspect", async (c) => {
		try {
			const body = (await c.req.json().catch(() => ({}))) as { path?: unknown };
			const path = resolveAllowedMediaFile(body.path, config, "Video");
			return c.json(startInspection(path, config), 201);
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});

	app.get("/api/grain/inspect/:id", (c) => {
		const run = inspections.get(c.params.id!);
		if (!run) return c.json({ error: "The inspection is no longer available, choose the video again" }, 404);
		const { controller: _, finishedAt: __, ...state } = run;
		return c.json(state);
	});

	app.delete("/api/grain/inspect/:id", (c) => {
		inspections.get(c.params.id!)?.controller.abort();
		return c.json({ ok: true });
	});

	/** The film grain table of a video, as regrain exports it. */
	app.get("/api/grain/table", async (c) => {
		const temp = join(config.tempDir, `grain-export-${randomUUID()}.tbl`);
		try {
			const path = resolveAllowedMkv(c.query().get("path"), config, "Video");
			const exported = await exportFilmGrainTable(path, temp, c.req.signal);
			if (exported.entries === 0) throw new Error("The video has no film grain");
			const name = `${basename(path, extname(path))}.tbl`;
			return new Response(readFileSync(temp), {
				headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}` },
			});
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		} finally {
			rmSync(temp, { force: true });
		}
	});

	app.post("/api/grain/upload", async (c) => {
		let path = "";
		try {
			const length = Number(c.req.headers.get("content-length") ?? 0);
			if (length > MAX_UPLOAD_BYTES) throw new Error("The table is too large");
			const text = await c.req.text();
			if (text.length > MAX_UPLOAD_BYTES) throw new Error("The table is too large");
			// regrain skips comments above the header, so only the header line itself is required.
			if (!/^filmgrn1\r?$/m.test(text)) throw new Error("The file is not an AV1 film grain table, it has no filmgrn1 line");
			const entries = (text.match(/^E /gm) ?? []).length;
			if (entries === 0) throw new Error("The table has no entries. Choose Remove to take the grain out");
			const raw = join(uploadDir(config), `${randomUUID()}.raw`);
			path = join(uploadDir(config), `${randomUUID()}.tbl`);
			writeFileSync(raw, text);
			// Errors and problems that regrain can correct are corrected, so the job applies the table as it was meant.
			const check = await checkFilmGrainTable(raw, c.req.signal, path).finally(() => rmSync(raw, { force: true }));
			if (check.errors > 0 && !check.fixed)
				throw new Error(
					`The table has ${check.errors} ${check.errors === 1 ? "error" : "errors"}: ${check.findings.find((f) => f.severity === "error")?.message}`,
				);
			if (!check.fixed) writeFileSync(path, text);
			return c.json({ path, entries, fixed: check.fixed ? check.fixable : 0, warnings: check.warnings }, 201);
		} catch (error: any) {
			if (path) rmSync(path, { force: true });
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});

	app.post("/api/grain/jobs", async (c) => {
		try {
			const raw = (await c.req.json()) as Partial<GrainPlan>;
			return c.json(addGrainJob(resolvePlanPaths(sanitizeGrainPlan({ ...raw, batch: false }), config)), 201);
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});

	app.post("/api/grain/batch", async (c) => {
		try {
			const raw = (await c.req.json()) as { folder?: unknown; recursive?: unknown; plan?: Partial<GrainPlan> };
			const folder = resolveAllowedDirectory(raw.folder, config);
			const template = sanitizeGrainPlan({ ...(raw.plan ?? {}), targetPath: "", batch: true });
			if (template.action === "table") template.tablePath = resolveUpload(template.tablePath, config);
			const files = mkvFiles(folder, raw.recursive === true);
			if (files.length === 0) throw new Error("The folder has no MKV files");
			const jobIds: string[] = [];
			const skipped: string[] = [];
			for (const file of files) {
				try {
					jobIds.push(addGrainJob({ ...template, targetPath: resolveAllowedMkv(file, config, "Video") }).id);
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
