import { mkdirSync } from "fs";
import { loadConfig } from "./config";
import { initStore, getAllJobs, getJob, updateJobSettings, removeJob, retryJob, updateDefaults, scanLibraryFolder } from "./store";
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
	const body = (await c.req.json()) as { path: string };
	if (!body.path) {
		return c.json({ error: "Missing 'path' in request body" }, 400);
	}

	if (!isPathAllowed(body.path, config.libraryDirs)) {
		return c.json({ error: "Path is not within any configured library directory" }, 403);
	}

	Logger.info(`[library] Starting library encode for: ${body.path}`);
	const result = scanLibraryFolder(body.path);
	Logger.info(`[library] Queued ${result.added} files (${result.skipped} already queued, ${result.alreadyEncoded} already encoded)`);

	return c.json({ ok: true, added: result.added, skipped: result.skipped, alreadyEncoded: result.alreadyEncoded });
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
