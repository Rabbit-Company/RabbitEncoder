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

describe("settings code — av-denoise engine", () => {
	it("leaves the engine out for FFmpeg nlmeans and decodes old codes to it", () => {
		const settings = getDefaultJobSettings();
		settings.denoise = "medium";
		settings.denoiseEngine = "nlmeans";
		expect(encodeSettingsCode(settings)).not.toMatch(/[~,]e=/);
		expect(decodeSettingsCode("RE1|dn~m=m").denoiseEngine).toBe("nlmeans");
	});

	it("round-trips the single scale and preset of a self-tuning engine", () => {
		const settings = getDefaultJobSettings();
		settings.denoise = "heavy";
		settings.denoiseEngine = "avd-nlmeans-hq";
		settings.avdParams = structuredClone(settings.avdParams);
		settings.avdParams.preset = "slow";
		settings.avdParams.scales["avd-nlmeans-hq"] = 1.25;
		settings.avdDevice = "discrete:1";

		const code = encodeSettingsCode(settings);
		expect(code).toContain("e=ah");
		expect(code).toContain("x=1.25");
		expect(code).not.toMatch(/[~,]s=/); // nlmeans triplet is not used by av-denoise

		const decoded = decodeSettingsCode(code);
		expect(decoded.denoise).toBe("heavy");
		expect(decoded.denoiseEngine).toBe("avd-nlmeans-hq");
		expect(decoded.avdParams?.preset).toBe("slow");
		expect(decoded.avdParams?.scales["avd-nlmeans-hq"]).toBe(1.25);
		expect(decoded.avdParams?.scales["avd-nl4d"]).toBe(1);
		expect(decoded.avdDevice).toBeUndefined(); // device is machine-specific
	});

	it("uses the same single scale for auto denoise", () => {
		const settings = getDefaultJobSettings();
		settings.denoise = "auto";
		settings.autoDenoiseMetric = "bitrate";
		settings.denoiseEngine = "avd-nl4d";
		settings.avdParams = structuredClone(settings.avdParams);
		settings.avdParams.scales["avd-nl4d"] = 0.9;

		const code = encodeSettingsCode(settings);
		expect(code).not.toMatch(/x[lmh]=/);

		const decoded = decodeSettingsCode(code);
		expect(decoded.denoiseEngine).toBe("avd-nl4d");
		expect(decoded.autoDenoiseMetric).toBe("bitrate");
		expect(decoded.avdParams?.scales["avd-nl4d"]).toBe(0.9);
	});

	it("does not store the speed preset for NL4D, which ignores it", () => {
		const settings = getDefaultJobSettings();
		settings.denoise = "medium";
		settings.denoiseEngine = "avd-nl4d";
		settings.avdParams = structuredClone(settings.avdParams);
		settings.avdParams.preset = "veryslow";

		const code = encodeSettingsCode(settings);
		expect(code).toContain("e=a4");
		expect(code).not.toContain("ap=");
	});

	it("round-trips per-level strengths for plain AVD NLMeans", () => {
		const settings = getDefaultJobSettings();
		settings.denoise = "auto";
		settings.denoiseEngine = "avd-nlmeans";
		settings.avdParams = structuredClone(settings.avdParams);
		settings.avdParams.nlmeansStrength = { light: 0.8, medium: 1.05, heavy: 1.3 };

		const decoded = decodeSettingsCode(encodeSettingsCode(settings));
		expect(decoded.denoiseEngine).toBe("avd-nlmeans");
		expect(decoded.avdParams?.nlmeansStrength).toEqual({ light: 0.8, medium: 1.05, heavy: 1.3 });
	});
});
