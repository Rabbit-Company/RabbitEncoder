import { describe, expect, it } from "bun:test";
import {
	candidateCredit,
	cleanPreferredSources,
	downloadedLanguageTag,
	downloadedTrackName,
	preferredSourceRank,
	sceneGroup,
} from "../../src/subsearch/naming";
import { otherEpisode, releaseEpisode } from "../../src/subsearch/score";

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

describe("downloaded subtitle language tags", () => {
	it("name the Chinese script, as native tracks do", () => {
		expect(downloadedLanguageTag("chi")).toBe("zh-Hans");
		expect(downloadedLanguageTag("zh-hant")).toBe("zh-Hant");
		expect(downloadedLanguageTag("pt-br")).toBe("pt-BR");
		expect(downloadedLanguageTag("slv")).toBe("sl");
	});
});

describe("preferred sources", () => {
	const rank = (release: string, preferred: string[]) => preferredSourceRank(release, "os-auto", "", preferred);

	it("matches streaming sources by any of their names, in list order", () => {
		expect(rank("[Crunchyroll] Ore dake Level Up na Ken - 07", ["CR", "NF"])).toBe(0);
		expect(rank("Solo.Leveling.S01E07.JAPANESE.WEBRip.NF", ["CR", "NF"])).toBe(1);
		expect(rank("Solo.Leveling.S01E07.JAPANESE.WEBRip.Netflix", ["Crunchyroll", "netflix"])).toBe(1);
		expect(rank("Solo.Leveling.S01E07.1080p.BluRay-GROUP", ["CR", "NF"])).toBe(2);
	});

	it("matches groups named anywhere in the release name", () => {
		expect(rank("[Mugi] Solo Leveling - 07 [CR]", ["mugi"])).toBe(0);
		expect(rank("[Erai-raws] Solo Leveling - 07 [1080p]", ["NF", "Erai-raws"])).toBe(1);
		expect(rank("[Mugiwara] Solo Leveling - 07", ["Mugi"])).toBe(1);
	});

	it("cleans typed lists", () => {
		expect(cleanPreferredSources([" CR ", "", "NF", "CR", 3])).toEqual(["CR", "NF"]);
		expect(cleanPreferredSources("CR")).toEqual([]);
	});
});

describe("episode numbers in release names", () => {
	it("reads the common forms", () => {
		expect(releaseEpisode("Ore dake Level Up na Ken - 07.5 [Crunchyroll]")).toEqual({ episode: 7.5 });
		expect(releaseEpisode("[Mugi] Solo Leveling - 07 [CR]")).toEqual({ episode: 7 });
		expect(releaseEpisode("Solo.Leveling.S01E07.1080p.WEB")).toEqual({ season: 1, episode: 7 });
		expect(releaseEpisode("Solo Leveling Episode 7")).toEqual({ episode: 7 });
		expect(releaseEpisode("The.Matrix.1999.1080p.BluRay")).toBeNull();
	});

	it("tells another episode or season from the video's", () => {
		expect(otherEpisode("Ore dake Level Up na Ken - 07.5 [Crunchyroll]", 1, 7)).toBe(true);
		expect(otherEpisode("[Crunchyroll] Ore dake Level Up na Ken - 07", 1, 7)).toBe(false);
		expect(otherEpisode("Solo.Leveling.S02E07.1080p", 1, 7)).toBe(true);
		expect(otherEpisode("Solo Leveling - 07 [CR]", undefined, 7)).toBe(false);
		expect(otherEpisode("Solo Leveling - 08", 1, undefined)).toBe(false);
	});
});
