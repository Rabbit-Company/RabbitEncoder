import { describe, expect, it } from "bun:test";
import { getDefaultJobSettings } from "../../src/core/config";
import type { JobSettings } from "../../src/core/types";
import { encodeSettingsCode, decodeSettingsCode } from "../../src/settings/settings-code";

describe("settings code — font/style not carried (RE1 compat)", () => {
	it("never emits font/style/group fields", () => {
		const s: JobSettings = { ...getDefaultJobSettings(), fontGroup: "Anime old", convertSrtToAss: true };
		const code = encodeSettingsCode(s);
		expect(code).not.toMatch(/fn=/);
		expect(code).not.toMatch(/fs=/);
		expect(code).not.toMatch(/Anime/);
		expect(code).toContain("cv=1"); // behavioral toggle still encoded
	});

	it("silently ignores legacy style keys and never sets fontGroup", () => {
		const partial = decodeSettingsCode("RE1|st~cv=1,fn=Trebuchet MS,fs=90,pc=&H00FF00FF");
		expect(partial.convertSrtToAss).toBe(true);
		expect((partial as Record<string, unknown>).subtitleStyle).toBeUndefined();
		expect(partial.fontGroup).toBeUndefined(); // group is environment-specific
	});
});

describe("settings code — extended audio layouts", () => {
	it("supplies new layout defaults when decoding an older RE1 code", () => {
		const decoded = decodeSettingsCode("RE1");
		expect(decoded.audioBitrates?.["5.0"]).toBe(224);
		expect(decoded.audioBitrates?.["6.0"]).toBe(256);
	});

	it("round-trips custom bitrates for newly supported layouts", () => {
		const settings = getDefaultJobSettings();
		settings.audioBitrates["5.0"] = 240;
		settings.audioBitrates["7.0"] = 336;

		const decoded = decodeSettingsCode(encodeSettingsCode(settings));
		expect(decoded.audioBitrates?.["5.0"]).toBe(240);
		expect(decoded.audioBitrates?.["7.0"]).toBe(336);
	});
});
