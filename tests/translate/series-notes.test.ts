import { describe, expect, it, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildTranscript, loadSeriesNotes, mergeNotes, prepareSeriesNotes, seriesKey, seriesTitleFromFilename } from "../../src/translate/series-notes";

const EN = { name: "English", code: "en" };

describe("seriesTitleFromFilename", () => {
	it("handles common release names", () => {
		expect(seriesTitleFromFilename("Oshi no Ko (2023) - S03E01 - Down Bad [Bluray-1080p][Source][FFV1]-RabbitCompany.mkv")).toBe("Oshi no Ko");
		expect(seriesTitleFromFilename("Oshi.no.Ko.S03E01.1080p.BluRay.Dual-Audio.Opus.2.0.x265-YURASUKA.mkv")).toBe("Oshi no Ko");
		expect(seriesTitleFromFilename("[sam] Dr. STONE - New World - 19 [BD 1080p FLAC] [7446B090].mkv")).toBe("Dr. STONE - New World");
		expect(seriesTitleFromFilename("[Group] Show Name - 03v2 [1080p].mkv")).toBe("Show Name");
		expect(seriesTitleFromFilename("Show 1x05 Title.mkv")).toBe("Show");
	});

	it("keeps a movie name whole and rejects names with nothing left", () => {
		expect(seriesTitleFromFilename("Your Name (2016) [BD 1080p].mkv")).toBe("Your Name");
		expect(seriesTitleFromFilename("[Group] [1080p].mkv")).toBeNull();
	});

	it("gives the same key across seasons and spellings", () => {
		const a = seriesKey(seriesTitleFromFilename("Oshi no Ko (2023) - S01E01.mkv")!);
		const b = seriesKey(seriesTitleFromFilename("Oshi.No.Ko.S03E05.mkv")!);
		expect(a).toBe("oshi-no-ko");
		expect(b).toBe(a);
	});
});

describe("mergeNotes", () => {
	const existing = [
		"Characters:",
		"- Ai: female; adult; idol",
		"",
		"Forms of address:",
		"- Ai -> Aqua: informal, mother and son",
		"",
		"Terms:",
		"- B-Komachi: idol group",
	].join("\n");

	it("adds new bullets to the end of their section", () => {
		const out = mergeNotes(existing, "Characters:\n- Kana: female; teenage; actress\n\nTerms:\n- Strawberry Productions: talent agency");
		expect(out).toBe(
			[
				"Characters:",
				"- Ai: female; adult; idol",
				"- Kana: female; teenage; actress",
				"",
				"Forms of address:",
				"- Ai -> Aqua: informal, mother and son",
				"",
				"Terms:",
				"- B-Komachi: idol group",
				"- Strawberry Productions: talent agency",
			].join("\n"),
		);
	});

	it("never overwrites an existing entry", () => {
		expect(mergeNotes(existing, "Characters:\n- Ai: male; child")).toBe(existing);
		expect(mergeNotes(existing, "NONE")).toBe(existing);
	});

	it("appends a missing section", () => {
		const out = mergeNotes("Characters:\n- Ai: female", "## Terms\n- Idol: performer");
		expect(out).toBe("Characters:\n- Ai: female\n\nTerms:\n- Idol: performer");
	});
});

describe("buildTranscript", () => {
	it("strips tags and line breaks and keeps speaker names", () => {
		expect(buildTranscript([{ name: "Ai", text: "{\\i1}Hello{\\i0}\\Nthere" }, { text: "  " }, { text: "Bye" }])).toBe("Ai: Hello there\nBye");
	});
});

describe("prepareSeriesNotes", () => {
	const realFetch = globalThis.fetch;
	let dir = "";
	afterEach(() => {
		globalThis.fetch = realFetch;
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	function mockReplies(replies: string[], prompts: string[]) {
		globalThis.fetch = (async (_url: string, init: any) => {
			prompts.push(JSON.parse(init.body).messages[0].content);
			return new Response(JSON.stringify({ choices: [{ message: { content: replies.shift() ?? "NONE" } }] }), { status: 200 });
		}) as unknown as typeof fetch;
	}

	const llm = { provider: "openai" as const, baseUrl: "http://localhost:11434/v1", model: "m", attempts: 1 };

	it("creates notes once, extends them with later episodes, and skips episodes it has seen", async () => {
		dir = mkdtempSync(join(tmpdir(), "series-notes-"));
		const prompts: string[] = [];
		mockReplies(["Characters:\n- Ai: female; adult; idol", "Characters:\n- Kana: female; teenage; actress"], prompts);

		const lines = [{ name: "Ai", text: "Hello." }];
		const first = await prepareSeriesNotes({ dir, filename: "Show - S01E01.mkv", source: EN, lines, llm });
		expect(first).toBe("Characters:\n- Ai: female; adult; idol");
		expect(prompts[0]).toContain('series "Show"');

		const second = await prepareSeriesNotes({ dir, filename: "Show - S01E02.mkv", source: EN, lines, llm });
		expect(second).toBe("Characters:\n- Ai: female; adult; idol\n- Kana: female; teenage; actress");
		expect(prompts[1]).toContain("Existing notes:");

		const again = await prepareSeriesNotes({ dir, filename: "Show - S01E02.mkv", source: EN, lines, llm });
		expect(again).toBe(second);
		expect(prompts.length).toBe(2);
		expect(loadSeriesNotes(dir, "show")?.episodes).toEqual(["Show - S01E01.mkv", "Show - S01E02.mkv"]);
	});

	it("keeps going without notes when the request fails", async () => {
		dir = mkdtempSync(join(tmpdir(), "series-notes-"));
		globalThis.fetch = (async () => new Response("{}", { status: 400 })) as unknown as typeof fetch;
		const notes = await prepareSeriesNotes({ dir, filename: "Show - 01.mkv", source: EN, lines: [{ text: "Hi" }], llm });
		expect(notes).toBeUndefined();
		expect(loadSeriesNotes(dir, "show")).toBeNull();
	});
});
