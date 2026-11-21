import { expect, test } from "bun:test";
import { describeTimeMap, isIdentityTimeMap, timingPatterns, withExtraShift } from "../../public/features/audit-timing";

test("describes how a track moves", () => {
	expect(describeTimeMap({ scale: 1, pieces: [{ fromMs: 0, offsetMs: 1200 }] })).toBe("+1.20 s");
	expect(describeTimeMap({ scale: 1, pieces: [{ fromMs: 0, offsetMs: -450 }] })).toBe("-0.45 s");
	expect(describeTimeMap({ scale: 25 / 23.976, pieces: [{ fromMs: 0, offsetMs: 0 }] })).toBe("25 -> 23.976 fps");
	expect(
		describeTimeMap({
			scale: 1,
			pieces: [
				{ fromMs: 0, offsetMs: 100 },
				{ fromMs: 760_000, offsetMs: 3100 },
			],
		}),
	).toBe("+0.10 s, then +3.10 s from 12:40");
});

test("adds the extra shift to every part", () => {
	const map = withExtraShift(
		{
			scale: 1,
			pieces: [
				{ fromMs: 0, offsetMs: 1000 },
				{ fromMs: 5000, offsetMs: 2000 },
			],
		},
		-1000,
	);
	expect(map.pieces.map((piece) => piece.offsetMs)).toEqual([0, 1000]);
	expect(isIdentityTimeMap(withExtraShift({ scale: 1, pieces: [{ fromMs: 0, offsetMs: 300 }] }, -300))).toBe(true);
});

test("names the same change found in several files", () => {
	const map = { scale: 1, pieces: [{ fromMs: 0, offsetMs: 1200 }] };
	const off = { language: "en", title: "Full", status: "off" as const, map };
	expect(timingPatterns([off, off, { ...off, title: "Signs", status: "unsure" }, { ...off, title: "Other" }])).toEqual([
		{ label: "en Full +1.20 s", count: 2 },
	]);
});
