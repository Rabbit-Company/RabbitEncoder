import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import type { JobTelemetry, TelemetryPass, TelemetryZone } from "../core/types";
import { Logger } from "../core/logger";

const POLL_MS = 1000;
const IVF_FRAME_HEADER = 12;

const live = new Map<string, JobTelemetry>();
let storeDir = "";

/** Where finished jobs keep their telemetry. Files of jobs that no longer exist are removed. */
export function initTelemetry(tempDir: string, jobIds: Set<string>): void {
	storeDir = join(tempDir, "telemetry");
	mkdirSync(storeDir, { recursive: true });
	for (const name of readdirSync(storeDir)) {
		if (!jobIds.has(name.replace(/\.json$/, ""))) rmSync(join(storeDir, name), { force: true });
	}
}

const storePath = (jobId: string) => join(storeDir, `${jobId}.json`);

export function getTelemetry(jobId: string): JobTelemetry | null {
	const current = live.get(jobId);
	if (current) return current;
	if (!storeDir || !existsSync(storePath(jobId))) return null;
	try {
		const saved = JSON.parse(readFileSync(storePath(jobId), "utf8")) as JobTelemetry;
		live.set(jobId, saved);
		return saved;
	} catch {
		return null;
	}
}

/** A job starting again begins with empty telemetry, so the last run's graphs are not shown. */
export function resetTelemetry(jobId: string, rabbitBoost: boolean): void {
	live.set(jobId, { jobId, version: Date.now(), fps: 24, maxKbps: 0, rabbitBoost });
	if (storeDir) rmSync(storePath(jobId), { force: true });
}

export function deleteTelemetry(jobId: string): void {
	live.delete(jobId);
	if (storeDir) rmSync(storePath(jobId), { force: true });
}

/**
 * Frame sizes of an IVF file an encoder is still writing. Only the 12 byte
 * header of each frame is read, so following an encode costs one small read
 * per frame.
 */
class IvfTail {
	private fd: number | null = null;
	private at = 0;
	private readonly header = Buffer.alloc(IVF_FRAME_HEADER);

	constructor(private readonly path: string) {}

	read(onFrame: (bytes: number) => void): void {
		if (this.fd === null) {
			if (!existsSync(this.path)) return;
			this.fd = openSync(this.path, "r");
		}
		const size = fstatSync(this.fd).size;
		if (this.at === 0) {
			if (size < 32 || readSync(this.fd, this.header, 0, 8, 0) < 8) return;
			this.at = this.header.readUInt16LE(6);
		}
		while (this.at + IVF_FRAME_HEADER <= size) {
			if (readSync(this.fd, this.header, 0, IVF_FRAME_HEADER, this.at) < IVF_FRAME_HEADER) break;
			const bytes = this.header.readUInt32LE(0);
			if (this.at + IVF_FRAME_HEADER + bytes > size) break;
			onFrame(bytes);
			this.at += IVF_FRAME_HEADER + bytes;
		}
	}

	close(): void {
		if (this.fd !== null) closeSync(this.fd);
		this.fd = null;
	}
}

/** The telemetry of one encode, filled in as its passes run. */
export class TelemetryRecorder {
	private readonly data: JobTelemetry;
	private readonly follows = new Map<"fast" | "final", { tail: IvfTail; timer: ReturnType<typeof setInterval> }>();

	constructor(jobId: string, opts: { fps: number; maxKbps: number; rabbitBoost: boolean }) {
		this.data = { jobId, version: Date.now(), fps: opts.fps > 0 ? opts.fps : 24, maxKbps: opts.maxKbps, rabbitBoost: opts.rabbitBoost };
		live.set(jobId, this.data);
		if (storeDir) rmSync(storePath(jobId), { force: true });
	}

	/** Follow the IVF file a pass writes, until `endPass`. */
	followPass(pass: "fast" | "final", path: string, total: number): void {
		this.endPass(pass);
		const series: TelemetryPass = { bytes: [], frames: [], done: 0, total };
		this.data[pass] = series;
		this.data.version++;
		const tail = new IvfTail(path);
		this.follows.set(pass, { tail, timer: setInterval(() => this.drain(series, tail), POLL_MS) });
	}

	private drain(series: TelemetryPass, tail: IvfTail): void {
		const before = series.done;
		try {
			tail.read((bytes) => {
				const second = Math.floor(series.done / this.data.fps);
				series.bytes[second] = (series.bytes[second] ?? 0) + bytes;
				series.frames[second] = (series.frames[second] ?? 0) + 1;
				series.done++;
			});
		} catch (error) {
			Logger.debug(`[telemetry] Could not read an encode's IVF file: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (series.done !== before) this.data.version++;
	}

	/** Read what the pass wrote last and stop following it. */
	endPass(pass: "fast" | "final"): void {
		const follow = this.follows.get(pass);
		if (!follow) return;
		clearInterval(follow.timer);
		this.follows.delete(pass);
		const series = this.data[pass];
		if (series) this.drain(series, follow.tail);
		follow.tail.close();
	}

	setFastShare(share: number): void {
		this.data.fastShare = share;
		this.data.version++;
	}

	setZones(zones: TelemetryZone[], baseCrf: number): void {
		this.data.zones = zones.map(({ start, end, crf, score, fastKbps, predictedKbps, capped }) => ({
			start,
			end,
			crf,
			score: Math.round(score * 100) / 100,
			fastKbps: Math.round(fastKbps),
			predictedKbps: Math.round(predictedKbps),
			capped,
		}));
		this.data.baseCrf = baseCrf;
		this.data.version++;
	}

	/** Stop following every pass and keep the telemetry with the finished job. */
	finish(): void {
		for (const pass of [...this.follows.keys()]) this.endPass(pass);
		if (!storeDir) return;
		try {
			writeFileSync(storePath(this.data.jobId), JSON.stringify(this.data));
		} catch (error) {
			Logger.warn(`[telemetry] Could not save the telemetry of ${this.data.jobId}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
