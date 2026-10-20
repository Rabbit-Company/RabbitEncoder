import { describe, expect, it } from "bun:test";
import { bestLag, comparisonFileName, nearestFrame, pickShift, planFrameTimes, planOutputSizes, seekForFrame, shiftErrors } from "../../src/compare/compare";
import { buildZip } from "../../src/core/zip";

/** Envelope-like noise with a fixed seed, so the test is repeatable. */
function envelope(length: number, seed = 1): Float32Array {
	let x = seed >>> 0;
	const out = new Float32Array(length);
	for (let i = 0; i < length; i++) {
		x = (x + 0x6d2b79f5) >>> 0;
		let t = Math.imul(x ^ (x >>> 15), x | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		out[i] = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	}
	return out;
}

describe("bestLag", () => {
	it("finds a release that starts later", () => {
		const a = envelope(30000);
		const b = a.slice(730); // 7.3 s missing from the start
		expect(bestLag(a, b)).toMatchObject({ lag: -730 });
		expect(bestLag(a, b).score).toBeGreaterThan(0.99);
	});

	it("finds a release with extra footage at the start", () => {
		const a = envelope(30000);
		const b = new Float32Array(a.length + 1234);
		b.set(envelope(1234, 7), 0);
		b.set(a, 1234);
		expect(bestLag(a, b).lag).toBe(1234);
	});

	it("reports a low score for unrelated audio", () => {
		expect(bestLag(envelope(20000, 1), envelope(20000, 99)).score).toBeLessThan(0.35);
	});
});

describe("planFrameTimes", () => {
	it("spreads frames over the covered stretch without its first and last 5%", () => {
		expect(planFrameTimes("even", 3, 100, 300)).toEqual([110, 200, 290]);
	});

	it("keeps random frames inside the stretch and in order", () => {
		const times = planFrameTimes("random", 20, 100, 300);
		expect(times).toHaveLength(20);
		expect(times.every((t) => t >= 110 && t <= 290)).toBe(true);
		expect([...times].sort((a, b) => a - b)).toEqual(times);
	});

	it("uses typed timestamps as given, sorted and without duplicates", () => {
		expect(planFrameTimes("manual", 0, 0, 0, [90, 5.5, 90, -1])).toEqual([5.5, 90]);
	});
});

describe("comparison download", () => {
	it("names files so they sort frame by frame in source order", () => {
		const names = [
			comparisonFileName(9, 12, 1, "NF WEB"),
			comparisonFileName(0, 12, 1, "NF WEB"),
			comparisonFileName(0, 12, 0, "Demihuman"),
			comparisonFileName(1, 12, 0, "Demihuman"),
		].sort();
		expect(names).toEqual(["01_1_Demihuman.png", "01_2_NF_WEB.png", "02_1_Demihuman.png", "10_2_NF_WEB.png"]);
		expect(comparisonFileName(4, 150, 2, "Ŝpy/../x")).toBe("005_3_Ŝpy_.._x.png");
	});

	it("writes a ZIP whose central directory lists every entry", () => {
		const zip = buildZip([
			{ name: "01_1_a.png", data: new Uint8Array([1, 2, 3]) },
			{ name: "comparison.txt", data: new TextEncoder().encode("hi") },
		]);
		const end = new DataView(zip.buffer, zip.length - 22);
		expect(end.getUint32(0, true)).toBe(0x06054b50);
		expect(end.getUint16(10, true)).toBe(2);
		expect(new DataView(zip.buffer).getUint32(0, true)).toBe(0x04034b50);
	});
});

describe("frame picking", () => {
	const fps = 24000 / 1001;

	it("picks the nearest frame and seeks half a frame before it", () => {
		expect(nearestFrame(31.511, 0, fps).index).toBe(756);
		expect(seekForFrame(756, 0, fps)).toBeCloseTo(755.5 / fps, 6);
		expect(seekForFrame(0, 0, fps)).toBe(0);
	});

	it("tolerates a few milliseconds of offset error once the moment sits on a frame", () => {
		const reference = nearestFrame(31.511, 0, fps);
		// The second source starts 3.003 s in, but audio said 3.000 s.
		const other = nearestFrame(reference.time - 3.0, 0, fps);
		expect(reference.index - other.index).toBe(72);
	});

	it("counts frames from the video's own start", () => {
		expect(nearestFrame(10.5, 0.5, 24).index).toBe(240);
	});
});

describe("planOutputSizes", () => {
	it("scales smaller videos of the same shape to the largest", () => {
		const { sizes, mismatched } = planOutputSizes([
			{ width: 1280, height: 720, sar: 1 },
			{ width: 1920, height: 1080, sar: 1 },
		]);
		expect(sizes).toEqual([
			{ width: 1920, height: 1080 },
			{ width: 1920, height: 1080 },
		]);
		expect(mismatched).toEqual([false, false]);
	});

	it("uses the shown size of non-square pixels and keeps other shapes as they are", () => {
		const { sizes, mismatched } = planOutputSizes([
			{ width: 1920, height: 1080, sar: 1 },
			{ width: 1440, height: 1080, sar: 4 / 3 },
			{ width: 1920, height: 800, sar: 1 },
		]);
		expect(sizes[1]).toEqual({ width: 1920, height: 1080 });
		expect(sizes[2]).toEqual({ width: 1920, height: 800 });
		expect(mismatched).toEqual([false, false, true]);
	});
});

describe("picture check", () => {
	/** Frames whose content depends only on their index, so a shift is easy to plant. */
	const frame = (n: number) => Uint8Array.from({ length: 64 }, (_, i) => (n * 37 + i * 11) % 251);

	it("finds the match two frames later than the audio offset put it", () => {
		const ref = Array.from({ length: 20 }, (_, i) => frame(100 + i));
		// The run starts 4 frames before the expected match, which shows frame 98 instead of 100.
		const cand = Array.from({ length: 28 }, (_, i) => frame(94 + i));
		expect(pickShift(shiftErrors(ref, cand, 4), 4)).toBe(2);
	});

	it("ignores a brightness difference between releases", () => {
		const ref = Array.from({ length: 20 }, (_, i) => frame(i));
		const cand = Array.from({ length: 28 }, (_, i) => frame(i - 4).map((v) => v + 3));
		expect(pickShift(shiftErrors(ref, cand, 4), 4)).toBe(0);
	});

	it("keeps no shift when nothing fits clearly better", () => {
		expect(pickShift([1, 1, 0.95, 1, 1], 2)).toBe(0);
		expect(pickShift([1, 0.5, 1, 1, 1], 2)).toBe(-1);
	});
});
