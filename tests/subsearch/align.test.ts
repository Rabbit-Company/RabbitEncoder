import { describe, expect, it } from "bun:test";
import { alignToReference, overlapMs } from "../../src/subsearch/align";
import { mapCue, type Interval } from "../../src/subsearch/cues";

/** Deterministic dialogue-like timeline: cues of 1 to 4 s with pauses of 0.3 to 6 s. */
function dialogue(durationMs: number, seed = 7): Interval[] {
	let state = seed;
	const rand = () => {
		state = (state * 1103515245 + 12345) % 2147483648;
		return state / 2147483648;
	};
	const out: Interval[] = [];
	let t = 30_000;
	while (t < durationMs - 10_000) {
		const length = 1000 + rand() * 3000;
		out.push({ startMs: Math.round(t), endMs: Math.round(t + length) });
		t += length + 300 + rand() * (rand() < 0.1 ? 20_000 : 6000);
	}
	return out;
}

function shift(cues: Interval[], ms: number, scale = 1): Interval[] {
	return cues.map((c) => ({ startMs: c.startMs * scale + ms, endMs: c.endMs * scale + ms }));
}

describe("overlapMs", () => {
	it("measures shared time of sorted lists", () => {
		const a = [
			{ startMs: 0, endMs: 1000 },
			{ startMs: 2000, endMs: 3000 },
		];
		const b = [{ startMs: 500, endMs: 2500 }];
		expect(overlapMs(a, b)).toBe(1000);
		expect(overlapMs(a, b, 500)).toBe(1000);
		expect(overlapMs(a, b, -2000)).toBe(500);
	});
});

describe("alignToReference", () => {
	const reference = dialogue(2_400_000);

	it("finds a plain offset to within 10 ms", () => {
		const candidate = shift(reference, -4370);
		const result = alignToReference(candidate, reference);
		expect(result.map.scale).toBe(1);
		expect(result.map.pieces).toHaveLength(1);
		expect(Math.abs(result.map.pieces[0]!.offsetMs - 4370)).toBeLessThanOrEqual(10);
	});

	it("leaves a synced subtitle alone", () => {
		const result = alignToReference(reference, reference);
		expect(result.map.scale).toBe(1);
		expect(result.map.pieces).toEqual([{ fromMs: 0, offsetMs: 0 }]);
	});

	it("undoes a PAL speedup", () => {
		const candidate = shift(reference, 1200, 23.976 / 25);
		const result = alignToReference(candidate, reference);
		expect(result.map.scale).toBeCloseTo(25 / 23.976, 5);
		const mapped = candidate.map((c) => mapCue(c, result.map));
		const errors = mapped.map((c, i) => Math.abs(c.startMs - reference[i]!.startMs));
		expect(Math.max(...errors)).toBeLessThanOrEqual(60);
	});

	it("shifts the part after a removed scene on its own", () => {
		const cut = 1_200_000;
		const candidate = reference.map((c) => (c.startMs >= cut ? { startMs: c.startMs - 8000, endMs: c.endMs - 8000 } : c));
		const result = alignToReference(candidate, reference);
		expect(result.map.pieces.length).toBeGreaterThanOrEqual(2);
		const mapped = candidate.map((c) => mapCue(c, result.map));
		const wrong = mapped.filter((c, i) => Math.abs(c.startMs - reference[i]!.startMs) > 100).length;
		expect(wrong / mapped.length).toBeLessThan(0.03);
	});

	it("tolerates a reference with different cue splits and missing lines", () => {
		const other = reference
			.filter((_, i) => i % 5 !== 0)
			.flatMap((c) => [
				{ startMs: c.startMs + 80, endMs: (c.startMs + c.endMs) / 2 },
				{ startMs: (c.startMs + c.endMs) / 2 + 50, endMs: c.endMs + 150 },
			]);
		const result = alignToReference(shift(reference, 15_000), other);
		expect(Math.abs(result.map.pieces[0]!.offsetMs + 15_000)).toBeLessThanOrEqual(150);
	});
});
