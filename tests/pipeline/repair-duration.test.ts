import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { run } from "../../src/core/process";
import { durationSeconds, identifyMatroska } from "../../src/pipeline/repair";
import { retimeDocument, IDENTITY_MAP, dialogueCues } from "../../src/subsearch/cues";

const hasTools = ["ffmpeg", "mkvmerge"].every((tool) => Bun.which(tool));

describe("retimeDocument with the video's length", () => {
	it("drops cues after the end and cuts the ones running past it", () => {
		const srt = "1\n00:00:05,000 --> 00:00:07,000\nIn\n\n2\n00:00:19,000 --> 00:00:23,000\nAcross\n\n3\n00:01:00,000 --> 00:01:02,000\nAfter\n";
		const out = retimeDocument({ format: "srt", content: srt }, IDENTITY_MAP, 20_000);
		expect(dialogueCues(out)).toEqual([
			{ startMs: 5000, endMs: 7000, text: "In" },
			{ startMs: 19000, endMs: 20000, text: "Across" },
		]);
	});
});

(hasTools ? describe : describe.skip)("repair duration check", () => {
	const root = mkdtempSync(join(tmpdir(), "rabbit-duration-"));
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it("measures the video and audio, not a subtitle that runs past them", async () => {
		writeFileSync(join(root, "late.srt"), "1\n00:01:00,000 --> 00:01:02,000\nCredits\n");
		await run([
			"ffmpeg",
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"color=c=gray:s=32x32:r=1:d=20",
			"-f",
			"lavfi",
			"-i",
			"anullsrc=r=8000:cl=mono:d=20",
			"-c:v",
			"ffv1",
			"-c:a",
			"flac",
			"-t",
			"20",
			join(root, "plain.mkv"),
		]);
		await run(["mkvmerge", "-q", "-o", join(root, "with-late-sub.mkv"), join(root, "plain.mkv"), join(root, "late.srt")]);
		const withSub = await identifyMatroska(join(root, "with-late-sub.mkv"));
		const plain = await identifyMatroska(join(root, "plain.mkv"));
		// The subtitle stretches the file to a minute, which made removing it look like lost video.
		expect((withSub.container?.properties?.duration ?? 0) / 1e9).toBeGreaterThan(60);
		expect(Math.abs(durationSeconds(withSub) - durationSeconds(plain))).toBeLessThan(1);
		expect(durationSeconds(plain)).toBeCloseTo(20, 0);
	}, 30_000);
});
