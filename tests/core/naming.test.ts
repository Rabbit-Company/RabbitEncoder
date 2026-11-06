import { describe, expect, it } from "bun:test";
import { detectReleaseGroup, extractBaseTitle } from "../../src/core/naming";

describe("extractBaseTitle", () => {
	it("removes an IMDb ID from a movie title", () => {
		const stem = "Exampele movie (2007) [imdbid-tt0983213] - [Remux-1080p][FLAC 2.0][x264]-Group";

		expect(extractBaseTitle(stem)).toBe("Exampele movie (2007)");
	});

	it("removes an IMDb ID before an episode marker too", () => {
		const stem = "Example Show (2024) [IMDBID-TT1234567] - S01E01 - Pilot [Bluray-1080p][x264]-Group";

		expect(extractBaseTitle(stem)).toBe("Example Show (2024) - S01E01 - Pilot");
	});

	it("removes a release group with spaces and accented letters", () => {
		const stem = "Overflow (2020) - S01E01 - Soft Sisters and Bathing [WEBDL-1080p][FLAC 2.0][x264]-Lolicons Anônimos";

		expect(extractBaseTitle(stem)).toBe("Overflow (2020) - S01E01 - Soft Sisters and Bathing");
	});
});

describe("detectReleaseGroup", () => {
	it("reads the group after the last tag block", () => {
		expect(detectReleaseGroup("Show - S01E01 [Bluray-1080p][x265]-Judas")).toBe("Judas");
		expect(detectReleaseGroup("Show - S01E01 [WEBDL-1080p][x264]-Lolicons Anônimos")).toBe("Lolicons Anônimos");
		expect(detectReleaseGroup("Show - S01E01 [WEBDL-1080p][x264]-Fansub Group")).toBe("Fansub Group");
		expect(detectReleaseGroup("Show.S01E01.1080p.WEB-DL.x264-GRP.v2")).toBeNull();
		expect(detectReleaseGroup("[SubsPlease] Show - 01 (1080p) [ABCD1234]")).toBeNull();
	});

	it("does not take a title for a group", () => {
		expect(detectReleaseGroup("Show [1080p]-")).toBeNull();
		expect(detectReleaseGroup("Show [1080p]- (2)")).toBeNull();
	});
});
