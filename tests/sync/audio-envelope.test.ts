import { describe, expect, it } from "bun:test";
import { bestLag, correlationAt } from "../../src/sync/audio-envelope";
import { concat, envelope } from "./noise";

describe("bestLag", () => {
	it("finds a release that starts later", () => {
		const a = envelope(30000);
		const b = a.slice(730); // 7.3 s missing from the start
		expect(bestLag(a, b)).toMatchObject({ lag: -730 });
		expect(bestLag(a, b).score).toBeGreaterThan(0.99);
	});

	it("finds a release with extra footage at the start", () => {
		const a = envelope(30000);
		const b = concat(envelope(1234, 7), a);
		expect(bestLag(a, b).lag).toBe(1234);
	});

	it("reports a low score for unrelated audio", () => {
		expect(bestLag(envelope(20000, 1), envelope(20000, 99)).score).toBeLessThan(0.35);
	});

	it("matches only the given part of the first envelope", () => {
		const a = concat(envelope(10000, 1), envelope(10000, 2));
		const b = concat(envelope(500, 3), envelope(10000, 2));
		expect(bestLag(a, b, 180, 10000, 20000)).toMatchObject({ lag: -9500 });
	});
});

describe("correlationAt", () => {
	it("is 1 for the same signal and needs 100 shared steps", () => {
		const a = envelope(1000);
		expect(correlationAt(a, a, 0)).toBeCloseTo(1, 6);
		expect(correlationAt(a, a, 0, 0, 99)).toBe(-1);
	});
});
