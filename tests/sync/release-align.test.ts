import { describe, expect, it } from "bun:test";
import { alignEnvelopes, pickAlignmentAudio, splitPoints, toFileTimes } from "../../src/sync/release-align";
import { offsetAt } from "../../src/subsearch/cues";
import type { AudioStreamInfo } from "../../src/core/types";
import { concat, envelope } from "./noise";

const SEC = 100;

/** `env` played `scale` times slower, as a PAL release is to a film one. */
function slowed(env: Float32Array, scale: number): Float32Array {
	const out = new Float32Array(Math.floor(env.length * scale));
	for (let i = 0; i < out.length; i++) {
		const pos = i / scale;
		const k = Math.floor(pos);
		const t = pos - k;
		out[i] = env[k]! * (1 - t) + (env[k + 1] ?? env[k]!) * t;
	}
	return out;
}

describe("alignEnvelopes", () => {
	it("finds one offset for a source with extra footage at the start", () => {
		const target = envelope(300 * SEC);
		const source = concat(envelope(730, 9), target);
		const result = alignEnvelopes(target, source);
		expect(result.map).toEqual({ scale: 1, pieces: [{ fromMs: 0, offsetMs: -7300 }] });
		expect(result.removed).toEqual([]);
		expect(result.confidence).toBeGreaterThan(0.95);
		expect(result.coveredShare).toBe(1);
	});

	it("drops a scene the target cut and moves what follows", () => {
		const a = envelope(200 * SEC, 1);
		const cut = envelope(30 * SEC, 2);
		const c = envelope(200 * SEC, 3);
		const result = alignEnvelopes(concat(a, c), concat(a, cut, c));
		expect(result.map.pieces).toHaveLength(2);
		expect(result.map.pieces[0]).toEqual({ fromMs: 0, offsetMs: 0 });
		expect(result.map.pieces[1]!.offsetMs).toBe(-30_000);
		expect(Math.abs(result.map.pieces[1]!.fromMs - 230_000)).toBeLessThanOrEqual(20);
		expect(result.removed).toHaveLength(1);
		expect(Math.abs(result.removed[0]!.startMs - 200_000)).toBeLessThanOrEqual(20);
		expect(Math.abs(result.removed[0]!.endMs - 230_000)).toBeLessThanOrEqual(20);
	});

	it("moves what follows footage only the target has", () => {
		const a = envelope(200 * SEC, 1);
		const extra = envelope(20 * SEC, 4);
		const c = envelope(200 * SEC, 3);
		const result = alignEnvelopes(concat(a, extra, c), concat(a, c));
		expect(result.map.pieces).toHaveLength(2);
		expect(result.map.pieces[1]!.offsetMs).toBe(20_000);
		expect(Math.abs(result.map.pieces[1]!.fromMs - 200_000)).toBeLessThanOrEqual(20);
		expect(result.removed).toEqual([]);
		// Lines just before and after the new footage keep their place.
		expect(offsetAt(result.map, 199_000)).toBe(0);
		expect(offsetAt(result.map, 201_000)).toBe(20_000);
	});

	it("keeps one offset through a silent stretch", () => {
		const silence = new Float32Array(60 * SEC).fill(-3);
		const target = concat(envelope(150 * SEC, 1), silence, envelope(150 * SEC, 2));
		const source = concat(envelope(500, 5), target);
		const result = alignEnvelopes(target, source);
		expect(result.map.pieces).toEqual([{ fromMs: 0, offsetMs: -5000 }]);
	});

	it("finds a PAL speed-up when it is offered", () => {
		const scale = 25 / 23.976;
		const target = envelope(300 * SEC, 6);
		const source = slowed(target, 1 / scale);
		const result = alignEnvelopes(target, source, { scales: [scale] });
		expect(result.map.scale).toBe(scale);
		expect(result.map.pieces).toHaveLength(1);
		expect(Math.abs(result.map.pieces[0]!.offsetMs)).toBeLessThanOrEqual(20);
		expect(result.confidence).toBeGreaterThan(0.8);
	});

	it("keeps the speed when a change is offered but does not fit", () => {
		const target = envelope(300 * SEC, 6);
		const result = alignEnvelopes(target, target, { scales: [25 / 23.976] });
		expect(result.map).toEqual({ scale: 1, pieces: [{ fromMs: 0, offsetMs: 0 }] });
	});

	it("reports unrelated audio as unmatched", () => {
		const result = alignEnvelopes(envelope(300 * SEC, 1), envelope(300 * SEC, 99));
		expect(result.confidence).toBeLessThan(0.35);
		expect(result.coveredShare).toBeLessThan(0.2);
	});

	it("returns no match for audio too short to window", () => {
		expect(alignEnvelopes(envelope(10 * SEC), envelope(10 * SEC)).confidence).toBe(0);
	});
});

describe("splitPoints", () => {
	it("finds a cut to the step", () => {
		const a = envelope(5000, 1);
		const c = envelope(5000, 3);
		const target = concat(a, c);
		const source = concat(a, envelope(777, 2), c);
		expect(splitPoints(target, source, 0, 777, 0, target.length)).toEqual({ s1: 5000, s2: 5000 });
	});

	it("leaves out footage that matches neither side", () => {
		const a = envelope(5000, 1);
		const c = envelope(5000, 3);
		const target = concat(a, envelope(400, 4), c);
		const source = concat(a, c);
		expect(splitPoints(target, source, 0, -400, 0, target.length)).toEqual({ s1: 5000, s2: 5400 });
	});

	it("ignores a gain difference between the releases", () => {
		const a = envelope(5000, 1);
		const c = envelope(5000, 3);
		const target = concat(a, c);
		const source = concat(a, envelope(300, 2), c).map((v) => v - 0.4);
		expect(splitPoints(target, source, 0, 300, 0, target.length)).toEqual({ s1: 5000, s2: 5000 });
	});
});

describe("toFileTimes", () => {
	it("adds the audio delays of both files", () => {
		const aligned = {
			map: {
				scale: 1,
				pieces: [
					{ fromMs: 0, offsetMs: 0 },
					{ fromMs: 100_000, offsetMs: -5000 },
				],
			},
			confidence: 1,
			coveredShare: 1,
			removed: [{ startMs: 95_000, endMs: 100_000 }],
		};
		const result = toFileTimes(aligned, 40, 100);
		expect(result.map.pieces).toEqual([
			{ fromMs: 0, offsetMs: -60 },
			{ fromMs: 100_100, offsetMs: -5060 },
		]);
		expect(result.removed).toEqual([{ startMs: 95_100, endMs: 100_100 }]);
	});
});

describe("pickAlignmentAudio", () => {
	const stream = (index: number, language?: string, isOriginal = false): AudioStreamInfo => ({
		index,
		channels: 2,
		channelLayout: "stereo",
		language,
		delayMs: 0,
		isOriginal,
	});

	it("prefers the language, then the original, then the first", () => {
		const streams = [stream(1, "eng"), stream(2, "jpn", true), stream(3, "ger")];
		expect(pickAlignmentAudio(streams, "ger")?.index).toBe(3);
		expect(pickAlignmentAudio(streams, "fre")?.index).toBe(2);
		expect(pickAlignmentAudio([stream(1, "eng"), stream(3, "ger")])?.index).toBe(1);
	});
});
