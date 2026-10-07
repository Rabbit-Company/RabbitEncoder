import { readFileSync } from "fs";

export class CancelledError extends Error {
	constructor() {
		super("Encoding cancelled");
		this.name = "CancelledError";
	}
}

export async function run(cmd: string[], opts?: { cwd?: string; signal?: AbortSignal }): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(cmd, {
		stdout: "pipe",
		stderr: "pipe",
		cwd: opts?.cwd,
	});

	let onAbort: (() => void) | undefined;
	if (opts?.signal) {
		onAbort = () => {
			try {
				proc.kill("SIGTERM");
			} catch {}
			setTimeout(() => {
				try {
					proc.kill("SIGKILL");
				} catch {}
			}, 3000);
		};
		if (opts.signal.aborted) {
			onAbort();
		} else {
			opts.signal.addEventListener("abort", onAbort, { once: true });
		}
	}

	const stdoutText = await new Response(proc.stdout).text().catch(() => "");
	const stderrText = await new Response(proc.stderr).text().catch(() => "");
	const code = await proc.exited;

	if (onAbort && opts?.signal) {
		opts.signal.removeEventListener("abort", onAbort);
	}

	return { code, stdout: stdoutText.trim(), stderr: stderrText.trim() };
}

export function humanSize(bytes: number): string {
	const units = ["B", "KiB", "MiB", "GiB", "TiB"];
	let i = 0;
	let val = bytes;
	while (val >= 1024 && i < units.length - 1) {
		val /= 1024;
		i++;
	}
	return `${val.toFixed(2)} ${units[i]}`;
}

export function fmtFrames(current: number, total: number): string {
	return `${current.toLocaleString()} / ${total.toLocaleString()} frames`;
}

export function computeFps(currentFrames: number, startedAt: number | undefined): string | null {
	if (!startedAt || currentFrames <= 0) return null;
	const elapsedSec = (Date.now() - startedAt) / 1000;
	if (elapsedSec < 1) return null;
	const fps = currentFrames / elapsedSec;
	return fps.toFixed(2);
}

export function pct2(current: number, total: number): number {
	if (total <= 0) return 0;
	return Math.round((current / total) * 10000) / 100;
}

export function escapeXml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function describeExitCode(code: number): string {
	if (code < 128) return `Process exited with code ${code}`;

	const signal = code - 128;
	const signals: Record<number, string> = {
		1: "SIGHUP (hangup)",
		2: "SIGINT (interrupted)",
		4: "SIGILL (illegal instruction)",
		6: "SIGABRT (aborted)",
		7: "SIGBUS (bus error)",
		8: "SIGFPE (floating point exception)",
		9: "SIGKILL (killed)",
		11: "SIGSEGV (segmentation fault)",
		15: "SIGTERM (terminated)",
	};

	return signals[signal] || `Signal ${signal}`;
}

function readTimecodeLines(timecodesPath: string): string[] {
	return readFileSync(timecodesPath, "utf-8")
		.split("\n")
		.filter((l) => l.trim() && !l.startsWith("#"));
}

export function countTimecodes(timecodesPath: string): number {
	return readTimecodeLines(timecodesPath).length;
}

export function isTimecodesVFR(timecodesPath: string, toleranceMs = 2): boolean {
	const lines = readTimecodeLines(timecodesPath);

	if (lines.length < 3) return false;

	const timestamps = lines.map(Number);
	const deltas = [];
	for (let i = 1; i < timestamps.length; i++) {
		deltas.push(timestamps[i]! - timestamps[i - 1]!);
	}

	const median = deltas.toSorted((a, b) => a - b)[Math.floor(deltas.length / 2)];
	return deltas.some((d) => Math.abs(d - median!) > toleranceMs);
}
