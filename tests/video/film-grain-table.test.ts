import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { filmGrainSegmentCount, writeEncoderFilmGrainTable, writeRepresentativeFilmGrainTable } from "../../src/video/film-grain-table";

const dir = mkdtempSync(join(tmpdir(), "rabbit-film-grain-"));
afterEach(() => {
	for (const name of ["source.tbl", "encoder.tbl"]) rmSync(join(dir, name), { force: true });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Three scenes: 0-1 s, 1-2 s, and 2 s to the end as regrain diff writes it.
const THREE_SCENES = "filmgrn1\nE 0 10000000 1 101 1\n\tp first\nE 10000000 20000000 1 102 1\n\tp second\nE 20000000 9223372036854775807 1 103 1\n\tp third\n";

test("encoder table keeps every segment and leaves the last one open", () => {
	const source = join(dir, "source.tbl");
	const encoder = join(dir, "encoder.tbl");
	writeFileSync(source, THREE_SCENES);
	expect(filmGrainSegmentCount(source)).toBe(3);
	expect(writeEncoderFilmGrainTable(source, encoder)).toBe(3);
	expect(readFileSync(encoder, "utf8")).toBe(
		"filmgrn1\nE 0 10000000 1 101 1\n\tp first\nE 10000000 20000000 1 102 1\n\tp second\nE 20000000 18446744073709551615 1 103 1\n\tp third\n",
	);
});

test("encoder table moves segments back to where a preview clip starts", () => {
	const source = join(dir, "source.tbl");
	const encoder = join(dir, "encoder.tbl");
	writeFileSync(source, THREE_SCENES);
	writeEncoderFilmGrainTable(source, encoder, 1.25);
	expect(readFileSync(encoder, "utf8")).toBe("filmgrn1\nE 0 7500000 1 102 1\n\tp second\nE 7500000 18446744073709551615 1 103 1\n\tp third\n");
	writeEncoderFilmGrainTable(source, encoder, 600);
	expect(readFileSync(encoder, "utf8")).toBe("filmgrn1\nE 0 18446744073709551615 1 103 1\n\tp third\n");
});

test("representative table uses the middle segment over the whole video", () => {
	const source = join(dir, "source.tbl");
	const encoder = join(dir, "encoder.tbl");
	writeFileSync(source, THREE_SCENES);
	expect(writeRepresentativeFilmGrainTable(source, encoder)).toBe(3);
	expect(readFileSync(encoder, "utf8")).toBe("filmgrn1\nE 0 18446744073709551615 1 102 1\n\tp second\n");
	expect(filmGrainSegmentCount(encoder)).toBe(1);
});

test("an empty table stays empty", () => {
	const source = join(dir, "source.tbl");
	const encoder = join(dir, "encoder.tbl");
	writeFileSync(source, "filmgrn1\n");
	expect(filmGrainSegmentCount(source)).toBe(0);
	expect(writeEncoderFilmGrainTable(source, encoder)).toBe(0);
	expect(readFileSync(encoder, "utf8")).toBe("filmgrn1\n");
	expect(writeRepresentativeFilmGrainTable(source, encoder)).toBe(0);
	expect(readFileSync(encoder, "utf8")).toBe("filmgrn1\n");
});
