import { describe, expect, it } from "bun:test";
import { planSubtitleTracks, subtitleFlagArgs } from "../../src/tracks/subtitle-plan";
import type { SubtitleStreamInfo } from "../../src/core/types";

let nextIndex = 0;
function stream(language: string, title: string, over: Partial<SubtitleStreamInfo> = {}): SubtitleStreamInfo {
	return { index: nextIndex++, codec: "ass", language, title, ...over };
}

const plan = (streams: SubtitleStreamInfo[], renameTracks = true) => planSubtitleTracks(streams, { renameTracks });
const byTitle = (streams: SubtitleStreamInfo[], renameTracks = true) => new Map(plan(streams, renameTracks).map((track) => [track.trackName, track]));

describe("planSubtitleTracks", () => {
	it("makes one track default per language group", () => {
		const planned = plan([stream("eng", "Full Subtitles"), stream("eng", "Full Subtitles [Other]"), stream("jpn", "Full Subtitles")]);

		expect(planned.map((track) => track.isDefault)).toEqual([true, false, true]);
	});

	it("prefers a full track over SDH for the default of its language", () => {
		const planned = byTitle([stream("eng", "SDH"), stream("eng", "Full Subtitles")]);

		expect(planned.get("Full Subtitles")!.isDefault).toBe(true);
		expect(planned.get("SDH")!.isDefault).toBe(false);
		expect(planned.get("SDH")!.isHearingImpaired).toBe(true);
	});

	it("makes SDH the default when it is the only track for a language", () => {
		const [sdh] = plan([stream("eng", "SDH")]);

		expect(sdh!.isDefault).toBe(true);
		expect(sdh!.isHearingImpaired).toBe(true);
	});

	it("flags one forced track per language and drops a second", () => {
		const planned = plan([stream("eng", "Signs & Songs"), stream("eng", "Signs & Songs [Dup]"), stream("jpn", "Signs & Songs")]);

		expect(planned).toHaveLength(2);
		expect(planned.map((track) => [track.effectiveLang, track.isForced, track.isDefault])).toEqual([
			["eng", true, false],
			["jpn", true, false],
		]);
	});

	it("relabels honorifics as en-JP and makes it default", () => {
		const [honorifics] = plan([stream("eng", "Honorifics")]);

		expect(honorifics!.effectiveLang).toBe("en-JP");
		expect(honorifics!.isDefault).toBe(true);
	});

	it("flags commentary without making it default", () => {
		const [commentary] = plan([stream("eng", "Commentary")]);

		expect(commentary!.isCommentary).toBe(true);
		expect(commentary!.isDefault).toBe(false);
	});

	it("carries the original-language flag through", () => {
		const [track] = plan([stream("jpn", "Full Subtitles", { isOriginal: true })]);

		expect(track!.isOriginal).toBe(true);
	});

	it("renames tracks by type, keeping the release group", () => {
		expect(plan([stream("eng", "English")])[0]!.trackName).toBe("Full Subtitles");
		expect(plan([stream("eng", "Dialogue [SubsMix]")])[0]!.trackName).toBe("Full Subtitles [SubsMix]");
	});

	it("keeps the source title when renaming is off", () => {
		expect(plan([stream("eng", "English")], false)[0]!.trackName).toBe("English");
	});

	it("keeps a storyboard track and leaves its flags to the source", () => {
		const planned = plan([stream("eng", "Storyboard", { isDefault: true })]);

		expect(planned).toHaveLength(1);
		expect(planned[0]!.applyFlags).toBe(false);
		expect(planned[0]!.isDefault).toBe(true); // whatever the source said
		expect(subtitleFlagArgs(planned[0]!)).toEqual([]); // so the mux does not rewrite them
	});
});

describe("subtitleFlagArgs", () => {
	it("emits every flag for the track being muxed", () => {
		const [full] = plan([stream("jpn", "Full Subtitles", { isOriginal: true })]);

		expect(subtitleFlagArgs(full!)).toEqual([
			"--default-track-flag",
			"0:1",
			"--forced-display-flag",
			"0:0",
			"--hearing-impaired-flag",
			"0:0",
			"--commentary-flag",
			"0:0",
			"--original-flag",
			"0:1",
		]);
	});

	it("targets the requested track id", () => {
		const [sdh] = plan([stream("eng", "SDH")]);

		expect(subtitleFlagArgs(sdh!, 3).filter((arg) => arg.startsWith("3:"))).toHaveLength(5);
	});
});
