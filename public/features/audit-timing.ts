import type { RepairAuditTimingTrack, SubtitleTimeMap } from "../types";

const FRAME_RATES: Array<[number, string]> = [
	[24 / 23.976, "24 -> 23.976 fps"],
	[23.976 / 24, "23.976 -> 24 fps"],
	[25 / 23.976, "25 -> 23.976 fps"],
	[23.976 / 25, "23.976 -> 25 fps"],
	[25 / 24, "25 -> 24 fps"],
	[24 / 25, "24 -> 25 fps"],
];

export const IDENTITY_TIME_MAP: SubtitleTimeMap = { scale: 1, pieces: [{ fromMs: 0, offsetMs: 0 }] };

export function formatShift(ms: number): string {
	return `${ms >= 0 ? "+" : "-"}${(Math.abs(ms) / 1000).toFixed(2)} s`;
}

function clock(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	const h = Math.floor(seconds / 3600);
	const m = Math.floor(seconds / 60) % 60;
	const s = String(seconds % 60).padStart(2, "0");
	return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** What a map does to a track, such as "+1.20 s" or "25 -> 23.976 fps, +0.50 s, then +3.10 s from 12:40". */
export function describeTimeMap(map: SubtitleTimeMap): string {
	const parts: string[] = [];
	if (map.scale !== 1) parts.push(FRAME_RATES.find(([scale]) => Math.abs(scale - map.scale) < 1e-6)?.[1] ?? `speed x${map.scale.toFixed(4)}`);
	const [first, ...rest] = map.pieces;
	if (first && (first.offsetMs !== 0 || !parts.length || rest.length)) parts.push(formatShift(first.offsetMs));
	if (rest.length) parts.push(`then ${rest.map((piece) => `${formatShift(piece.offsetMs)} from ${clock(piece.fromMs)}`).join(", ")}`);
	return parts.join(", ");
}

/** The map with every part moved by `extraMs` more. */
export function withExtraShift(map: SubtitleTimeMap, extraMs: number): SubtitleTimeMap {
	return { scale: map.scale, pieces: map.pieces.map((piece) => ({ fromMs: piece.fromMs, offsetMs: Math.round(piece.offsetMs + extraMs) })) };
}

export function isIdentityTimeMap(map: SubtitleTimeMap): boolean {
	return map.scale === 1 && map.pieces.every((piece) => piece.offsetMs === 0);
}

/**
 * Changes the same track needs in several files, such as "eng Full +1.20 s
 * in 12 files". The same shift across a release group points at the release,
 * where a single file off on its own is a one-off.
 */
export function timingPatterns(tracks: Pick<RepairAuditTimingTrack, "language" | "title" | "status" | "map">[]): Array<{ label: string; count: number }> {
	const counts = new Map<string, number>();
	for (const track of tracks) {
		if (track.status !== "off" || !track.map) continue;
		const label = `${track.language}${track.title ? ` ${track.title}` : ""} ${describeTimeMap(track.map)}`;
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	return [...counts]
		.filter(([, count]) => count > 1)
		.map(([label, count]) => ({ label, count }))
		.sort((a, b) => b.count - a.count);
}
