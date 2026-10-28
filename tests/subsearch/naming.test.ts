import { describe, expect, it } from "bun:test";
import { candidateCredit, downloadedTrackName, sceneGroup } from "../../src/subsearch/naming";

describe("downloaded subtitle track names", () => {
	it("credit the source or group in the release name, as native tracks do", () => {
		expect(downloadedTrackName("full", "Solo.Leveling.S01E01.DUBTITLE.CR-WEB-DL", "malse")).toBe("Full Dubtitles [CR]");
		expect(downloadedTrackName("full", "[ReinForce] Ore dake Level Up na Ken 01 (BDRip 1920x1080 x264 FLAC)", "os-auto")).toBe("Full Subtitles [ReinForce]");
		expect(downloadedTrackName("full", "Solo.Leveling.S01E01.2024.2160p.IQ.WEB-DL.H265.DDP2.0-LelveTV.en", "os-auto")).toBe("Full Subtitles [LelveTV]");
		expect(downloadedTrackName("full", "Solo.Leveling.S01E01.1080p.CR.WEB-DL.DUAL.AAC2.0.H.264-ShiNiGAMi", "Anonymous")).toBe("Full Subtitles [CR]");
		expect(downloadedTrackName("sdh", "Solo.Leveling.S01E01.JAPANESE.WEBRip.NF", "tedi")).toBe("SDH [NF]");
	});

	it("fall back to the uploader, then to OpenSubtitles", () => {
		expect(downloadedTrackName("full", "Solo.Leveling.S01E01.WEBRip", "tedi")).toBe("Full Subtitles [tedi]");
		expect(downloadedTrackName("full", "Solo.Leveling.S01E01.WEB-DL", "Anonymous")).toBe("Full Subtitles [OpenSubtitles]");
		expect(downloadedTrackName("full", "", "os-auto", "Movie.2020.1080p.BluRay.x264-SPARKS.srt")).toBe("Full Subtitles [SPARKS]");
	});

	it("does not take tag halves or languages for a group", () => {
		expect(sceneGroup("Show.S01E01.1080p.WEB-DL")).toBeNull();
		expect(sceneGroup("Show.S01E01.x264-GROUP.eng.forced")).toBe("GROUP");
		expect(sceneGroup("Show S01E01")).toBeNull();
	});

	it("use a credit entered by hand over the one read from the names", () => {
		expect(candidateCredit("Solo.Leveling.S01E01.WEBRip", "tedi")).toBe("tedi");
		expect(candidateCredit("", "Anonymous", "Solo.Leveling.S01E01.NF.srt")).toBe("NF");
		expect(downloadedTrackName("full", "Solo.Leveling.S01E01.DUBTITLE.WEBRip", "tedi", "", "SubsPlease")).toBe("Full Dubtitles [SubsPlease]");
		expect(downloadedTrackName("full", "Solo.Leveling.S01E01.WEBRip", "tedi", "", "  ")).toBe("Full Subtitles [tedi]");
	});
});
