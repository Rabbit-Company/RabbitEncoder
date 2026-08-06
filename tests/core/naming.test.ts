import { describe, expect, it } from "bun:test";
import { extractBaseTitle } from "../../src/core/naming";

describe("extractBaseTitle", () => {
	it("removes an IMDb ID from a movie title", () => {
		const stem = "Exampele movie (2007) [imdbid-tt0983213] - [Remux-1080p][FLAC 2.0][x264]-Group";

		expect(extractBaseTitle(stem)).toBe("Exampele movie (2007)");
	});

	it("removes an IMDb ID before an episode marker too", () => {
		const stem = "Example Show (2024) [IMDBID-TT1234567] - S01E01 - Pilot [Bluray-1080p][x264]-Group";

		expect(extractBaseTitle(stem)).toBe("Example Show (2024) - S01E01 - Pilot");
	});
});
