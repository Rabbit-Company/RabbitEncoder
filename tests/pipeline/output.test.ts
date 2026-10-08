import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AppConfig, Job } from "../../src/core/types";
import { finalizeOutput } from "../../src/pipeline/output";

describe("finalizeOutput for library jobs", () => {
	let root: string;
	let library: string;
	let bin: string;
	let finished: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "rabbit-output-"));
		library = join(root, "Animes", "Show", "Season 1");
		bin = join(root, "recycle-bin");
		mkdirSync(library, { recursive: true });
		finished = join(root, "final.mkv");
		writeFileSync(finished, "encoded");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function libraryJob(filename: string): Job {
		const inputPath = join(library, filename);
		writeFileSync(inputPath, "original");
		return { id: "job", filename, inputPath, relativePath: "Season 1", replaceSource: true } as unknown as Job;
	}

	function config(recycleBinDir: string): AppConfig {
		return { outputDir: join(root, "output"), recycleBinDir } as unknown as AppConfig;
	}

	test("moves a renamed source into the recycle bin, mirroring its path", async () => {
		const job = libraryJob("Episode 1.mkv");
		const outputPath = await finalizeOutput(job, config(bin), finished, "Episode 1 [AV1].mkv");

		expect(outputPath).toBe(join(library, "Episode 1 [AV1].mkv"));
		expect(readFileSync(outputPath, "utf-8")).toBe("encoded");
		expect(existsSync(job.inputPath)).toBe(false);
		expect(readFileSync(join(bin, job.inputPath), "utf-8")).toBe("original");
	});

	test("recycles the source before overwriting it under the same name", async () => {
		const job = libraryJob("Episode 1.mkv");
		const outputPath = await finalizeOutput(job, config(bin), finished, "Episode 1.mkv");

		expect(outputPath).toBe(job.inputPath);
		expect(readFileSync(outputPath, "utf-8")).toBe("encoded");
		expect(readFileSync(join(bin, job.inputPath), "utf-8")).toBe("original");
	});

	test("never overwrites an original that is already in the recycle bin", async () => {
		const job = libraryJob("Episode 1.mkv");
		mkdirSync(join(bin, library), { recursive: true });
		writeFileSync(join(bin, job.inputPath), "older original");

		await finalizeOutput(job, config(bin), finished, "Episode 1.mkv");

		expect(readFileSync(join(bin, job.inputPath), "utf-8")).toBe("older original");
		expect(readFileSync(join(bin, library, "Episode 1 (2).mkv"), "utf-8")).toBe("original");
	});

	test("deletes the source when no recycle bin is configured", async () => {
		const job = libraryJob("Episode 1.mkv");
		await finalizeOutput(job, config(""), finished, "Episode 1 [AV1].mkv");

		expect(readdirSync(library)).toEqual(["Episode 1 [AV1].mkv"]);
		expect(existsSync(bin)).toBe(false);
	});
});
