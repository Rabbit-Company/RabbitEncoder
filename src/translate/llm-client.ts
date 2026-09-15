import { Logger } from "../core/logger";

/** Which wire format translation requests use. */
export type TranslateProvider = "openai" | "anthropic";

export interface LlmChatOptions {
	provider: TranslateProvider;
	/**
	 * API base URL, with or without a trailing "/v1" (both accepted):
	 *   openai:    "https://api.openai.com/v1", "http://localhost:11434/v1",
	 *              "https://api.deepseek.com/v1", "https://openrouter.ai/api/v1"
	 *   anthropic: "https://api.anthropic.com"
	 */
	baseUrl: string;
	/** API key. Optional — local OpenAI-compatible servers (Ollama, LM Studio) don't need one. */
	apiKey?: string;
	/** Model id, e.g. "gpt-4o-mini", "deepseek-v4-flash", "translategemma:12b", "claude-sonnet-4-6". */
	model: string;
	temperature?: number;
	/** Max output tokens. Required by the Anthropic API; sent for both formats. */
	maxTokens?: number;
	timeoutMs?: number;
	/** Max request attempts (transient-failure retries). Default 3. */
	attempts?: number;
	signal?: AbortSignal;
}

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_TEMPERATURE = 0.1;
/** Batched JSON answers can be large; give the model output headroom. */
const DEFAULT_MAX_TOKENS = 8192;
/** Retries on transient failures (429 / 5xx / network). */
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1_000, 3_000];

const PROVIDER_LABEL: Record<TranslateProvider, string> = {
	openai: "OpenAI-compatible API",
	anthropic: "Anthropic API",
};

/** Normalize a base URL so both "https://host" and "https://host/v1" work. */
export function normalizeV1(baseUrl: string): string {
	const base = baseUrl.replace(/\/+$/, "");
	return /\/v1$/i.test(base) ? base : `${base}/v1`;
}

function friendlyHttpError(provider: TranslateProvider, status: number, bodyMsg?: string): string {
	const label = PROVIDER_LABEL[provider];
	if (status === 401) return `${label} rejected the API key (HTTP 401). Check the key in settings.`;
	if (status === 402) return `${label} account has insufficient balance/credits (HTTP 402).`;
	if (status === 404) return `${label} returned HTTP 404${bodyMsg ? ` (${bodyMsg})` : ""}. Check the base URL and model name in settings.`;
	if (status === 429) return `${label} rate limit hit (HTTP 429).`;
	if (status === 529) return `${label} is overloaded (HTTP 529).`;
	return `${label} returned HTTP ${status}${bodyMsg ? `: ${bodyMsg}` : ""}`;
}

