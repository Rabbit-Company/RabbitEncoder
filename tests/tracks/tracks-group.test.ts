import { describe, expect, it } from "bun:test";
import { buildSubtitleTrackName, extractGroupFromTitle } from "../../src/tracks/tracks";

describe("extractGroupFromTitle — pipe-separated", () => {
	it("takes the group after the pipe, before credits", () => {
		expect(extractGroupFromTitle("Full Subtitles | Thicket-Subs (Doki/deanzel edit)")).toBe("Thicket-Subs");
		expect(extractGroupFromTitle("Signs/Songs | Sentai Filmworks")).toBe("Sentai Filmworks");
		expect(extractGroupFromTitle("Subtitles | CloverSubs (???/Mysteria edit)")).toBe("CloverSubs");
	});
});

describe("extractGroupFromTitle — @-separated", () => {
	it("takes the group after the last @", () => {
		expect(extractGroupFromTitle("Full Sub@Meadow-subs")).toBe("Meadow-subs");
		expect(extractGroupFromTitle("Dialogue@GJM")).toBe("GJM");
	});

	it("strips a trailing bracket/credit block after the @ group", () => {
		expect(extractGroupFromTitle("Full Sub@Meadow-subs [Styled]")).toBe("Meadow-subs");
		expect(extractGroupFromTitle("Full Sub@Thicket-Subs (deanzel edit)")).toBe("Thicket-Subs");
	});
});

describe("extractGroupFromTitle — bracketed", () => {
	it("extracts from [] and ()", () => {
		expect(extractGroupFromTitle("English (SubsHop)")).toBe("SubsHop");
		expect(extractGroupFromTitle("Signs/Songs [BNNY]")).toBe("BNNY");
	});

	it("skips blocked / descriptor tokens and picks the real group", () => {
		expect(extractGroupFromTitle("English (CC) [SubsHop]")).toBe("SubsHop");
		expect(extractGroupFromTitle("English [Styled] (BNNY)")).toBe("BNNY");
	});

	it("returns null when the only bracket token is blocked", () => {
		expect(extractGroupFromTitle("English (CC)")).toBeNull();
		expect(extractGroupFromTitle("Full Subtitles [SDH]")).toBeNull();
	});
});

describe("extractGroupFromTitle — bare title (score-gated)", () => {
	it("accepts clearly group-like bare titles", () => {
		expect(extractGroupFromTitle("Meadow-subs")).toBe("Meadow-subs");
		expect(extractGroupFromTitle("SubsHop")).toBe("SubsHop");
		expect(extractGroupFromTitle("Hare-raws")).toBe("Hare-raws");
	});

	it("picks a group-like trailing token from a bare multi-word title", () => {
		expect(extractGroupFromTitle("Full Subtitles Meadow-subs")).toBe("Meadow-subs");
	});

	it("rejects bare language / descriptor titles", () => {
		expect(extractGroupFromTitle("English")).toBeNull();
		expect(extractGroupFromTitle("Spanish")).toBeNull();
		expect(extractGroupFromTitle("Latin American Spanish")).toBeNull();
		expect(extractGroupFromTitle("Brazilian Portuguese")).toBeNull();
		expect(extractGroupFromTitle("Full Subtitles")).toBeNull();
	});

	it("returns null for empty / undefined input", () => {
		expect(extractGroupFromTitle(undefined)).toBeNull();
		expect(extractGroupFromTitle("")).toBeNull();
	});
});

describe("buildSubtitleTrackName — group integration", () => {
	it("appends the @-extracted group", () => {
		expect(buildSubtitleTrackName("full", "Full Sub@Meadow-subs")).toBe("Full Subtitles [Meadow-subs]");
	});

	it("appends a bracketed group", () => {
		expect(buildSubtitleTrackName("full", "English (SubsHop)")).toBe("Full Subtitles [SubsHop]");
	});

	it("leaves the label clean when no group is detected", () => {
		expect(buildSubtitleTrackName("full", "English")).toBe("Full Subtitles");
	});
});
