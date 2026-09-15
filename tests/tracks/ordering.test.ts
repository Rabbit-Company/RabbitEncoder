import { describe, expect, it } from "bun:test";
import { orderOutputSubtitles, type NativeEmitItem, type TranslatedEmitItem } from "../../src/translate/translate-step";
import {
	buildSubtitleTrackName,
	deduplicateSubtitleStreams,
	detectSubtitleTrackType,
	hasExplicitFullSubtitleTitle,
	sortSubtitleStreams,
} from "../../src/tracks/tracks";
import type { SubtitleStreamInfo } from "../../src/core/types";

const emit = (language: string, trackName: string, file: string) => ({
	language,
	trackName,
	flagArgs: ["--default-track-flag", "0:1"],
	file,
});

describe("organization attribution", () => {
	it("stamps the organization as the release group, not the source group", () => {
		expect(buildSubtitleTrackName("full", "English (SubsPlease)", "RabbitCompany")).toBe("Full Subtitles [RabbitCompany]");
		expect(buildSubtitleTrackName("honorifics", undefined, "RabbitCompany")).toBe("Full Subtitles (Honorifics) [RabbitCompany]");
	});
});

describe("safe subtitle type inference", () => {
	it("treats an explicit Full/Dialogue title as authoritative", () => {
		expect(hasExplicitFullSubtitleTitle("Full Subtitles [sam]")).toBe(true);
		expect(hasExplicitFullSubtitleTitle("Dialogue @ GJM")).toBe(true);
		expect(hasExplicitFullSubtitleTitle("Signs/Songs [sam]")).toBe(false);
		expect(detectSubtitleTrackType({ index: 3, codec: "ass", language: "eng", title: "Full Subtitles [sam]", isForced: true })).toBe("full");
	});

	it("never deduplicates away a track whose forced type came from content inference", () => {
		const inferred: SubtitleStreamInfo = {
			index: 4,
			codec: "ass",
			language: "eng",
			title: "English",
			isForced: true,
			signsSongsDetected: true,
		};
		const explicit: SubtitleStreamInfo = { index: 6, codec: "ass", language: "eng", title: "Signs/Songs [sam]" };
		expect(deduplicateSubtitleStreams([inferred, explicit]).map((s) => s.index)).toEqual([4, 6]);
		expect(deduplicateSubtitleStreams([explicit, inferred]).map((s) => s.index)).toEqual([6, 4]);
	});
});

describe("orderOutputSubtitles", () => {
	const stream = (index: number, language: string, title = ""): SubtitleStreamInfo => ({ index, codec: "ass", language, title });

	const sorter = (langPriority: string[]) => (streams: SubtitleStreamInfo[]) => sortSubtitleStreams(streams, { languagePriority: langPriority });

	it("interleaves translated tracks into the normal language-priority order", () => {
		// Priority: eng, slv, deu, then wildcard. Native has only English.
		const natives: NativeEmitItem[] = [{ stream: stream(0, "eng", "English [SubsPlease]"), emit: emit("eng", "Full Subtitles [SubsPlease]", "eng.ass") }];
		const translated: TranslatedEmitItem[] = [
			{ sourceIndex: 0, emit: emit("deu", "Full Subtitles [RabbitCompany]", "deu.ass") },
			{ sourceIndex: 0, emit: emit("slv", "Full Subtitles [RabbitCompany]", "slv.ass") },
		];
		const ordered = orderOutputSubtitles(natives, translated, [stream(0, "eng")], sorter(["eng", "slv", "deu", "*"]));
		expect(ordered.map((e) => e.language)).toEqual(["eng", "slv", "deu"]);
		// The translated tracks carry the org tag; the native keeps its own group.
		expect(ordered[0]!.trackName).toBe("Full Subtitles [SubsPlease]");
		expect(ordered[1]!.trackName).toBe("Full Subtitles [RabbitCompany]");
	});

	it("keeps native relative order and appends unmatched-language translations under the wildcard", () => {
		const natives: NativeEmitItem[] = [
			{ stream: stream(0, "eng"), emit: emit("eng", "Full Subtitles [A]", "eng.ass") },
			{ stream: stream(1, "jpn"), emit: emit("jpn", "Full Subtitles [B]", "jpn.ass") },
		];
		const translated: TranslatedEmitItem[] = [{ sourceIndex: 0, emit: emit("slv", "Full Subtitles [Rabbit]", "slv.ass") }];
		const ordered = orderOutputSubtitles(natives, translated, [stream(0, "eng"), stream(1, "jpn")], sorter(["eng", "jpn", "*"]));
		expect(ordered.map((e) => e.language)).toEqual(["eng", "jpn", "slv"]);
	});

	it("returns only native tracks when there are no translations", () => {
		const natives: NativeEmitItem[] = [{ stream: stream(0, "eng"), emit: emit("eng", "Full Subtitles", "eng.ass") }];
		const ordered = orderOutputSubtitles(natives, [], [stream(0, "eng")], sorter(["eng", "*"]));
		expect(ordered.length).toBe(1);
		expect(ordered[0]!.file).toBe("eng.ass");
	});
});
