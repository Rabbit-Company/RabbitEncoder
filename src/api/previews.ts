import type { Web } from "@rabbit-company/web";
import type { AppConfig } from "../core/types";
import { cancelPreview, clearPreviewFor, getJob, getPreviewState, startPreview, startPreviewMeasure } from "../queue/store";
import {
	MAX_PREVIEW_REFERENCES,
	previewArchiveEntries,
	resolvePreviewArtifact,
	type PreviewEncodeOptions,
	type PreviewReferenceInput,
} from "../pipeline/preview-encoder";
import { isPreviewMetric, type PreviewMeasureOptions } from "../pipeline/preview-metrics";
import { resolveAllowedMediaFile } from "./repair";
import { buildZip } from "../core/zip";
import { isStillStyle, STILL_STYLES } from "../core/still-style";
import { viewablePng, intoBitDepthFolders } from "../video/screenshot";

function parseMeasureOptions(metrics: unknown, withGrain: unknown, allowNone: boolean): PreviewMeasureOptions | string {
	if (!Array.isArray(metrics) || !metrics.every(isPreviewMetric)) return "metrics must be a list of ssimulacra2, xpsnr and vmaf";
	if (!allowNone && metrics.length === 0) return "Pick at least one metric";
	if (withGrain !== undefined && typeof withGrain !== "boolean") return "withGrain must be true or false";
	return { metrics: [...new Set(metrics)], withGrain: withGrain ?? true };
}

export function registerPreviewRoutes(app: Web, config: AppConfig): void {
	app.get("/api/jobs/:id/preview", (c) => {
		const state = getPreviewState(c.params.id!);
		if (!state) return c.json({ status: "idle" });
		return c.json(state);
	});

	app.post("/api/jobs/:id/preview", async (c) => {
		let body: { clipCount?: number; clipDuration?: number; references?: unknown; metrics?: unknown; metricsWithGrain?: unknown; stillStyle?: unknown } = {};
		try {
			body = (await c.req.json()) as typeof body;
		} catch {
			// no body (fall back to defaults)
		}

		const options: Partial<PreviewEncodeOptions> = {};

		if (body.clipCount !== undefined) {
			const n = Math.round(Number(body.clipCount));
			if (!Number.isFinite(n) || n < 1 || n > 20) {
				return c.json({ error: "clipCount must be a whole number between 1 and 20" }, 400);
			}
			options.sampleCount = n;
		}

		if (body.clipDuration !== undefined) {
			const d = Number(body.clipDuration);
			if (!Number.isFinite(d) || d < 1 || d > 30) {
				return c.json({ error: "clipDuration must be between 1 and 30 seconds" }, 400);
			}
			options.windowSeconds = d;
		}

		if (body.references !== undefined) {
			if (!Array.isArray(body.references) || body.references.length > MAX_PREVIEW_REFERENCES) {
				return c.json({ error: `references must be a list of at most ${MAX_PREVIEW_REFERENCES} videos` }, 400);
			}
			const references: PreviewReferenceInput[] = [];
			for (const [i, raw] of body.references.entries()) {
				const entry = (raw ?? {}) as { path?: unknown; label?: unknown };
				let path: string;
				try {
					path = resolveAllowedMediaFile(entry.path, config, "Comparison source");
				} catch (err) {
					return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
				}
				const label = typeof entry.label === "string" ? entry.label.trim().slice(0, 40) : "";
				references.push({ path, label: label || `Reference ${i + 1}` });
			}
			options.references = references;
		}

		if (body.metrics !== undefined) {
			const measure = parseMeasureOptions(body.metrics, body.metricsWithGrain, true);
			if (typeof measure === "string") return c.json({ error: measure }, 400);
			options.metrics = measure.metrics;
			options.metricsWithGrain = measure.withGrain;
		}

		if (body.stillStyle !== undefined) {
			if (!isStillStyle(body.stillStyle)) return c.json({ error: `stillStyle must be one of ${STILL_STYLES.join(", ")}` }, 400);
			options.stillStyle = body.stillStyle;
		}

		const result = startPreview(c.params.id!, options);
		if (!result.ok) return c.json({ error: result.error }, result.status);
		return c.json(result.state);
	});

	app.post("/api/jobs/:id/preview/measure", async (c) => {
		let body: { metrics?: unknown; withGrain?: unknown } = {};
		try {
			body = (await c.req.json()) as typeof body;
		} catch {}
		const measure = parseMeasureOptions(body.metrics, body.withGrain, false);
		if (typeof measure === "string") return c.json({ error: measure }, 400);
		const result = startPreviewMeasure(c.params.id!, measure);
		if (!result.ok) return c.json({ error: result.error }, result.status);
		return c.json(result.state);
	});

	app.delete("/api/jobs/:id/preview", (c) => {
		const cancelled = cancelPreview(c.params.id!);
		if (!cancelled) {
			clearPreviewFor(c.params.id!);
			return c.json({ ok: true, cleared: true });
		}
		return c.json({ ok: true, cancelled: true });
	});

	app.get("/api/jobs/:id/preview/download", async (c) => {
		const state = getPreviewState(c.params.id!);
		if (!state || state.status === "running" || !state.samples.length) return c.json({ error: "No finished preview to download" }, 404);
		const entries = await intoBitDepthFolders(previewArchiveEntries(config, state), c.req.signal);
		const zip = buildZip(entries, new Date(state.finishedAt ?? Date.now()));
		const base = (getJob(state.jobId)?.filename ?? state.jobId).replace(/\.[^.]+$/, "").replace(/[^\p{L}\p{N}._-]+/gu, "_");
		const name = `preview_${base}.zip`;
		return new Response(zip, {
			headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}` },
		});
	});

	// ?view=1 gives stills as an 8-bit copy for showing in the browser. Without it, the 16-bit still.
	app.get("/api/jobs/:id/preview/sample/:index/:kind", async (c) => {
		const jobId = c.params.id!;
		const idx = parseInt(c.params.index!, 10);
		const kind = c.params.kind!;

		if (Number.isNaN(idx)) return c.json({ error: "Bad request" }, 400);

		const isStandard = kind === "source" || kind === "encode" || kind === "clip" || kind === "source-clip";
		const isVsStep = /^vs:\d+$/.test(kind);
		const isReference = /^ref:\d+$/.test(kind);
		const isPrepareStep = /^pf:(?:downscale|deband|denoise|crop)$/.test(kind);
		if (!isStandard && !isVsStep && !isReference && !isPrepareStep) {
			return c.json({ error: "Bad request" }, 400);
		}

		const path = resolvePreviewArtifact(config, jobId, idx, kind);
		if (!path) return c.json({ error: "Artifact not found" }, 404);

		const file = Bun.file(path);

		if (kind === "clip" || kind === "source-clip") {
			const clipName = kind === "source-clip" ? "source" : "encode";
			return new Response(file, {
				headers: {
					"Content-Type": "video/x-matroska",
					"Content-Disposition": `attachment; filename="job_${jobId}_sample_${idx + 1}_${clipName}.mkv"`,
					"Cache-Control": "private, max-age=0, must-revalidate",
				},
			});
		}

		const served = c.query().get("view") === "1" ? Bun.file(await viewablePng(path, c.req.signal)) : file;
		return new Response(served, {
			headers: {
				"Content-Type": "image/png",
				"Cache-Control": "private, max-age=60",
			},
		});
	});
}
