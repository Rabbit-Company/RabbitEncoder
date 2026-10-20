import type { Web } from "@rabbit-company/web";
import type { AppConfig } from "../core/types";
import { resolveTranslateLang } from "../translate/translate-languages";
import { checkGenericChat } from "../translate/generic";
import { type TranslateProvider } from "../translate/llm-client";
import { deleteSeriesNotes, listSeriesNotes, loadSeriesNotes, saveSeriesNotes, seriesNotesDir } from "../translate/series-notes";

const NOTES_KEY = /^[\p{L}\p{N}-]{1,120}$/u;
const MAX_NOTES_CHARS = 50_000;

export function registerTranslateRoutes(app: Web, config: AppConfig): void {
	app.post("/api/translate/test", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as {
			provider?: string;
			baseUrl?: string;
			model?: string;
			apiKey?: string;
			target?: string;
			thinking?: string;
		};
		const provider: TranslateProvider = body.provider === "anthropic" ? "anthropic" : "openai";
		const baseUrl = (body.baseUrl || "").trim();
		const model = (body.model || "").trim();
		const apiKey = (body.apiKey || "").trim() || undefined;
		const source = { name: "English", code: "en" };
		const target = resolveTranslateLang(body.target || "slv") ?? { name: "Slovenian", code: "sl" };

		if (!baseUrl || !model) return c.json({ ok: false, error: "Missing API base URL or model" }, 400);

		const thinking = body.thinking === "off" || body.thinking === "on" ? body.thinking : "auto";
		const r = await checkGenericChat({ provider, baseUrl, apiKey, model, source, target, thinking, timeoutMs: 30_000 });
		return c.json(r.ok ? { ok: true, sample: r.sample, model, target: target.name } : { ok: false, error: r.detail });
	});

	app.get("/api/translate/notes", (c) => c.json({ series: listSeriesNotes(seriesNotesDir(config)) }));

	app.put("/api/translate/notes/:key", async (c) => {
		const key = decodeURIComponent(c.params.key!);
		if (!NOTES_KEY.test(key)) return c.json({ error: "Invalid series key" }, 400);
		const dir = seriesNotesDir(config);
		const stored = loadSeriesNotes(dir, key);
		if (!stored) return c.json({ error: "Series notes not found" }, 404);
		const body = (await c.req.json().catch(() => ({}))) as { notes?: unknown };
		if (typeof body.notes !== "string") return c.json({ error: "Missing notes" }, 400);
		const next = { ...stored, notes: body.notes.slice(0, MAX_NOTES_CHARS), updatedAt: Date.now() };
		saveSeriesNotes(dir, next);
		return c.json(next);
	});

	app.delete("/api/translate/notes/:key", (c) => {
		const key = decodeURIComponent(c.params.key!);
		if (!NOTES_KEY.test(key)) return c.json({ error: "Invalid series key" }, 400);
		return deleteSeriesNotes(seriesNotesDir(config), key) ? c.json({ ok: true }) : c.json({ error: "Series notes not found" }, 404);
	});
}
