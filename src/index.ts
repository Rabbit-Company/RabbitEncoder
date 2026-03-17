import { mkdirSync } from "fs";
import { loadConfig } from "./config";
import { initStore, getAllJobs, getJob, addJob, updateJobSettings, removeJob, retryJob } from "./store";
import { startWatcher } from "./watcher";
import { Web } from "@rabbit-company/web";
import { cors } from "@rabbit-company/web-middleware/cors";
import type { JobSettings } from "./types";
import { Logger } from "./logger";
import { logger } from "@rabbit-company/web-middleware/logger";
import indexHtml from "../public/index.html";

const config = loadConfig();

mkdirSync(config.inputDir, { recursive: true });
mkdirSync(config.outputDir, { recursive: true });
mkdirSync(config.tempDir, { recursive: true });

initStore(config);

startWatcher(config.inputDir);

const app = new Web();
app.use(logger({ logger: Logger }));
app.use(cors());

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

Logger.info(`Rabbit Encoder started on http://0.0.0.0:${config.port}`);

Bun.serve({
	hostname: "0.0.0.0",
	port: config.port,
	routes: {
		"/": indexHtml,
	},
	fetch: app.handleBun,
});
