import { describe, expect, test } from "bun:test";
import { compareQueuedJobs, queuePriority } from "../../src/queue/priority";

describe("queue priority", () => {
	test("places repairs before encodes regardless of insertion order", () => {
		const jobs = [
			{ kind: "encode" as const, queueOrder: 1 },
			{ kind: "repair" as const, queueOrder: 4 },
			{ queueOrder: 2 },
			{ kind: "repair" as const, queueOrder: 3 },
		].sort(compareQueuedJobs);

		expect(jobs.map((job) => job.kind ?? "encode")).toEqual(["repair", "repair", "encode", "encode"]);
		expect(jobs.map((job) => job.queueOrder)).toEqual([3, 4, 1, 2]);
	});

	test("preserves FIFO order within each priority class", () => {
		const jobs = [
			{ kind: "repair" as const, queueOrder: 9 },
			{ kind: "repair" as const, queueOrder: 5 },
			{ kind: "encode" as const, queueOrder: 8 },
			{ kind: "encode" as const, queueOrder: 2 },
		].sort(compareQueuedJobs);

		expect(jobs.map((job) => job.queueOrder)).toEqual([5, 9, 2, 8]);
	});

	test("treats legacy jobs without a kind as encodes", () => {
		expect(queuePriority({ queueOrder: 1 })).toBe(queuePriority({ kind: "encode", queueOrder: 1 }));
	});
});
