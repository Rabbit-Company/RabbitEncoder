import type { Web } from "@rabbit-company/web";
import { resolveTranslateLang } from "../translate/translate-languages";
import { checkGenericChat } from "../translate/generic";
import { type TranslateProvider } from "../translate/llm-client";

export function registerTranslateRoutes(app: Web): void {
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
}
