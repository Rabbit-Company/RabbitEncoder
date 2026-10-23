import { describe, expect, test } from "bun:test";
import { TOOLS } from "../../src/core/versions";
import { versionsText } from "../../src/core/versions-text";

const parse = (name: string, output: string) => TOOLS.find((tool) => tool.name === name)!.parse(output);

describe("tool versions", () => {
	test("are read from each tool's own output", () => {
		expect(parse("FFmpeg", "ffmpeg version 8.1.3 Copyright (c) 2000-2026 the FFmpeg developers\nbuilt with gcc")).toBe("8.1.3");
		expect(parse("FFprobe", "ffprobe version 8.1.3 Copyright (c) 2007-2026 the FFmpeg developers")).toBe("8.1.3");
		expect(parse("SVT-AV1-Essential", "SVT-AV1-Essential v3.1.2-Essential (release)")).toBe("3.1.2-Essential");
		expect(parse("SVT-AV1-HDR", "SVT-AV1-HDR v3.1.0 (release)")).toBe("3.1.0");
		expect(parse("av-denoise", "av-denoise 0.5.0\n")).toBe("0.5.0");
		expect(parse("VapourSynth", "VapourSynth Video Processing Library\nCopyright (c) 2012-2025 Fredrik Mellbin\nCore R72\nAPI R4.1")).toBe("R72");
		expect(parse("regrain", "regrain 0.2.3 (x86_64-unknown-linux-musl)")).toBe("0.2.3");
		expect(parse("retone", "retone 0.1.2 (x86_64-unknown-linux-musl)")).toBe("0.1.2");
		expect(parse("Language Detector", "Language Detector v2.5.3")).toBe("2.5.3");
		expect(parse("MKVToolNix", "mkvmerge v102.0 ('Little Houses') 64-bit")).toBe("102.0");
		expect(parse("MediaInfo", "MediaInfo Command line, \nMediaInfoLib - v26.05")).toBe("26.05");
	});

	test("cover av-denoise and every tool the entrypoint names", () => {
		const names = TOOLS.map((tool) => tool.name);
		for (const name of ["FFmpeg", "FFprobe", "SVT-AV1-Essential", "SVT-AV1-HDR", "SVT-AV1-5FISH", "av-denoise", "regrain", "retone"])
			expect(names).toContain(name);
	});

	test("copy as plain text for bug reports", () => {
		const text = versionsText({
			rabbitEncoder: "8.12.0",
			cpuLevel: "x86-64-v3",
			tools: [
				{ name: "retone", version: "0.1.2" },
				{ name: "av-denoise", version: null },
			],
		});
		expect(text).toBe("Rabbit Encoder 8.12.0 (x86-64-v3)\nretone 0.1.2\nav-denoise not found");
	});
});
