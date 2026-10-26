import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { browseFolder } from "../../src/queue/library";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("library browsing", () => {
	it("skips recursive folder counts while showing visible file sizes and encoded status", () => {
		const root = mkdtempSync(join(tmpdir(), "rabbit-library-"));
		roots.push(root);
		const series = join(root, "Series");
		mkdirSync(join(series, "Season 1"), { recursive: true });
		writeFileSync(join(series, "Season 1", "Episode 1.mkv"), "video");
		writeFileSync(join(root, "Movie-RabbitCompany.mkv"), "video");

		const entries = browseFolder(root, "RabbitCompany");
		expect(entries[0]).toEqual({ name: "Series", path: series, type: "directory" });
		expect(entries[1]).toEqual({ name: "Movie-RabbitCompany.mkv", path: join(root, "Movie-RabbitCompany.mkv"), type: "file", size: 5, encoded: true });
	});

	it("counts nested videos and encoded files when requested", () => {
		const root = mkdtempSync(join(tmpdir(), "rabbit-library-"));
		roots.push(root);
		const series = join(root, "Series");
		mkdirSync(join(series, "Season 1"), { recursive: true });
		writeFileSync(join(series, "Season 1", "Episode 1.mkv"), "video");
		writeFileSync(join(series, "Season 1", "Episode 2-RabbitCompany.mkv"), "video");

		expect(browseFolder(root, "RabbitCompany", true)).toEqual([{ name: "Series", path: series, type: "directory", videoCount: 2, encodedCount: 1 }]);
	});
});
