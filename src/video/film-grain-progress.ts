export interface FilmGrainProgress {
	/** What apply, remove and export are doing, as "Verifying with dav1d". */
	stage?: string;
	frames: number;
	totalFrames?: number;
	percent?: number;
	speed?: string;
	eta?: string;
}

/** apply, remove and export go through the video in stages, and their percent counts for the whole command. */
export type RegrainStage = "read" | "write" | "verify";

const STAGE_NAMES: Record<RegrainStage, string> = { read: "Reading", write: "Writing", verify: "Verifying with dav1d" };

export type RegrainFrameProgress = {
	event: "progress";
	stage?: RegrainStage;
	frames: number;
	total?: number | null;
	percent?: number | null;
	fps?: number;
	eta_seconds?: number | null;
};
/** stats and check count entries of the table instead of frames. */
export type RegrainEntryProgress = {
	event: "progress";
	entries: number;
	total: number;
	percent: number;
	entries_per_second?: number;
	eta_seconds?: number | null;
	frames?: undefined;
};

/** One event from `regrain --progress json`, which writes one JSON object per line. */
export type RegrainEvent =
	| { event: "start"; frames?: number | null; entries?: number }
	| RegrainFrameProgress
	| RegrainEntryProgress
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

export function progressFromEvent(event: RegrainFrameProgress): FilmGrainProgress {
	const total = event.total ?? undefined;
	// A stage's frames are only part of the command, so its own percent is the one that counts.
	const percent = event.stage
		? typeof event.percent === "number"
			? Math.min(100, Math.round(event.percent))
			: undefined
		: total
			? Math.min(100, Math.round((event.frames / total) * 100))
			: undefined;
	return {
		...(event.stage ? { stage: STAGE_NAMES[event.stage] ?? event.stage } : {}),
		frames: event.frames,
		...(total ? { totalFrames: total } : {}),
		...(percent !== undefined ? { percent } : {}),
		// The first report of a stage comes before there is a speed.
		...(event.fps ? { speed: `${event.fps.toFixed(1)} fps` } : {}),
		...(event.eta_seconds !== undefined && event.eta_seconds !== null ? { eta: formatDuration(event.eta_seconds) } : {}),
	};
}

/** One line for a step detail, such as "Verifying with dav1d: 1,200 / 34,000 frames (41.2 fps, ETA 13m 5s)". */
export function formatFilmGrainProgress(progress: FilmGrainProgress): string {
	const frames = `${progress.stage ? `${progress.stage}: ` : ""}${progress.frames.toLocaleString()}${progress.totalFrames ? ` / ${progress.totalFrames.toLocaleString()}` : ""} frames`;
	const extra = [progress.speed, progress.eta ? `ETA ${progress.eta}` : ""].filter(Boolean).join(", ");
	return extra ? `${frames} (${extra})` : frames;
}
