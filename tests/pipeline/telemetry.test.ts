import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTelemetry, initTelemetry, resetTelemetry, TelemetryRecorder } from "../../src/pipeline/telemetry";

function ivfHeader(): Buffer {
	const header = Buffer.alloc(32);
	header.write("DKIF", 0);
	header.writeUInt16LE(32, 6);
	return header;
}

function ivfFrame(bytes: number): Buffer {
	const frame = Buffer.alloc(12 + bytes);
	frame.writeUInt32LE(bytes, 0);
	return frame;
}

describe("Telemetry", () => {
	test("counts the frames an encoder has finished writing, per second", () => {
		const dir = mkdtempSync(join(tmpdir(), "telemetry-"));
		try {
			const ivf = join(dir, "final.ivf");
			const recorder = new TelemetryRecorder("job-a", { fps: 2, maxKbps: 0, rabbitBoost: true });
			recorder.followPass("final", ivf, 5);
			writeFileSync(ivf, Buffer.concat([ivfHeader(), ivfFrame(100), ivfFrame(200)]));
			appendFileSync(ivf, ivfFrame(300));
			// A frame still being written is left for the next read.
			appendFileSync(ivf, ivfFrame(400).subarray(0, 50));
			recorder.endPass("final");
			const pass = getTelemetry("job-a")!.final!;
			expect(pass.done).toBe(3);
			expect(pass.bytes).toEqual([300, 300]);
			expect(pass.frames).toEqual([2, 1]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("keeps a finished job's telemetry on disk", () => {
		const dir = mkdtempSync(join(tmpdir(), "telemetry-"));
		try {
			initTelemetry(dir, new Set(["job-b"]));
			const recorder = new TelemetryRecorder("job-b", { fps: 24, maxKbps: 6000, rabbitBoost: true });
			recorder.setZones([{ start: 0, end: 48, crf: 27.5, score: 71.234, fastKbps: 2000.4, predictedKbps: 1500.6, capped: false }], 30);
			recorder.finish();
			const saved = join(dir, "telemetry", "job-b.json");
			expect(JSON.parse(readFileSync(saved, "utf8")).zones).toEqual([
				{ start: 0, end: 48, crf: 27.5, score: 71.23, fastKbps: 2000, predictedKbps: 1501, capped: false },
			]);
			// A new run of the job starts empty.
			resetTelemetry("job-b", true);
			expect(getTelemetry("job-b")?.zones).toBeUndefined();
			expect(existsSync(saved)).toBe(false);
			recorder.finish();
			// Gone with its job.
			initTelemetry(dir, new Set());
			expect(existsSync(saved)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
