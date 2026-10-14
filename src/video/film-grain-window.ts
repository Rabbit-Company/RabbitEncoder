const WINDOW_SECONDS = 30;

export interface FilmGrainWindow {
	startSeconds: number;
	frames: number;
}

/** A fixed window keeps preview options from changing the table used by the final encode. */
export function representativeFilmGrainWindow(duration: number, fps: number): FilmGrainWindow | null {
	if (!Number.isFinite(duration) || !Number.isFinite(fps) || fps <= 0 || duration < WINDOW_SECONDS * 2) return null;
	return { startSeconds: (duration - WINDOW_SECONDS) / 2, frames: Math.round(WINDOW_SECONDS * fps) };
}
