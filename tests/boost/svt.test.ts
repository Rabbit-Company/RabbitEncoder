import { describe, expect, it } from "bun:test";
import { svtCrfFromLog, svtProgressFrame } from "../../src/boost/svt";

describe("svtCrfFromLog", () => {
	it("reads the CRF of a quality preset, as SVT-AV1-Essential prints it", () => {
		const log =
			"Svt[info]: SVT [config]: speed / tune / pred struct \t\t\t\t: faster (8) / PSNR (1) / RA\nSvt[info]: SVT [config]: BRC mode / quality \t\t\t\t\t: CRF / medium (35) \n";
		expect(svtCrfFromLog(log)).toBe(35);
	});

	it("reads a CRF given with --crf, as SVT-AV1-Tritium prints it", () => {
		expect(svtCrfFromLog("Svt[info]: SVT [config]: BRC mode / rate factor \t\t\t\t\t: CRF / 27.50 \n")).toBe(27.5);
	});

	it("gives nothing for a log without the line", () => {
		expect(svtCrfFromLog("Svt[info]: SVT [version]: SVT-AV1 Encoder Lib v4.2.0\n")).toBeNull();
	});
});

describe("svtProgressFrame", () => {
	it("reads both progress styles and ignores colour codes", () => {
		expect(svtProgressFrame("Encoding frame  123")).toBe(123);
		expect(svtProgressFrame("\x1b[32mEncoding:   456 Frames @ 8.67 fps | 1500 kbps\x1b[0m")).toBe(456);
		expect(svtProgressFrame("Svt[info]: something else")).toBeNull();
	});
});
