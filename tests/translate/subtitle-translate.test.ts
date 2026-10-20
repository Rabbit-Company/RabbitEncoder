import { describe, expect, it, afterEach } from "bun:test";
import {
	alignReferences,
	alignSpeakers,
	fillSpeakers,
	planTargetLanguages,
	translateSubtitleContent,
	type KeptSubDescriptor,
} from "../../src/translate/subtitle-translate";

describe("planTargetLanguages", () => {
	const track = (index: number, language: string, trackType: string, codec = "ass"): KeptSubDescriptor => ({
		index,
		language,
		trackType,
		codec,
	});

	it("skips languages that already have a full or honorifics track", () => {
		const tracks = [track(0, "eng", "full"), track(1, "ger", "full"), track(2, "fre", "full")];
		const plan = planTargetLanguages(tracks, ["eng", "deu", "fra", "slv"]);
		expect(plan.productions.map((p) => p.target.code)).toEqual(["sl"]);
		expect(plan.productions[0]!.sourceIndex).toBe(0); // English source (top)
	});

	it("counts an existing Slovenian honorifics track as covering Slovenian", () => {
		const tracks = [track(0, "eng", "full"), track(1, "slv", "honorifics")];
		const plan = planTargetLanguages(tracks, ["slv"]);
		expect(plan.productions.length).toBe(0);
	});

	it("skips unsupported target languages with a note", () => {
		const tracks = [track(0, "eng", "full")];
		const plan = planTargetLanguages(tracks, ["tlh", "slv"]);
		expect(plan.productions.map((p) => p.target.code)).toEqual(["sl"]);
		expect(plan.skipped.some((s) => s.startsWith("tlh"))).toBe(true);
	});

	it("does not translate the source language into itself", () => {
		const tracks = [track(0, "eng", "full")];
		const plan = planTargetLanguages(tracks, ["eng", "slv"]);
		expect(plan.productions.map((p) => p.target.code)).toEqual(["sl"]);
	});
});

describe("planTargetLanguages — forced source", () => {
	const track = (index: number, language: string, trackType: string, codec = "ass"): KeptSubDescriptor => ({ index, language, trackType, codec });

	it("honors a forced source track over auto selection", () => {
		const tracks = [track(0, "eng", "full"), track(1, "jpn", "full")];
		const plan = planTargetLanguages(tracks, ["slv"], { forceSourceIndex: 1 });
		expect(plan.productions[0]!.sourceIndex).toBe(1);
	});

	it("falls back to auto when the forced index does not exist", () => {
		const tracks = [track(0, "eng", "full")];
		const plan = planTargetLanguages(tracks, ["slv"], { forceSourceIndex: 9 });
		expect(plan.productions[0]!.sourceIndex).toBe(0);
		expect(plan.skipped.some((s) => s.includes("not found"))).toBe(true);
	});

	it("falls back to auto when the forced track is image-based", () => {
		const tracks = [track(0, "eng", "full"), track(1, "eng", "full", "hdmv_pgs_subtitle")];
		const plan = planTargetLanguages(tracks, ["slv"], { forceSourceIndex: 1 });
		expect(plan.productions[0]!.sourceIndex).toBe(0);
		expect(plan.skipped.some((s) => s.includes("not text-based"))).toBe(true);
	});

	it("produces a full track when forcing a non-dialogue source", () => {
		const tracks = [track(0, "eng", "sdh")];
		const plan = planTargetLanguages(tracks, ["slv"], { forceSourceIndex: 0 });
		expect(plan.productions[0]!.trackType).toBe("full");
	});

	it("still skips the forced source's own language as a target", () => {
		const tracks = [track(0, "eng", "full"), track(1, "deu", "full")];
		const plan = planTargetLanguages(tracks, ["deu", "slv"], { forceSourceIndex: 1 });
		expect(plan.productions.map((p) => p.target.code)).toEqual(["sl"]);
	});
});