function isRetryable(status: number): boolean {
	return status === 429 || status === 529 || (status >= 500 && status <= 504);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const t = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(t);
			reject(signal?.reason ?? new Error("aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

interface OpenAiChatResponse {
	choices?: Array<{ message?: { content?: string } }>;
	error?: { message?: string; type?: string };
}

interface AnthropicMessagesResponse {
	content?: Array<{ type?: string; text?: string }>;
	error?: { message?: string; type?: string };
}

function buildRequest(prompt: string, opts: LlmChatOptions): { url: string; headers: Record<string, string>; body: string } {
	const v1 = normalizeV1(opts.baseUrl);
	const key = opts.apiKey?.trim();

	if (opts.provider === "anthropic") {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"anthropic-version": ANTHROPIC_VERSION,
		};
		if (key) headers["x-api-key"] = key;
		return {
			url: `${v1}/messages`,
			headers,
			body: JSON.stringify({
				model: opts.model,
				max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
				temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
				messages: [{ role: "user", content: prompt }],
			}),
		};
	}

	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (key) headers["Authorization"] = `Bearer ${key}`;
	return {
		url: `${v1}/chat/completions`,
		headers,
		body: JSON.stringify({
			model: opts.model,
			stream: false,
			messages: [{ role: "user", content: prompt }],
			temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
			max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
		}),
	};
}

function extractContent(provider: TranslateProvider, data: unknown): string {
	if (provider === "anthropic") {
		const d = data as AnthropicMessagesResponse;
		if (d.error) throw new Error(`Anthropic API error: ${d.error.message ?? d.error.type ?? "unknown"}`);
		return (d.content ?? [])
			.filter((b) => b.type === "text" && typeof b.text === "string")
			.map((b) => b.text!)
			.join("");
	}
	const d = data as OpenAiChatResponse;
	if (d.error) throw new Error(`API error: ${d.error.message ?? d.error.type ?? "unknown"}`);
	return d.choices?.[0]?.message?.content ?? "";
}

/** One chat round trip with timeout, abort, and transient-error retry. */
export async function chatComplete(prompt: string, opts: LlmChatOptions): Promise<string> {
	const label = PROVIDER_LABEL[opts.provider] ?? "LLM API";

	if (!opts.baseUrl?.trim()) throw new Error(`${label} base URL is not configured. Set it in translation settings.`);
	if (!opts.model?.trim()) throw new Error(`${label} model is not configured. Set it in translation settings.`);

	const { url, headers, body } = buildRequest(prompt, opts);

	let lastError: Error = new Error(`${label} request failed`);

	const maxAttempts = Math.max(1, opts.attempts ?? MAX_ATTEMPTS);
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(new Error(`${label} request timed out`)), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

		const onExternalAbort = () => controller.abort(opts.signal?.reason ?? new Error("aborted"));
		if (opts.signal) {
			if (opts.signal.aborted) controller.abort(opts.signal.reason);
			else opts.signal.addEventListener("abort", onExternalAbort, { once: true });
		}

		try {
			const res = await fetch(url, { method: "POST", headers, signal: controller.signal, body });

			if (!res.ok) {
				const bodyMsg = await res
					.json()
					.then((j: { error?: { message?: string } }) => j?.error?.message)
					.catch(() => undefined);
				const err = new Error(friendlyHttpError(opts.provider, res.status, bodyMsg));
				if (isRetryable(res.status) && attempt < MAX_ATTEMPTS - 1) {
					lastError = err;
					Logger.warn(`[translate] ${err.message}. Retrying (${attempt + 1}/${MAX_ATTEMPTS - 1}).`);
					await sleep(RETRY_DELAYS_MS[attempt] ?? 3_000, opts.signal);
					continue;
				}
				throw err;
			}

			const data = (await res.json()) as unknown;
			return extractContent(opts.provider, data);
		} catch (err) {
			// Abort (job cancel / timeout) is never retried.
			if (opts.signal?.aborted || controller.signal.aborted) throw err;
			lastError = err as Error;
			if (attempt < MAX_ATTEMPTS - 1) {
				Logger.warn(`[translate] ${label} request failed (${lastError.message}). Retrying.`);
				await sleep(RETRY_DELAYS_MS[attempt] ?? 3_000, opts.signal);
				continue;
			}
			throw lastError;
		} finally {
			clearTimeout(timeout);
			opts.signal?.removeEventListener("abort", onExternalAbort);
		}
	}
	throw lastError;
}

/**
 * Probe the provider: reachability, key validity and (best-effort) model
 * availability via `GET {base}/v1/models`. Servers that don't implement the
 * models endpoint (some proxies/gateways) are treated as reachable.
 */
export async function checkProvider(
	opts: Pick<LlmChatOptions, "provider" | "baseUrl" | "apiKey" | "model">,
	signal?: AbortSignal,
): Promise<{ ok: boolean; detail: string }> {
	const label = PROVIDER_LABEL[opts.provider];
	if (!opts.baseUrl.trim()) return { ok: false, detail: "no API base URL is configured" };

	const key = opts.apiKey?.trim();
	const headers: Record<string, string> =
		opts.provider === "anthropic"
			? { "anthropic-version": ANTHROPIC_VERSION, ...(key ? { "x-api-key": key } : {}) }
			: key
				? { Authorization: `Bearer ${key}` }
				: {};

	try {
		const res = await fetch(`${normalizeV1(opts.baseUrl)}/models`, { headers, signal });
		if (res.status === 401) return { ok: false, detail: `${label} rejected the API key (HTTP 401)` };
		// The models listing is optional in the wild; don't fail the probe on it.
		if (res.status === 404 || res.status === 405) return { ok: true, detail: "" };
		if (!res.ok) return { ok: false, detail: `${label} /models returned HTTP ${res.status}` };

		const data = (await res.json()) as { data?: Array<{ id?: string; name?: string }>; models?: Array<{ id?: string; name?: string }>; has_more?: boolean };
		const list = data.data ?? data.models ?? [];
		const ids = list.map((m) => m.id ?? m.name ?? "").filter(Boolean);
		// Only trust a definitive, non-paginated listing for a "model missing" verdict.
		if (ids.length > 0 && data.has_more !== true && !ids.some((id) => id === opts.model || id.split(":")[0] === opts.model.split(":")[0])) {
			return { ok: false, detail: `Model "${opts.model}" not available at this endpoint (available: ${ids.slice(0, 20).join(", ")})` };
		}
		return { ok: true, detail: "" };
	} catch (err) {
		return { ok: false, detail: `Cannot reach ${label} at ${opts.baseUrl}: ${(err as Error).message}` };
	}
}
