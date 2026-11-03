import { unlinkSync } from "fs";
import { join } from "path";
import { describeExitCode, run } from "../core/process";

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Frames done from one line of SVT-AV1 progress, "Encoding frame 123" or "Encoding: 123 Frames @ ...". */
export function svtProgressFrame(line: string): number | null {
	const clean = line.replace(ANSI, "").trim();
	const m = clean.match(/Encoding frame\s+(\d+)/i) || clean.match(/Encoding:\s*(\d+)\s+Frames?\b/i);
	const frame = m ? parseInt(m[1]!, 10) : NaN;
	return Number.isFinite(frame) && frame > 0 ? frame : null;
}

/**
 * The CRF an encode ran at, from SVT-AV1's config line: "CRF / medium (35)"
 * where a quality preset was given, "CRF / 30.00" for --crf.
 */
export function svtCrfFromLog(log: string): number | null {
	const m = log.replace(ANSI, "").match(/BRC mode[^:\n]*:\s*CRF\s*\/\s*(?:[a-z]+\s*\(([\d.]+)\)|([\d.]+))/i);
	const crf = m ? parseFloat(m[1] ?? m[2]!) : NaN;
	return Number.isFinite(crf) ? crf : null;
}

export interface SvtRun {
	binary: string;
	/** Video FFmpeg decodes and pipes in as 10-bit y4m. */
	input: string;
	/** Encoder arguments besides input, progress and output. */
	args: string[];
	output: string;
	/** Folder for the y4m FIFO. */
	workDir: string;
	label: string;
	signal?: AbortSignal;
	/** Called with the frames done and the encoder's log so far. */
	onFrame?: (frame: number, log: string) => void;
}

/**
 * Encodes `input` with SVT-AV1 through a FIFO, as some builds treat any
 * other input path as a file to open with FFMS2. Returns the encoder's log.
 */
export async function runSvt(o: SvtRun): Promise<string> {
	const fifo = join(o.workDir, `${o.label.replace(/\W+/g, "_")}.y4m`);
	try {
		unlinkSync(fifo);
	} catch {}
	const made = await run(["mkfifo", fifo], { signal: o.signal });
	if (made.code !== 0) throw new Error(`Could not create the encode FIFO: ${made.stderr || made.stdout}`);

	const ffmpeg = Bun.spawn(
		["ffmpeg", "-nostdin", "-y", "-i", o.input, "-fps_mode", "passthrough", "-f", "yuv4mpegpipe", "-strict", "-1", "-pix_fmt", "yuv420p10le", fifo],
		{ stdout: "ignore", stderr: "ignore", cwd: o.workDir },
	);
	const encoder = Bun.spawn([o.binary, "-i", fifo, "--progress", "2", ...o.args, "-b", o.output], {
		stdout: "ignore",
		stderr: "pipe",
		cwd: o.workDir,
	});
	const kill = () => {
		for (const p of [ffmpeg, encoder]) {
			try {
				p.kill("SIGTERM");
			} catch {}
		}
		setTimeout(() => {
			for (const p of [ffmpeg, encoder]) {
				try {
					p.kill("SIGKILL");
				} catch {}
			}
		}, 3000);
	};
	o.signal?.addEventListener("abort", kill, { once: true });

	let stderr = "";
	const reading = (async () => {
		const reader = encoder.stderr.getReader();
		const decoder = new TextDecoder();
		let pending = "";
		const line = (text: string) => {
			const frame = svtProgressFrame(text);
			if (frame !== null) o.onFrame?.(frame, stderr);
		};
		while (true) {
			let chunk;
			try {
				chunk = await reader.read();
			} catch {
				break;
			}
			if (chunk.done) break;
			const text = decoder.decode(chunk.value, { stream: true });
			stderr += text;
			pending += text;
			const lines = pending.split(/\r|\n/);
			pending = lines.pop() ?? "";
			for (const l of lines) line(l);
		}
		if (pending.trim()) line(pending);
	})();

	const code = await encoder.exited;
	try {
		ffmpeg.kill("SIGTERM");
	} catch {}
	await ffmpeg.exited;
	await reading;
	o.signal?.removeEventListener("abort", kill);
	try {
		unlinkSync(fifo);
	} catch {}
	if (o.signal?.aborted) throw new Error(`${o.label} cancelled`);
	if (code !== 0) throw new Error(`${o.label} failed (exit ${code}): ${stderr.trim().slice(-500) || describeExitCode(code)}`);
	return stderr;
}
