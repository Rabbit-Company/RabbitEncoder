import { describe, expect, it } from "bun:test";
import {
	baseCrf,
	CAP_AIM,
	ESSENTIAL_BITRATE_MODEL,
	percentile15,
	presetBitrateShare,
	finalBitrateShare,
	planZones,
	sampleFrames,
	scenesFromKeyframes,
	zonesConfig,
	type SceneStats,
} from "../../src/boost/plan";

describe("scenesFromKeyframes", () => {
	it("starts a scene at the first frame and at every key frame", () => {
		expect(scenesFromKeyframes([true, false, false, true, false])).toEqual([
			{ start: 0, end: 3 },
			{ start: 3, end: 5 },
		]);
		expect(scenesFromKeyframes([false, false, true])).toEqual([
			{ start: 0, end: 2 },
			{ start: 2, end: 3 },
		]);
	});
});

describe("sampleFrames", () => {
	it("takes every step-th frame of a long scene", () => {
		expect(sampleFrames([{ start: 0, end: 60 }], 6, 8)).toEqual([0, 6, 12, 18, 24, 30, 36, 42, 48, 54]);
	});

	it("spreads the minimum over a short scene", () => {
		expect(sampleFrames([{ start: 100, end: 122 }], 6, 8)).toEqual([100, 103, 106, 109, 112, 115, 118, 121]);
	});

	it("takes every frame of a scene shorter than the minimum", () => {
		expect(sampleFrames([{ start: 10, end: 14 }], 6, 8)).toEqual([10, 11, 12, 13]);
	});

	it("samples each scene from its own start", () => {
		expect(
			sampleFrames(
				[
					{ start: 0, end: 13 },
					{ start: 13, end: 26 },
				],
				6,
				2,
			),
		).toEqual([0, 6, 12, 13, 19, 25]);
	});
});

describe("percentile15", () => {
	it("matches Python's statistics.quantiles(n=100)[14], as Auto-Boost-Essential uses it", () => {
		expect(percentile15([70, 80])).toBeCloseTo(64.5, 9);
		expect(percentile15([50, 60, 70, 80, 90])).toBeCloseTo(49.0, 9);
		expect(percentile15([81.2, 79.5, 85.0, 62.3, 77.7, 90.1, 88.8, 70.4])).toBeCloseTo(65.135, 9);
		expect(percentile15(Array.from({ length: 100 }, (_, i) => i + 1))).toBeCloseTo(15.15, 9);
		expect(percentile15([75.5, -3, 80])).toBeCloseTo(-30.2, 9);
	});

	it("takes a single score as it is", () => {
		expect(percentile15([72])).toBe(72);
	});
});

describe("baseCrf", () => {
	it("follows the quality presets, 5 higher above 1080p", () => {
		expect(baseCrf("medium", 1920, 1080)).toBe(30);
		expect(baseCrf("high", 1920, 1080)).toBe(25);
		expect(baseCrf("medium", 3840, 2160)).toBe(35);
	});
});

const scene = (start: number, end: number, scores: number[], kbps = 1000, fps = 24): SceneStats => ({
	start,
	end,
	scores,
	bytes: Math.round((kbps * 1000 * ((end - start) / fps)) / 8),
});

// The fast pass and the final one at the same CRF and preset, so bitrates carry over one to one.
const same = { baseCrf: 30, fastCrf: 30, finalPreset: 8, fps: 24 };