describe("context between chunks", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	const srt = [
		"1",
		"00:00:01,000 --> 00:00:02,000",
		"One",
		"",
		"2",
		"00:00:03,000 --> 00:00:04,000",
		"Two",
		"",
		"3",
		"00:00:05,000 --> 00:00:06,000",
		"Three",
		"",
	].join("\n");

	async function run(contextLines: number): Promise<string[]> {
		const prompts: string[] = [];
		globalThis.fetch = (async (_url: string, init: any) => {
			const prompt: string = JSON.parse(init.body).messages[0].content;
			prompts.push(prompt);
			const rows = JSON.parse(prompt.slice(prompt.indexOf("Input:\n") + 7)) as Array<{ id: string; text: string }>;
			const content = JSON.stringify(rows.map((r) => ({ id: r.id, text: r.text.toUpperCase() })));
			return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
		}) as unknown as typeof fetch;
		const out = await translateSubtitleContent(srt, {
			format: "srt",
			batchSize: 2,
			translateSignsSongs: true,
			contextLines,
			llm: {
				provider: "openai",
				baseUrl: "http://localhost:11434/v1",
				model: "m",
				source: { name: "English", code: "en" },
				target: { name: "Slovenian", code: "sl" },
			},
		});
		expect(out).toContain("THREE");
		return prompts;
	}

	it("sends the previous chunk's last lines with their translations", async () => {
		const prompts = await run(1);
		expect(prompts.length).toBe(2);
		expect(prompts[0]).not.toContain("Previous lines");
		expect(prompts[1]).toContain('[{"text":"Two","translation":"TWO"}]');
	});

	it("sends no context when turned off", async () => {
		const prompts = await run(0);
		expect(prompts.every((p) => !p.includes("Previous lines"))).toBe(true);
	});
});

describe("alignReferences", () => {
	const line = (startMs: number, endMs: number, text: string) => ({ startMs, endMs, text });

	it("matches lines with the same timing", () => {
		expect(alignReferences([line(1000, 3000, "")], [line(1000, 3000, "Привет.")])).toEqual(["Привет."]);
	});

	it("joins a reference split into two lines", () => {
		expect(alignReferences([line(1000, 5000, "")], [line(1000, 3000, "Я была"), line(3000, 5000, "там.")])).toEqual(["Я была там."]);
	});

	it("gives a merged reference line to both source lines", () => {
		const ref = [line(1000, 5000, "Я устала, пойдём домой.")];
		expect(alignReferences([line(1000, 3000, ""), line(3000, 5000, "")], ref)).toEqual(["Я устала, пойдём домой.", "Я устала, пойдём домой."]);
	});

	it("ignores a neighbour that only grazes the line, and lines with no reference", () => {
		const ref = [line(0, 1100, "Нет."), line(1100, 2900, "Да."), line(2900, 4500, "Потом."), line(9000, 9500, "Позже.")];
		expect(alignReferences([line(1000, 3000, ""), line(5000, 6000, "")], ref)).toEqual(["Да.", undefined]);
	});

	it("strips tags and line breaks", () => {
		expect(alignReferences([line(0, 1000, "")], [line(0, 1000, "{\\i1}Я\\Nбыла{\\i0}")])).toEqual(["Я была"]);
	});
});

