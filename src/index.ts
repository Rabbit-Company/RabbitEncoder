import { mkdirSync } from "fs";
import { loadConfig } from "./config";
import { initStore, getAllJobs, getJob, updateJobSettings, removeJob, retryJob, updateDefaults, scanLibraryPath, moveJob, reorderJobs } from "./store";
import { startWatcher } from "./watcher";
import { browseFolder, isPathAllowed } from "./library";
import { Web } from "@rabbit-company/web";
import { cors } from "@rabbit-company/web-middleware/cors";
import type { JobSettings } from "./types";
import { Logger } from "./logger";
import { logger } from "@rabbit-company/web-middleware/logger";
import indexHtml from "../public/index.html";
import { bearerAuth } from "@rabbit-company/web-middleware/bearer-auth";

export const config = loadConfig();

const hashedPassword = new Bun.CryptoHasher("blake2b512").update(`rabbitencoder-${process.env.PASSWORD || "rabbitencoder"}`).digest("hex");

mkdirSync(config.inputDir, { recursive: true });
mkdirSync(config.outputDir, { recursive: true });
mkdirSync(config.tempDir, { recursive: true });

initStore(config);

startWatcher(config.inputDir);

const app = new Web();
app.use(logger({ logger: Logger }));
app.use(cors());
app.use(
	bearerAuth({
		validate(token, ctx) {
			if (token.length !== hashedPassword.length) {
				return !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(token));
			}

			return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(hashedPassword));
		},
	}),
);

app.get("/api/jobs", (c) => {
	return c.json(getAllJobs());
});

app.get("/api/jobs/:id", (c) => {
	const job = getJob(c.params.id!);
	if (!job) return c.json({ error: "Job not found" }, 404);
	return c.json(job);
});

app.patch("/api/jobs/:id", async (c) => {
	const body = (await c.req.json()) as Partial<JobSettings>;
	const job = updateJobSettings(c.params.id!, body);
	if (!job) return c.json({ error: "Job not found or not editable" }, 400);
	return c.json(job);
});

app.delete("/api/jobs/:id", (c) => {
	const ok = removeJob(c.params.id!);
	if (!ok) return c.json({ error: "Cannot remove active job" }, 400);
	return c.json({ ok: true });
});

app.post("/api/jobs/:id/retry", (c) => {
	const job = retryJob(c.params.id!);
	if (!job) return c.json({ error: "Job not found or not retryable" }, 400);
	return c.json(job);
});

app.post("/api/jobs/:id/move", async (c) => {
	const body = (await c.req.json()) as { direction?: string };
	const direction = body.direction;
	if (!direction || !["up", "down", "top", "bottom"].includes(direction)) {
		return c.json({ error: "Invalid direction. Use: up, down, top, bottom" }, 400);
	}
	const ok = moveJob(c.params.id!, direction as "up" | "down" | "top" | "bottom");
	if (!ok) return c.json({ error: "Job not found, not queued, or already at boundary" }, 400);
	return c.json({ ok: true });
});

app.post("/api/jobs/reorder", async (c) => {
	const body = (await c.req.json()) as { ids?: string[] };
	if (!body.ids || !Array.isArray(body.ids)) {
		return c.json({ error: "Missing 'ids' array in request body" }, 400);
	}
	reorderJobs(body.ids);
	return c.json({ ok: true });
});

app.get("/api/config", (c) => {
	return c.json(config.defaults);
});

app.patch("/api/config", async (c) => {
	const body = (await c.req.json()) as Partial<JobSettings>;
	const updated = updateDefaults(body);
	return c.json(updated);
});

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
	const body = (await c.req.json()) as { paths?: string[]; path?: string };

	const paths = body.paths || (body.path ? [body.path] : []);
	if (paths.length === 0) {
		return c.json({ error: "Missing 'paths' in request body" }, 400);
	}

	for (const p of paths) {
		if (!isPathAllowed(p, config.libraryDirs)) {
			return c.json({ error: `Path is not within any configured library directory: ${p}` }, 403);
		}
	}

	let totalAdded = 0;
	let totalSkipped = 0;
	let totalAlreadyEncoded = 0;

	for (const p of paths) {
		Logger.info(`[library] Encoding: ${p}`);
		const result = scanLibraryPath(p);
		totalAdded += result.added;
		totalSkipped += result.skipped;
		totalAlreadyEncoded += result.alreadyEncoded;
	}

	Logger.info(`[library] Queued ${totalAdded} files (${totalSkipped} already queued, ${totalAlreadyEncoded} already encoded)`);
	return c.json({ ok: true, added: totalAdded, skipped: totalSkipped, alreadyEncoded: totalAlreadyEncoded });
});

Logger.info(`Rabbit Encoder started on http://0.0.0.0:${config.port}`);

if (config.libraryDirs.length > 0) {
	Logger.info(`Library directories: ${config.libraryDirs.join(", ")}`);
}

Bun.serve({
	hostname: "0.0.0.0",
	port: config.port,
	routes: {
		"/": indexHtml,
	},
	fetch: app.handleBun,
});
