import { mkdirSync } from "fs";
import { loadConfig } from "./config";
import { initStore, getAllJobs, getJob, updateJobSettings, removeJob, retryJob, updateDefaults } from "./store";
import { startWatcher } from "./watcher";
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

Logger.info(`Rabbit Encoder started on http://0.0.0.0:${config.port}`);

Bun.serve({
	hostname: "0.0.0.0",
	port: config.port,
	routes: {
		"/": indexHtml,
	},
	fetch: app.handleBun,
});
