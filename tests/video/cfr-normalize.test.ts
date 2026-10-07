import { describe, expect, it } from "bun:test";
import { buildCfrFilter, planCfrNormalization } from "../../src/video/cfr-normalize";

/** Millisecond-rounded timestamps for the given grid slots, like a Matroska file stores them. */
function timecodes(slots: number[], fpsNum: number, fpsDen: number): number[] {
	return slots.map((s) => Math.round((s * 1000 * fpsDen) / fpsNum));
}

function range(count: number, skip: number[] = []): number[] {
	const skipped = new Set(skip);
	const slots = [];
	for (let i = 0; slots.length < count; i++) {
		if (!skipped.has(i)) slots.push(i);
	}
	return slots;
}

describe("planCfrNormalization", () => {
	it("plans a fill for a 24 fps source with dropped frames", () => {
		const slots = range(28348, [500, 3000, 3001, 7000, 9000, 12000, 15000, 20000, 25000, 28000]);
		const plan = planCfrNormalization(timecodes(slots, 24, 1), 28348, "24/1");

		expect(plan).not.toBeNull();
		expect(plan!.fpsNum).toBe(24);
		expect(plan!.fpsDen).toBe(1);
		expect(plan!.totalFrames).toBe(28358);
		expect(plan!.gaps[0]).toEqual({ beforeFrame: 500, missing: 1 });
		expect(plan!.gaps[1]).toEqual({ beforeFrame: 2999, missing: 2 });
		expect(plan!.gaps).toHaveLength(9);
	});

	it("finds the real rate when the container hint is wrong", () => {
		const slots = range(10000, [1234]);
		const plan = planCfrNormalization(timecodes(slots, 24000, 1001), 10000, "24/1");

		expect(plan!.fpsNum).toBe(24000);
		expect(plan!.fpsDen).toBe(1001);
		expect(plan!.totalFrames).toBe(10001);
	});

	it("counts frames missing before the first and after the last frame", () => {
		const slots = range(5000, [0, 1, 2500]);
		const tc = timecodes(slots, 25, 1);
		// mkvextract's extra entry: the last frame lasts two frame intervals.
		tc.push(tc[tc.length - 1]! + 80);
		const plan = planCfrNormalization(tc, 5000, "25/1");

		expect(plan!.leading).toBe(2);
		expect(plan!.trailing).toBe(1);
		expect(plan!.gaps).toEqual([{ beforeFrame: 2498, missing: 1 }]);
		expect(plan!.totalFrames).toBe(5004);
	});

	it("ignores the extra end timestamp when the last frame has a normal duration", () => {
		const tc = timecodes(range(5000, [100]), 24000, 1001);
		tc.push(tc[tc.length - 1]! + 42);

		expect(planCfrNormalization(tc, 5000, "24000/1001")!.totalFrames).toBe(5001);
	});

	it("leaves a clean CFR source alone", () => {
		expect(planCfrNormalization(timecodes(range(5000), 24000, 1001), 5000, "24000/1001")).toBeNull();
	});

	it("leaves a mixed-rate source alone", () => {
		const tc: number[] = [];
		let t = 0;
		for (let i = 0; i < 5000; i++) {
			tc.push(Math.round(t));
			t += i > 2000 && i < 2600 ? 1001 / 30 : 1001 / 24;
		}

		expect(planCfrNormalization(tc, 5000, "24000/1001")).toBeNull();
	});

	it("leaves a source alone when 60 fps footage is mostly shown at 30 fps", () => {
		// Fits a 60 fps grid, but half the slots are empty: not a few dropped frames.
		const slots = [...range(1000), ...range(3000).map((i) => 1000 + i * 2)];

		expect(planCfrNormalization(timecodes(slots, 60, 1), 4000, "60/1")).toBeNull();
	});

	it("leaves a source alone when too many frames are missing", () => {
		const skip = Array.from({ length: 200 }, (_, i) => 10 + i * 20);

		expect(planCfrNormalization(timecodes(range(5000, skip), 24, 1), 5000, "24/1")).toBeNull();
	});

	it("leaves a source alone when the timecode count does not match the frames", () => {
		expect(planCfrNormalization(timecodes(range(5000, [100]), 24, 1), 4990, "24/1")).toBeNull();
	});
});

describe("buildCfrFilter", () => {
	it("places frames on the grid by index and fills the gaps", () => {
		const plan = planCfrNormalization(timecodes(range(5000, [100, 200, 201]), 24000, 1001), 5000, "24000/1001")!;

		expect(buildCfrFilter(plan)).toBe("settb=1001/24000,setpts=N+1*gte(N\\,100)+2*gte(N\\,199),fps=24000/1001");
	});

	it("pads the start and end when frames are missing there", () => {
		const tc = timecodes(range(5000, [0]), 25, 1);
		tc.push(tc[tc.length - 1]! + 120);
		const plan = planCfrNormalization(tc, 5000, "25/1")!;

		expect(buildCfrFilter(plan)).toBe("settb=1/25,setpts=N,fps=25/1,tpad=start_mode=clone:start=1:stop_mode=clone:stop=2");
	});
});
