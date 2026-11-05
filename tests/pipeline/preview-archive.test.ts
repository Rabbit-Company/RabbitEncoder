import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AppConfig, PreviewSample, PreviewState } from "../../src/core/types";
import { previewArchiveEntries, previewDirFor } from "../../src/pipeline/preview-encoder";

describe("previewArchiveEntries", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "rabbit-preview-zip-"));
	afterAll(() => rmSync(tempDir, { recursive: true, force: true }));
	const config = { tempDir } as AppConfig;

	function sample(index: number, timestampSec: number, extra: Partial<PreviewSample> = {}): PreviewSample {
		const dir = join(previewDirFor(config, "job1"), `sample_${String(index).padStart(2, "0")}`);
		mkdirSync(dir, { recursive: true });
		for (const name of ["source.png", "encode.png", "ref_0.png", "vs_0.png"]) writeFileSync(join(dir, name), name);
		return {
			index,
			timestampSec,
			windowSeconds: 5,
			encodedSizeBytes: 0,
			encodedSizeHuman: "",
			projectedTotalBytes: 0,
			projectedTotalHuman: "",
			encodedBitrateKbps: 1500,
			vsFrames: [],
			prepareFrames: [],
			refFrames: [],
			...extra,
		};
	}

	it("names every still so they sort sample by sample in view order", () => {
		const state: PreviewState = {
			jobId: "job1",
			status: "done",
			progress: 100,
			currentDetail: "",
			references: [{ index: 0, path: "/m/orig.mkv", name: "orig.mkv", label: "Original" }],
			samples: [sample(1, 600), sample(0, 60, { refFrames: [0], vsFrames: [{ index: 0, presetId: "stock:x", bareId: "x", label: "F3K Deband" }] })],
			settingsFingerprint: "",
			sampleCount: 2,
			windowSeconds: 5,
			stillStyle: "standard",
		};
		const entries = previewArchiveEntries(config, state);
		expect(entries.map((e) => e.name)).toEqual([
			"01_1_Original.png",
			"01_2_Source.png",
			"01_3_F3K_Deband.png",
			"01_4_Encode.png",
			"02_1_Source.png",
			"02_2_Encode.png",
			"preview.txt",
		]);
		expect(new TextDecoder().decode(entries[0]!.data)).toBe("ref_0.png");
		const text = new TextDecoder().decode(entries.at(-1)!.data);
		expect(text).toContain("02. 0:10:00.000");
		expect(text).toContain("Stills: Comparison standard (thewiki.moe guide)");
	});
});
