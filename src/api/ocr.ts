import { mkdirSync, rmSync } from "fs";
import { randomUUID } from "crypto";
import { join } from "path";
import type { Web } from "@rabbit-company/web";
import type { AppConfig, SubtitleOcrRequest } from "../core/types";
import { cleanOcrText, ocrConfigured, ocrLlmOptions, ocrPrompt, PGS_CODEC, unreadPictureTracks } from "../ocr/ocr";
import { OCR_SAMPLE_PNG, OCR_SAMPLE_TEXT } from "../ocr/sample";
import { probeFile } from "../pipeline/probe";
import { addSubtitleAddJob, getAppConfig } from "../queue/store";
import { detectSubtitleTrackType } from "../tracks/tracks";
import { chatComplete } from "../translate/llm-client";
import { resolveTranslateLang } from "../translate/translate-languages";
import { mkvFiles } from "./hdr";
import { resolveAllowedDirectory, resolveAllowedMkv } from "./repair";

const NOT_CONFIGURED = "Set up the OCR model under Settings, Subtitle handling, Picture subtitle OCR first";

function queueOcr(targetPath: string, ocr: SubtitleOcrRequest, config: AppConfig) {
	const workDir = join(config.tempDir, "subtitle-add", randomUUID());
	mkdirSync(workDir, { recursive: true });
	try {
		return addSubtitleAddJob({ targetPath, workDir, tracks: [], ocr });
	} catch (error) {
		rmSync(workDir, { recursive: true, force: true });
		throw error;
	}
}

const words = (s: string) =>
	s
		.toLowerCase()
		.replace(/<[^>]+>/g, "")
		.match(/[\p{L}\p{N}]+/gu) ?? [];

export function registerOcrRoutes(app: Web, config: AppConfig): void {
	/** The subtitle tracks of an MKV, marking the picture tracks that have no text version. */
	app.get("/api/ocr/inspect", async (c) => {
		try {
			const path = resolveAllowedMkv(c.query().get("path"), config, "Video");
			const streams = (await probeFile(path)).subtitleStreams ?? [];
			const unread = new Set(unreadPictureTracks(streams).map((s) => s.index));
			return c.json({
				path,
				configured: ocrConfigured(getAppConfig().defaults),
				tracks: streams.map((s) => ({
					index: s.index,
					codec: s.codec,
					language: s.language || "und",
					languageName: resolveTranslateLang(s.language)?.name ?? s.language ?? "Unknown",
					title: s.title ?? "",
					type: detectSubtitleTrackType(s),
					forced: !!s.isForced,
					picture: s.codec.toLowerCase() === PGS_CODEC,
					hasText: s.codec.toLowerCase() === PGS_CODEC && !unread.has(s.index),
				})),
			});
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
		}
	});

	app.post("/api/ocr/jobs", async (c) => {
		try {
			const body = (await c.req.json().catch(() => ({}))) as { path?: unknown; streams?: unknown; removePictures?: unknown };
			if (!ocrConfigured(getAppConfig().defaults)) throw new Error(NOT_CONFIGURED);
			const path = resolveAllowedMkv(body.path, config, "Video");
			if (!Array.isArray(body.streams) || !body.streams.length || body.streams.some((s) => !Number.isInteger(s)))
				throw new Error("Choose at least one picture subtitle track");
			const pictures = new Set(((await probeFile(path)).subtitleStreams ?? []).filter((s) => s.codec.toLowerCase() === PGS_CODEC).map((s) => s.index));
			const streams = [...new Set(body.streams as number[])];
			if (streams.some((s) => !pictures.has(s))) throw new Error("Only PGS picture subtitle tracks can be read");
			const job = queueOcr(path, { streams, removePictures: body.removePictures === true }, config);
			return c.json({ jobId: job.id }, 201);
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
		}
	});

	/** Every MKV of a folder becomes a job that reads its picture tracks without a text version. */
	app.post("/api/ocr/batch", async (c) => {
		try {
			const body = (await c.req.json().catch(() => ({}))) as { folder?: unknown; recursive?: unknown; languages?: unknown; removePictures?: unknown };
			if (!ocrConfigured(getAppConfig().defaults)) throw new Error(NOT_CONFIGURED);
			const folder = resolveAllowedDirectory(body.folder, config);
			const languages = Array.isArray(body.languages)
				? body.languages.filter((l): l is string => typeof l === "string" && !!l.trim()).map((l) => l.trim())
				: [];
			const unknown = languages.filter((l) => !resolveTranslateLang(l));
			if (unknown.length) throw new Error(`Unknown language: ${unknown.join(", ")}`);
			const files = mkvFiles(folder, body.recursive === true);
			if (!files.length) throw new Error("The folder has no MKV files");
			const jobIds: string[] = [];
			const skipped: string[] = [];
			for (const file of files) {
				try {
					jobIds.push(queueOcr(file, { languages, removePictures: body.removePictures === true }, config).id);
				} catch (error) {
					skipped.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			return c.json({ jobIds, skipped }, 201);
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
		}
	});

	/** Reads a known sample with the model, which proves it can see images, not just that the server answers. */
	app.post("/api/ocr/test", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as { provider?: string; baseUrl?: string; model?: string; apiKey?: string };
		const settings = {
			...getAppConfig().defaults,
			ocrProvider: body.provider === "anthropic" ? ("anthropic" as const) : ("openai" as const),
			ocrBaseUrl: (body.baseUrl ?? "").trim(),
			ocrModel: (body.model ?? "").trim(),
			ocrApiKey: (body.apiKey ?? "").trim(),
		};
		if (!settings.ocrBaseUrl || !settings.ocrModel) return c.json({ ok: false, error: "Missing API base URL or model" });
		try {
			const text = cleanOcrText(
				await chatComplete({ text: ocrPrompt("eng"), images: [OCR_SAMPLE_PNG] }, { ...ocrLlmOptions(settings), timeoutMs: 60_000, attempts: 1 }),
			);
			const expected = words(OCR_SAMPLE_TEXT);
			const got = new Set(words(text));
			const matched = expected.filter((w) => got.has(w)).length;
			return c.json({
				ok: matched === expected.length,
				text,
				error: matched === expected.length ? undefined : `The model read "${text}" instead of "${OCR_SAMPLE_TEXT}"`,
			});
		} catch (error) {
			return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	});
}
