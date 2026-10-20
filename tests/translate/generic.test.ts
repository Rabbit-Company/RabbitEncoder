import { describe, expect, it } from "bun:test";
import {
	buildGenericInstruction,
	buildGenericPrompt,
	stripCodeFences,
	extractJsonArray,
	parseGenericResponse,
	type TranslateItem,
	type GenericOptions,
	repairJsonEscapes,
} from "../../src/translate/generic";

const EN = { name: "English", code: "en" };
const SL = { name: "Slovenian", code: "sl" };

const baseOpts: GenericOptions = { provider: "openai", baseUrl: "http://x:11434", model: "qwen2.5:14b", source: EN, target: SL };

describe("buildGenericInstruction", () => {
	it("names the target language and the JSON contract", () => {
		const ins = buildGenericInstruction(EN, SL);
		expect(ins).toContain("into Slovenian");
		expect(ins).toContain("JSON array");
		expect(ins).toContain('"id"');
	});
	it("honors an override with placeholder substitution", () => {
		const ins = buildGenericInstruction(EN, SL, "Render {source} to {target} nicely.");
		expect(ins).toBe("Render English to Slovenian nicely.");
	});
});

describe("buildGenericPrompt", () => {
	it("emits id-keyed rows and includes character names only when present", () => {
		const items: TranslateItem[] = [{ text: "Hello there.", name: "Naruto" }, { text: "Good morning." }];
		const p = buildGenericPrompt(items, baseOpts);
		const json = p.slice(p.indexOf("["));
		const rows = JSON.parse(json);
		expect(rows).toEqual([
			{ id: "0", name: "Naruto", text: "Hello there." },
			{ id: "1", text: "Good morning." },
		]);
	});
});

describe("prompt extras", () => {
	it("adds Slovenian rules only for a Slovenian target", () => {
		expect(buildGenericInstruction(EN, SL)).toContain("midva greva");
		expect(buildGenericInstruction(EN, { name: "German", code: "de" })).not.toContain("midva greva");
	});

	it("places notes and previous lines before the payload", () => {
		const p = buildGenericPrompt([{ text: "Next." }], {
			...baseOpts,
			notes: "Characters:\n- Ai: female",
			context: [{ name: "Ai", text: "Hi.", translation: "Živjo." }],
		});
		const notesAt = p.indexOf("- Ai: female");
		const contextAt = p.indexOf('"translation":"Živjo."');
		const inputAt = p.indexOf("Input:");
		expect(notesAt).toBeGreaterThan(0);
		expect(contextAt).toBeGreaterThan(notesAt);
		expect(inputAt).toBeGreaterThan(contextAt);
		expect(JSON.parse(p.slice(inputAt + "Input:\n".length))).toEqual([{ id: "0", text: "Next." }]);
	});
});

describe("stripCodeFences / extractJsonArray", () => {
	it("removes json fences", () => {
		expect(stripCodeFences('```json\n[{"id":"0"}]\n```')).toBe('[{"id":"0"}]');
	});
	it("pulls an array out of surrounding prose", () => {
		expect(extractJsonArray('Sure! [{"id":"0","text":"a"}] done')).toBe('[{"id":"0","text":"a"}]');
	});
	it("returns null when there is no array", () => {
		expect(extractJsonArray("no json here")).toBeNull();
	});
});

describe("parseGenericResponse", () => {
	it("maps by id regardless of order", () => {
		const out = parseGenericResponse('[{"id":"1","text":"drugo"},{"id":"0","text":"prvo"}]', 2);
		expect(out).toEqual(["prvo", "drugo"]);
	});
	it("marks dropped ids as null", () => {
		const out = parseGenericResponse('[{"id":"0","text":"prvo"}]', 2);
		expect(out).toEqual(["prvo", null]);
	});
	it("ignores out-of-range and malformed rows", () => {
		const out = parseGenericResponse('[{"id":"9","text":"x"},{"id":"0"},{"foo":1}]', 1);
		expect(out).toEqual([null]);
	});
	it("accepts numeric ids and fenced output", () => {
		const out = parseGenericResponse('```json\n[{"id":0,"text":"a"},{"id":1,"text":"b"}]\n```', 2);
		expect(out).toEqual(["a", "b"]);
	});
});

describe("repairJsonEscapes / lenient parsing", () => {
	// Simulates DeepSeek writing the ASS break raw: `\N` instead of `\\N`.
	const badJson = '[{"id":"0","text":"got a job \\Nat a firm"},{"id":"1","text":"ok"}]'.replace("\\N", "\\\u004E");

	it("raw \\N breaks strict JSON.parse", () => {
		// Build the invalid string explicitly: backslash + N inside a JSON string.
		const invalid = '[{"id":"0","text":"a \\' + 'Nb"}]';
		expect(() => JSON.parse(invalid)).toThrow();
		expect(JSON.parse(repairJsonEscapes(invalid))[0].text).toBe("a \\Nb");
	});

	it("leaves valid escapes untouched", () => {
		const valid = '[{"id":"0","text":"quote \\" newline \\n break \\\\N"}]';
		expect(repairJsonEscapes(valid)).toBe(valid);
	});

	it("parseGenericResponse recovers a batch with raw \\N escapes", () => {
		const invalid = '[{"id":"0","text":"prva \\' + 'Ndruga"},{"id":"1","text":"ok"}]';
		const out = parseGenericResponse(invalid, 2);
		expect(out).toEqual(["prva \\Ndruga", "ok"]);
	});
});
