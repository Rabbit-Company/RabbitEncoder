export interface FilmGrainProgress {
	frames: number;
	totalFrames?: number;
	percent?: number;
	speed?: string;
	eta?: string;
}

/** Read grav1synth's interactive progress line, including ANSI styled output. */
export function parseFilmGrainProgress(output: string): FilmGrainProgress | null {
	const clean = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
	const lines = clean.split(/[\r\n]+/);
	let last: FilmGrainProgress | null = null;
	for (const line of lines) {
		const counted = line.match(/\b(\d{1,3})%\s+(\d+)\/(\d+)\b/);
		const spinner = counted ? null : line.match(/\b(\d+) frames\s+\(\s*\d+(?:\.\d+)? (?:fps|s\/fr)\s*\)/);
		if (!counted && !spinner) continue;
		const frames = Number(counted?.[2] ?? spinner?.[1]);
		const totalFrames = counted ? Number(counted[3]) : undefined;
		if (!Number.isSafeInteger(frames) || frames < 0 || (totalFrames !== undefined && (!Number.isSafeInteger(totalFrames) || totalFrames <= 0))) continue;
		const speed = line.match(/\b\d+(?:\.\d+)? (?:fps|s\/fr)\b/)?.[0];
		const eta = line.match(/\beta\s+([^),\r\n]+)/)?.[1]?.trim();
		last = {
			frames,
			...(totalFrames !== undefined ? { totalFrames, percent: Math.min(100, Math.round((frames / totalFrames) * 100)) } : {}),
			...(speed ? { speed } : {}),
			...(eta ? { eta } : {}),
		};
	}
	return last;
}

/** One line for a step detail, such as "1,200 / 34,000 frames (41.20 fps, ETA 13m)". */
export function formatFilmGrainProgress(progress: FilmGrainProgress): string {
	const frames = `${progress.frames.toLocaleString()}${progress.totalFrames ? ` / ${progress.totalFrames.toLocaleString()}` : ""} frames`;
	const extra = [progress.speed, progress.eta ? `ETA ${progress.eta}` : ""].filter(Boolean).join(", ");
	return extra ? `${frames} (${extra})` : frames;
}
