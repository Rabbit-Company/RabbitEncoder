import { statSync, unlinkSync } from "fs";
import { basename, join } from "path";
import { Logger } from "../core/logger";
import { CancelledError, run } from "../core/process";

/**
 * Trial-mux `file` with and without zlib and report whether compression
 * shrinks the muxed track by at least `minSavingsPct` percent. Matroska zlib
 * is applied per block, so short subtitle events often *grow* — measuring
 * real mkvmerge output is the only exact way to know. Any probe failure
 * returns false (leave the track uncompressed).
 */
export async function zlibWorthIt(file: string, tempDir: string, minSavingsPct: number, signal?: AbortSignal): Promise<boolean> {
	const tag = basename(file).replace(/[^\w.-]/g, "_");
	const outNone = join(tempDir, `zprobe_none_${tag}.mkv`);
	const outZlib = join(tempDir, `zprobe_zlib_${tag}.mkv`);
	try {
		const rn = await run(["mkvmerge", "-o", outNone, "--compression", "0:none", file], { signal });
		if (rn.code > 1) return false; // mkvmerge exit 1 = warnings only
		const rz = await run(["mkvmerge", "-o", outZlib, "--compression", "0:zlib", file], { signal });
		if (rz.code > 1) return false;
		const noneSize = statSync(outNone).size;
		const zlibSize = statSync(outZlib).size;
		if (noneSize <= 0) return false;
		const savings = ((noneSize - zlibSize) / noneSize) * 100;
		Logger.info(`[subtitle] zlib probe ${tag}: ${noneSize} -> ${zlibSize} B (${savings.toFixed(1)}% savings, threshold ${minSavingsPct}%)`);
		return savings >= minSavingsPct;
	} catch (err) {
		// Cancellation is not a failed compression experiment. Propagate it so a
		// sibling stage failure immediately tears down subtitle preparation.
		if (signal?.aborted) {
			const reason = (signal as AbortSignal & { reason?: unknown }).reason;
			if (reason instanceof Error) throw reason;
			throw new CancelledError();
		}
		Logger.warn(`[subtitle] zlib probe failed for ${tag}; leaving uncompressed: ${err}`);
		return false;
	} finally {
		for (const f of [outNone, outZlib]) {
			try {
				unlinkSync(f);
			} catch {}
		}
	}
}
