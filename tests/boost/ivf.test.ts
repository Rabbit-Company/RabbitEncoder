import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { run } from "../../src/core/process";
import { readIvf, readIvfSize } from "../../src/boost/ivf";

const root = mkdtempSync(join(tmpdir(), "rabbit-ivf-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const obu = (type: number, payload: number[]) => [(type << 3) | 0x02, payload.length, ...payload];
const TD = obu(2, []);
// First payload byte of a frame header: show_existing_frame, then frame_type, then show_frame.
const KEY = obu(6, [0b0001_0000, 0xaa, 0xbb]);
const INTER = obu(6, [0b0011_0000, 0xaa]);
const SHOW_EXISTING = obu(3, [0b1000_0000]);
const SEQUENCE = obu(1, [0b0000_0000, 0x00]);
const STILL_SEQUENCE = obu(1, [0b0001_1000, 0x00]);
const STILL_FRAME = obu(6, [0b0000_0000]);

function ivf(units: number[][]): string {
	const header = Buffer.alloc(32);
	header.write("DKIF", 0);
	header.writeUInt16LE(0, 4);
	header.writeUInt16LE(32, 6);
	header.write("AV01", 8);
	header.writeUInt16LE(640, 12);
	header.writeUInt16LE(360, 14);
	header.writeUInt32LE(24000, 16);
	header.writeUInt32LE(1001, 20);
	header.writeUInt32LE(units.length, 24);
	const parts = [header];
	units.forEach((unit, i) => {
		const frame = Buffer.alloc(12);
		frame.writeUInt32LE(unit.length, 0);
		frame.writeBigUInt64LE(BigInt(i), 4);
		parts.push(frame, Buffer.from(unit));
	});
	const path = join(root, `${Math.random().toString(36).slice(2)}.ivf`);
	writeFileSync(path, Buffer.concat(parts));
	return path;
}

describe("readIvf", () => {
	it("reads the header and the size of every frame", () => {
		const info = readIvf(
			ivf([
				[...TD, ...SEQUENCE, ...KEY],
				[...TD, ...INTER],
			]),
		);
		expect(info).toMatchObject({ width: 640, height: 360, fpsNum: 24000, fpsDen: 1001 });
		expect(info.frames.map((f) => f.size)).toEqual([TD.length + SEQUENCE.length + KEY.length, TD.length + INTER.length]);
	});

	it("finds key frames by their frame header", () => {
		const info = readIvf(
			ivf([
				[...TD, ...SEQUENCE, ...KEY],
				[...TD, ...INTER],
				[...TD, ...SHOW_EXISTING],
				[...TD, ...SEQUENCE, ...KEY],
			]),
		);
		expect(info.frames.map((f) => f.keyframe)).toEqual([true, false, false, true]);
	});

	it("finds a key frame after a hidden frame in the same unit", () => {
		expect(readIvf(ivf([[...TD, ...INTER, ...KEY]])).frames[0]!.keyframe).toBe(true);
	});

	it("treats every frame of a reduced still picture sequence as a key frame", () => {
		expect(readIvf(ivf([[...TD, ...STILL_SEQUENCE, ...STILL_FRAME]])).frames[0]!.keyframe).toBe(true);
	});

	it("reads OBU sizes longer than one byte", () => {
		const payload = [0b0011_0000, ...new Array(200).fill(0)];
		const big = [(6 << 3) | 0x02, 0x80 | (payload.length & 0x7f), payload.length >> 7, ...payload];
		expect(readIvf(ivf([[...TD, ...big, ...KEY]])).frames[0]!.keyframe).toBe(true);
	});

	it("refuses a file that is not IVF", () => {
		const path = join(root, "not.ivf");
		writeFileSync(path, Buffer.alloc(64));
		expect(() => readIvf(path)).toThrow("not an IVF file");
	});
});

const canEncode = !!Bun.which("ffmpeg") && !!Bun.which("ffprobe");

(canEncode ? describe : describe.skip)("readIvf on a real AV1 stream", () => {
	it("finds the same key frames as ffprobe", async () => {
		const path = join(root, "real.ivf");
		const encoded = await run([
			"ffmpeg",
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"testsrc2=size=320x180:rate=24:duration=6",
			"-c:v",
			"libsvtav1",
			"-preset",
			"12",
			"-g",
			"30",
			"-f",
			"ivf",
			path,
		]);
		if (encoded.code !== 0) throw new Error(encoded.stderr);
		const probed = await run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=key_frame", "-of", "csv=p=0", path]);
		const expected = probed.stdout
			.split("\n")
			.filter(Boolean)
			.map((v) => v.trim().startsWith("1"));
		const info = readIvf(path);
		expect(info.frames).toHaveLength(144);
		expect(info.frames.map((f) => f.keyframe)).toEqual(expected);
		expect(expected.filter(Boolean).length).toBeGreaterThan(1);
	}, 60_000);
});

describe("readIvfSize", () => {
	it("reads the frame size before any frame is written", () => {
		expect(readIvfSize(ivf([]))).toEqual({ width: 640, height: 360 });
	});

	it("gives nothing for a file that is missing or not IVF yet", () => {
		expect(readIvfSize(join(root, "missing.ivf"))).toBeNull();
		const short = join(root, "short.ivf");
		writeFileSync(short, "DKIF");
		expect(readIvfSize(short)).toBeNull();
	});
});
