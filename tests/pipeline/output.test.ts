import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AppConfig, Job } from "../../src/core/types";
import { copyFileWithProgress, finalizeOutput, formatTransferDetail, formatTransferRate, stageFileWithProgress } from "../../src/pipeline/output";

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

describe("output transfer progress", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "rabbit-transfer-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test("reports bytes and publishes the destination after a successful copy", async () => {
		const source = join(root, "source.mkv");
		const destination = join(root, "output.mkv");
		const data = Buffer.alloc(256 * 1024, 42);
		writeFileSync(source, data);
		chmodSync(source, 0o640);
		const modifiedAt = new Date("2024-01-01T00:00:00Z");
		utimesSync(source, modifiedAt, modifiedAt);
		const updates: Array<[number, number, boolean]> = [];

		await copyFileWithProgress(source, destination, undefined, (copied, total, finished) => {
			if (!finished) expect(existsSync(destination)).toBe(false);
			updates.push([copied, total, finished]);
		});

		expect(readFileSync(destination)).toEqual(data);
		expect(statSync(destination).mode & 0o777).toBe(0o640);
		expect(statSync(destination).mtime.getTime()).toBe(modifiedAt.getTime());
		expect(existsSync(source)).toBe(false);
		expect(updates[0]).toEqual([0, data.length, false]);
		expect(updates.at(-1)).toEqual([data.length, data.length, true]);
		expect(readdirSync(root)).toEqual(["output.mkv"]);
	});

	test("cancellation keeps the source and removes the incomplete destination", async () => {
		const source = join(root, "source.mkv");
		const destination = join(root, "output.mkv");
		writeFileSync(source, Buffer.alloc(256 * 1024, 42));
		const controller = new AbortController();

		await expect(
			copyFileWithProgress(source, destination, controller.signal, (copied) => {
				if (copied > 0) controller.abort();
			}),
		).rejects.toHaveProperty("name", "CancelledError");

		expect(existsSync(source)).toBe(true);
		expect(existsSync(destination)).toBe(false);
		expect(readdirSync(root)).toEqual(["source.mkv"]);
	});

	test("staging keeps the original source available", async () => {
		const source = join(root, "source.mkv");
		const destination = join(root, "local.mkv");
		writeFileSync(source, "video and audio");

		await stageFileWithProgress(source, destination);

		expect(readFileSync(source, "utf-8")).toBe("video and audio");
		expect(readFileSync(destination, "utf-8")).toBe("video and audio");
	});

	test("shows transfer speeds in decimal megabits and gigabits per second", () => {
		expect(formatTransferRate(12_500_000)).toBe("100.0 Mbps");
		expect(formatTransferRate(156_250_000)).toBe("1.25 Gbps");
		expect(formatTransferDetail("Writing output", 524_288, 1_048_576, 12_500_000)).toBe("Writing output 512.00 KiB / 1.00 MiB (100.0 Mbps)");
		expect(formatTransferDetail("Downloading source", 0, 1_048_576)).toBe("Downloading source 0.00 B / 1.00 MiB");
	});
});
