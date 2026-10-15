import { describe, expect, it } from "bun:test";
import { parseGenericResponse, reasoningExhaustedError, salvageJsonObjects } from "../../src/translate/generic";
import { extractChatResult, shouldDisableThinking } from "../../src/translate/llm-client";

describe("truncated replies", () => {
	it("keeps complete rows from a reply cut off midway", () => {
		const cut = '[{"id":"0","text":"Živjo"},{"id":"1","text":"Kaj {\\\\i1}je{\\\\i0} to?"},{"id":"2","text":"Nedokon';
		expect(salvageJsonObjects(cut)).toEqual([
			{ id: "0", text: "Živjo" },
			{ id: "1", text: "Kaj {\\i1}je{\\i0} to?" },
		]);
		expect(parseGenericResponse(cut, 3)).toEqual(["Živjo", "Kaj {\\i1}je{\\i0} to?", null]);
	});

	it("ignores braces and brackets inside strings", () => {
		const cut = '```json\n[{"id":"0","text":"a } ] b"},{"id":"1"';
		expect(parseGenericResponse(cut, 2)).toEqual(["a } ] b", null]);
	});
});

describe("reasoning budget", () => {
	it("reads finish reason and reasoning usage from an OpenAI style reply", () => {
		const r = extractChatResult("openai", {
			choices: [{ message: { content: "", reasoning_content: "Let me think..." }, finish_reason: "length" }],
			usage: { completion_tokens: 8192, completion_tokens_details: { reasoning_tokens: 8192 } },
		});
		expect(r.truncated).toBe(true);
		expect(r.reasoningTokens).toBe(8192);
		expect(reasoningExhaustedError(r, 8192)?.message).toContain("Reasoning to Off");
	});

	it("does not blame reasoning for a plain bad reply", () => {
		const r = extractChatResult("openai", { choices: [{ message: { content: "nope" }, finish_reason: "stop" }] });
		expect(reasoningExhaustedError(r, 8192)).toBeNull();
	});

	it("turns thinking off for DeepSeek on auto only", () => {
		expect(shouldDisableThinking({ baseUrl: "https://api.deepseek.com/v1" })).toBe(true);
		expect(shouldDisableThinking({ baseUrl: "https://api.openai.com/v1" })).toBe(false);
		expect(shouldDisableThinking({ baseUrl: "https://openrouter.ai/api/v1", thinking: "off" })).toBe(true);
		expect(shouldDisableThinking({ baseUrl: "https://api.deepseek.com", thinking: "on" })).toBe(false);
	});
});
