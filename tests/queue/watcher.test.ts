import { describe, expect, it } from "bun:test";
import { isRabbitToolFile } from "../../src/queue/watcher";

describe("isRabbitToolFile", () => {
	it("skips the staging files and copies Rabbit's tools write", () => {
		for (const name of [
			".rabbit-repair-ab12cd34.mkv",
			".rabbit-audio-ab12cd34.mkv",
			"Show - S01E01.repaired.mkv",
			"Show - S01E01.audio.mkv",
			"Show - S01E01.audio (2).mkv",
			"Season 1/Show - S01E01.subtitles-edited.mkv",
		])
			expect(isRabbitToolFile(name)).toBe(true);
	});

	it("keeps ordinary videos", () => {
		for (const name of ["Show - S01E01.mkv", "Show.Audio.Description.S01E01.mkv", "repaired.mkv", "Show.audio.mp4", ".hidden.mkv"])
			expect(isRabbitToolFile(name)).toBe(false);
	});
});
