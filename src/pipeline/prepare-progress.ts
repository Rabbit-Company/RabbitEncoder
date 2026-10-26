/** Progress values reported by MKVToolNix in GUI mode. */
export function mkvtoolnixProgress(line: string): number | null {
	const match = /^#GUI#progress\s+(\d{1,3})%$/.exec(line.trim());
	if (!match) return null;
	return Math.min(100, Number(match[1]));
}

/** FFmpeg reports output time in microseconds while copying or filtering video. */
export function ffmpegProgress(line: string, durationSeconds: number): number | null {
	if (!(durationSeconds > 0)) return null;
	const match = /^out_time_(?:us|ms)=(-?\d+)$/.exec(line.trim());
	if (!match) return null;
	return Math.max(0, Math.min(1, Number(match[1]) / (durationSeconds * 1_000_000)));
}

export function preparePhaseProgress(start: number, end: number, fraction: number): number {
	return start + (end - start) * Math.max(0, Math.min(1, fraction));
}
