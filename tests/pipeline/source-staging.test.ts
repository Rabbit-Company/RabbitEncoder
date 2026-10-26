import { describe, expect, test } from "bun:test";
import { shouldStageSource } from "../../src/pipeline/source-staging";

describe("source staging", () => {
	test("stages NFS or SMB sources into local temp storage", () => {
		expect(shouldStageSource(0x6969, 0xef53)).toBe(true);
		expect(shouldStageSource(0xff534d42, 0xef53)).toBe(true);
		expect(shouldStageSource(0xfe534d42, 0xef53)).toBe(true);
	});

	test("does not copy local sources or copy between network folders", () => {
		expect(shouldStageSource(0xef53, 0xef53)).toBe(false);
		expect(shouldStageSource(0x6969, 0x6969)).toBe(false);
	});
});
