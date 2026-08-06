import { describe, expect, it } from "bun:test";
import { getDefaultJobSettings } from "../../src/core/config";
import { getAudioReplacementLabel, getOpusBitrateForLayout, normalizeLayout } from "../../src/pipeline/probe";

describe("audio channel layouts", () => {
	it("recognizes 5-channel layouts instead of falling back to stereo", () => {
		expect(normalizeLayout("5.0")).toBe("5.0");
		expect(normalizeLayout("5.0(side)")).toBe("5.0");
		expect(getAudioReplacementLabel("5.0")).toBe("Opus 5.0");
	});

	it("normalizes common FFmpeg layout aliases", () => {
		expect(normalizeLayout("3.0(back)")).toBe("3.0");
		expect(normalizeLayout("quad")).toBe("4.0");
		expect(normalizeLayout("6.0(front)")).toBe("6.0");
		expect(normalizeLayout("6.1(back)")).toBe("6.1");
		expect(normalizeLayout("7.1(wide-side)")).toBe("7.1");
	});

	it("uses the reported channel count when the layout name is missing or unknown", () => {
		expect(normalizeLayout("", 5)).toBe("5.0");
		expect(normalizeLayout("unknown", 4)).toBe("4.0");
		expect(normalizeLayout("unknown", 8)).toBe("7.1");
	});

	it("uses channel-appropriate default bitrates", () => {
		const bitrates = getDefaultJobSettings().audioBitrates;
		expect(getOpusBitrateForLayout("3.0", bitrates)).toBe(160);
		expect(getOpusBitrateForLayout("4.0", bitrates)).toBe(192);
		expect(getOpusBitrateForLayout("5.0", bitrates)).toBe(224);
		expect(getOpusBitrateForLayout("6.0", bitrates)).toBe(256);
		expect(getOpusBitrateForLayout("7.0", bitrates)).toBe(320);
	});
});
