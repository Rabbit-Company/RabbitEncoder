import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../../src/core/types";
import { jobOutputRoot, outputRoots } from "../../src/pipeline/output";

const config = { outputDir: "/data/output", libraryDirs: ["/Animes", "/Movies/"] } as AppConfig;

describe("job output root", () => {
	test("offers the output folder first, then the library folders", () => {
		expect(outputRoots(config)).toEqual(["/data/output", "/Animes", "/Movies"]);
	});

	test("writes into a chosen library folder", () => {
		expect(jobOutputRoot({ outputRoot: "/Animes" }, config)).toBe("/Animes");
		expect(jobOutputRoot({ outputRoot: "/Movies" }, config)).toBe("/Movies");
	});

	test("falls back to the output folder when the folder is not configured any more", () => {
		expect(jobOutputRoot({}, config)).toBe("/data/output");
		expect(jobOutputRoot({ outputRoot: "/Shows" }, config)).toBe("/data/output");
		expect(jobOutputRoot({ outputRoot: "/Animes/../etc" }, config)).toBe("/data/output");
	});
});
