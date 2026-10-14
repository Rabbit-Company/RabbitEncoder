export interface FilmGrainProgress {
	frames: number;
	totalFrames?: number;
	percent?: number;
	speed?: string;
	eta?: string;
}

/** One event from `regrain --progress json`, which writes one JSON object per line. */
export type RegrainEvent =
	| { event: "start"; frames?: number | null }
	| { event: "progress"; frames: number; total?: number | null; percent?: number | null; fps?: number; eta_seconds?: number | null }
	| { event: "summary"; entries?: number; frames?: number; warnings?: { code: string; message: string }[] }
	| { event: "error"; code: string; message: string };

export function parseRegrainEvent(line: string): RegrainEvent | null {
	const text = line.trim();
	if (!text.startsWith("{")) return null;
	try {
		const value = JSON.parse(text) as { event?: unknown };
		return typeof value.event === "string" ? (value as RegrainEvent) : null;
	} catch {
		return null;
	}
}

function formatDuration(seconds: number): string {
	const whole = Math.max(0, Math.round(seconds));
	if (whole >= 3600) return `${Math.floor(whole / 3600)}h ${Math.floor((whole % 3600) / 60)}m`;
	if (whole >= 60) return `${Math.floor(whole / 60)}m ${whole % 60}s`;
	return `${whole}s`;
}

export function progressFromEvent(event: Extract<RegrainEvent, { event: "progress" }>): FilmGrainProgress {
	const total = event.total ?? undefined;
	return {
		frames: event.frames,
		...(total ? { totalFrames: total, percent: Math.min(100, Math.round((event.frames / total) * 100)) } : {}),
		...(event.fps !== undefined ? { speed: `${event.fps.toFixed(1)} fps` } : {}),
		...(event.eta_seconds !== undefined && event.eta_seconds !== null ? { eta: formatDuration(event.eta_seconds) } : {}),
	};
}

/** One line for a step detail, such as "1,200 / 34,000 frames (41.2 fps, ETA 13m 5s)". */
export function formatFilmGrainProgress(progress: FilmGrainProgress): string {
	const frames = `${progress.frames.toLocaleString()}${progress.totalFrames ? ` / ${progress.totalFrames.toLocaleString()}` : ""} frames`;
	const extra = [progress.speed, progress.eta ? `ETA ${progress.eta}` : ""].filter(Boolean).join(", ");
	return extra ? `${frames} (${extra})` : frames;
}
