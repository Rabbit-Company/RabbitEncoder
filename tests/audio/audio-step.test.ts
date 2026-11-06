import { describe, expect, it } from "bun:test";
import { getDefaultJobSettings } from "../../src/core/config";
import type { AudioStreamInfo } from "../../src/core/types";
import { audioDefaults, canKeepOpus, opusBitrateFor, opusencArgs, selectAudioStreams } from "../../src/audio/audio-step";

const stream = (index: number, language: string, title = "", channels = 2, codec = "aac"): AudioStreamInfo => ({
	index,
	language,
	title,
	channels,
	channelLayout: channels === 6 ? "5.1(side)" : "stereo",
	codec,
	delayMs: 0,
});

describe("selectAudioStreams", () => {
	it("filters, orders and dedupes as an encode does", () => {
		const settings = { ...getDefaultJobSettings(), audioLanguages: ["jpn", "eng"], audioLanguagePriority: ["jpn", "eng", "*"], removeCommentaryAudio: true };
		const picked = selectAudioStreams(
			[stream(1, "eng"), stream(2, "ger"), stream(3, "jpn"), stream(4, "eng", "Commentary"), stream(5, "jpn", "", 2, "flac")],
			settings,
		);
		expect(picked.map((s) => s.index)).toEqual([5, 1]);
	});
});

describe("audio encoding rules", () => {
	const settings = getDefaultJobSettings();

	it("takes the bitrate of the track's layout", () => {
		expect(opusBitrateFor(stream(1, "eng", "", 6), settings)).toBe(settings.audioBitrates["5.1"]);
		expect(opusBitrateFor(stream(1, "eng"), settings)).toBe(settings.audioBitrates.stereo);
	});

	it("keeps Opus that is already at or under the bitrate", () => {
		expect(canKeepOpus({ codec: "opus", bitrate: 96_000 }, 128)).toBe(true);
		expect(canKeepOpus({ codec: "opus", bitrate: 192_000 }, 128)).toBe(false);
		expect(canKeepOpus({ codec: "opus" }, 128)).toBe(false);
		expect(canKeepOpus({ codec: "aac", bitrate: 96_000 }, 128)).toBe(false);
	});

	it("encodes with opusenc as an encode does", () => {
		expect(opusencArgs("in.flac", "out.opus", 128, { noPhaseInv: true })).toEqual([
			"opusenc",
			"--bitrate",
			"128",
			"--no-phase-inv",
			"--discard-comments",
			"--discard-pictures",
			"in.flac",
			"out.opus",
		]);
	});

	it("makes the first main track of each language the default", () => {
		expect(
			audioDefaults([
				{ language: "jpn", trackType: "main" },
				{ language: "eng", trackType: "commentary" },
				{ language: "en", trackType: "main" },
				{ language: "eng", trackType: "main" },
			]),
		).toEqual([true, false, true, false]);
	});
});