describe("reference tracks", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	const srt = ["1", "00:00:01,000 --> 00:00:03,000", "I was there.", "", "2", "00:00:04,000 --> 00:00:06,000", "Thanks.", ""].join("\n");
	const RU = { name: "Russian", code: "ru" };

	async function run(lines: Array<{ startMs: number; endMs: number; text: string }>): Promise<string> {
		let prompt = "";
		globalThis.fetch = (async (_url: string, init: any) => {
			prompt = JSON.parse(init.body).messages[0].content;
			const rows = JSON.parse(prompt.slice(prompt.indexOf("Input:\n") + 7)) as Array<{ id: string; text: string }>;
			const content = JSON.stringify(rows.map((r) => ({ id: r.id, text: r.text })));
			return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
		}) as unknown as typeof fetch;
		await translateSubtitleContent(srt, {
			format: "srt",
			batchSize: 10,
			translateSignsSongs: true,
			references: [{ lang: RU, lines }],
			llm: {
				provider: "openai",
				baseUrl: "http://localhost:11434/v1",
				model: "m",
				source: { name: "English", code: "en" },
				target: { name: "Slovenian", code: "sl" },
			},
		});
		return prompt;
	}

	it("attaches matched lines and explains them", async () => {
		const prompt = await run([
			{ startMs: 1000, endMs: 3000, text: "Я была там." },
			{ startMs: 4000, endMs: 6000, text: "Спасибо." },
		]);
		expect(prompt).toContain("Russian subtitles of this release");
		const rows = JSON.parse(prompt.slice(prompt.indexOf("Input:\n") + 7));
		expect(rows[0]).toEqual({ id: "0", text: "I was there.", refs: { Russian: "Я была там." } });
		expect(rows[1].refs).toEqual({ Russian: "Спасибо." });
	});

	it("drops a reference that is out of sync", async () => {
		const prompt = await run([
			{ startMs: 60000, endMs: 62000, text: "Я была там." },
			{ startMs: 63000, endMs: 65000, text: "Спасибо." },
		]);
		expect(prompt).not.toContain("refs");
		expect(prompt).not.toContain("Russian");
	});
});

describe("speaker names from other tracks", () => {
	const named = (startMs: number, endMs: number, name: string) => ({ startMs, endMs, text: "x", name });

	it("takes the one speaker at the same moment and refuses when two speakers overlap", () => {
		const donor = [named(1000, 3000, "Loid"), named(4000, 5000, "Yor"), named(5000, 6000, "Anya")];
		expect(
			alignSpeakers(
				[
					{ startMs: 1000, endMs: 3000 },
					{ startMs: 4000, endMs: 6000 },
					{ startMs: 8000, endMs: 9000 },
				],
				donor,
			),
		).toEqual(["Loid", undefined, undefined]);
	});

	it("keeps existing speakers and falls through to later donors", () => {
		const lines: Array<{ startMs: number; endMs: number; name?: string }> = [
			{ startMs: 1000, endMs: 3000, name: "Twilight" },
			{ startMs: 4000, endMs: 5000 },
			{ startMs: 6000, endMs: 7000 },
		];
		const filled = fillSpeakers(lines, [[named(1000, 3000, "Loid"), named(4000, 5000, "Yor")], [named(6000, 7000, "Аня")]]);
		expect(filled).toBe(2);
		expect(lines.map((l) => l.name)).toEqual(["Twilight", "Yor", "Аня"]);
	});

	it("sends borrowed names to the model", async () => {
		const realFetch = globalThis.fetch;
		let prompt = "";
		globalThis.fetch = (async (_url: string, init: any) => {
			prompt = JSON.parse(init.body).messages[0].content;
			const rows = JSON.parse(prompt.slice(prompt.indexOf("Input:\n") + 7)) as Array<{ id: string; text: string }>;
			return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(rows.map((r) => ({ id: r.id, text: r.text }))) } }] }), {
				status: 200,
			});
		}) as unknown as typeof fetch;
		try {
			await translateSubtitleContent(["1", "00:00:01,000 --> 00:00:03,000", "I'm home.", ""].join("\n"), {
				format: "srt",
				batchSize: 10,
				translateSignsSongs: true,
				speakerDonors: [[named(1000, 3000, "Loid")]],
				llm: {
					provider: "openai",
					baseUrl: "http://localhost:11434/v1",
					model: "m",
					source: { name: "English", code: "en" },
					target: { name: "Slovenian", code: "sl" },
				},
			});
		} finally {
			globalThis.fetch = realFetch;
		}
		expect(JSON.parse(prompt.slice(prompt.indexOf("Input:\n") + 7))).toEqual([{ id: "0", name: "Loid", text: "I'm home." }]);
	});
});