describe("planZones", () => {
	it("lowers the CRF of scenes scoring under the average and raises it for better ones", () => {
		const zones = planZones([scene(0, 48, [70, 70, 70]), scene(48, 96, [90, 90, 90])], same);
		// Average 80: (1 - 70/80) * 20 = 2.5 lower, (1 - 90/80) * 20 = 2.5 higher.
		expect(zones.map((z) => z.crf)).toEqual([27.5, 32.5]);
		expect(zones.every((z) => !z.capped)).toBe(true);
	});

	it("keeps changes within the limit", () => {
		const zones = planZones([scene(0, 48, [20, 20]), scene(48, 96, [95, 95])], same);
		expect(zones.map((z) => z.crf)).toEqual([25, 35]);
	});

	// Bitrate halves every 10 CRF and the final pass matches the fast one, so the numbers are easy to follow.
	const model = { crfPerHalving: 10, efficiency: 1 };
	const aim = 6000 * CAP_AIM;

	it("gives a scene over the cap the CRF that brings it a little under", () => {
		const zones = planZones([scene(0, 48, [80, 80], aim * 2), scene(48, 96, [80, 80], 1000)], { ...same, model, maxKbps: 6000 });
		// Twice what it aims for, so one halving more.
		expect(zones[0]).toMatchObject({ crf: 40, capped: true });
		expect(zones[0]!.fastKbps).toBeCloseTo(aim * 2, 0);
		expect(zones[1]).toMatchObject({ crf: 30, capped: false });
	});

	it("counts from the CRF the fast pass ran at, the final preset's share and the encoder's efficiency", () => {
		// Essential's medium runs the fast pass at CRF 35, while the zones centre on 30.
		const tuned = { crfPerHalving: 10, efficiency: 0.8 };
		const fast = ((aim * 2) / presetBitrateShare(4) / tuned.efficiency) * 2 ** (-5 / 10);
		const zones = planZones([scene(0, 48, [80, 80], fast)], { baseCrf: 30, fastCrf: 35, finalPreset: 4, fps: 24, model: tuned, maxKbps: 6000 });
		// That scene would take twice the aim at CRF 30, so one halving above 30.
		expect(zones[0]).toMatchObject({ crf: 40, capped: true });
	});

	it("does not raise a scene the scores already brought under the cap", () => {
		const zones = planZones([scene(0, 48, [70, 70], 6000), scene(48, 96, [90, 90], 6000)], { ...same, model, maxKbps: 6000 });
		// 2.5 CRF higher brings 6 Mb/s to about 5 Mb/s, under the 5.4 Mb/s aimed for.
		expect(zones[1]).toMatchObject({ crf: 32.5, capped: false });
		expect(zones[0]).toMatchObject({ capped: true });
	});

	it("uses SVT-AV1-Essential's model when none is given", () => {
		const fast = (aim * 2) / ESSENTIAL_BITRATE_MODEL.efficiency;
		const zones = planZones([scene(0, 48, [80, 80], fast)], { ...same, maxKbps: 6000 });
		expect(zones[0]!.crf).toBe(30 + ESSENTIAL_BITRATE_MODEL.crfPerHalving);
	});

	it("predicts each scene's final bitrate at its CRF", () => {
		const zones = planZones([scene(0, 48, [80, 80], aim * 2), scene(48, 96, [80, 80], 1000)], { ...same, model, maxKbps: 6000 });
		// The capped scene lands on the aim, the other one keeps the base CRF and its fast pass bitrate.
		expect(zones[0]!.predictedKbps).toBeCloseTo(aim, 0);
		expect(zones[1]!.predictedKbps).toBeCloseTo(1000, 0);
	});

	it("keeps CRFs between 1 and 70", () => {
		const zones = planZones([scene(0, 24, [80], 1_000_000)], { ...same, baseCrf: 60, fastCrf: 60, maxKbps: 100 });
		expect(zones[0]!.crf).toBe(70);
	});
});

describe("finalBitrateShare", () => {
	it("takes the preset's share and the encoder's efficiency, and halves every crfPerHalving above the fast pass's CRF", () => {
		const tuned = { crfPerHalving: 10, efficiency: 0.8 };
		expect(finalBitrateShare(35, 35, 8, tuned)).toBeCloseTo(0.8, 9);
		expect(finalBitrateShare(45, 35, 8, tuned)).toBeCloseTo(0.4, 9);
		expect(finalBitrateShare(30, 35, 4, tuned)).toBeCloseTo(presetBitrateShare(4) * 0.8 * 2 ** 0.5, 9);
	});
});

describe("presetBitrateShare", () => {
	it("is 1 at the fast pass's preset and above, and falls for slower presets", () => {
		expect(presetBitrateShare(8)).toBe(1);
		expect(presetBitrateShare(12)).toBe(1);
		expect(presetBitrateShare(4)).toBe(0.85);
		expect(presetBitrateShare(2)).toBeLessThan(presetBitrateShare(4));
		expect(presetBitrateShare(-1)).toBeGreaterThan(0);
	});
});

describe("zonesConfig", () => {
	it("writes the Zones line SVT-AV1-Essential reads, with inclusive ends", () => {
		const zones = planZones([scene(0, 48, [80]), scene(48, 100, [80])], same);
		expect(zonesConfig(zones)).toBe("Zones : 0,47,30;48,99,30;\n");
	});
});
