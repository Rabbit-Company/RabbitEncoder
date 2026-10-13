import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { filmGrainSegmentCount, writeEncoderFilmGrainTable } from "../../src/video/film-grain-table";

const dir = mkdtempSync(join(tmpdir(), "rabbit-film-grain-"));
afterEach(() => {
	for (const name of ["source.tbl", "encoder.tbl"]) rmSync(join(dir, name), { force: true });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("encoder table uses one representative segment over the whole video", () => {
	const source = join(dir, "source.tbl");
	const encoder = join(dir, "encoder.tbl");
	writeFileSync(source, "filmgrn1\nE 0 10000000 1 101 1\n\tp first\nE 10000000 20000000 1 102 1\n\tp second\nE 20000000 30000000 1 103 1\n\tp third\n");
	expect(filmGrainSegmentCount(source)).toBe(3);
	expect(writeEncoderFilmGrainTable(source, encoder)).toBe(3);
	expect(readFileSync(encoder, "utf8")).toBe("filmgrn1\nE 0 18446744073709551615 1 102 1\n\tp second\n");
});

test("encoder table rejects an empty diff", () => {
	const source = join(dir, "source.tbl");
	writeFileSync(source, "filmgrn1\n");
	expect(() => writeEncoderFilmGrainTable(source, join(dir, "encoder.tbl"))).toThrow("no segments");
});
