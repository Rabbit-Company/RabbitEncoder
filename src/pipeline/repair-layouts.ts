import { basename } from "path";
import type { RepairInspectionFile, RepairLayoutTrackPlan, RepairPlan, RepairSourceLayout, RepairSubtitleTrack, RepairSubtitleTrackPlan } from "../core/types";
import { extractGroupFromTitle } from "../tracks/tracks";
import { repairAuditGroupLabel, sanitizeRepairPlan } from "./repair";

/**
 * Sources with the same subtitle tracks in the same order share a signature.
 * Track IDs are left out, so a plan made for one file can be mapped onto the
 * others by position.
 */
export function subtitleLayoutSignature(subtitles: RepairSubtitleTrack[]): string {
	return JSON.stringify(subtitles.map((track) => [track.codecId || track.codec, track.language, track.title, track.isForced]));
}

/** Group sources by subtitle layout. The largest layout comes first and gets label A. */
export function groupSourceLayouts(files: RepairInspectionFile[]): RepairSourceLayout[] {
	const groups: { signature: string; firstIndex: number; files: RepairInspectionFile[] }[] = [];
	files.forEach((file, index) => {
		const signature = subtitleLayoutSignature(file.subtitles);
		const existing = groups.find((group) => group.signature === signature);
		if (existing) existing.files.push(file);
		else groups.push({ signature, firstIndex: index, files: [file] });
	});
	return groups
		.sort((a, b) => b.files.length - a.files.length || a.firstIndex - b.firstIndex)
		.map((group, index) => ({
			signature: group.signature,
			label: repairAuditGroupLabel(index),
			sourcePaths: group.files.map((file) => file.path),
			tracks: group.files[0]!.subtitles.map((track, position) => ({ ...track, position, releaseGroup: extractGroupFromTitle(track.title) })),
		}));
}

/** Turn a plan that names source track IDs into one that names positions. */
export function planToLayoutTracks(tracks: RepairSubtitleTrackPlan[], subtitles: RepairSubtitleTrack[]): RepairLayoutTrackPlan[] {
	return tracks.flatMap(({ source, trackId, ...rest }) => {
		const position = subtitles.findIndex((track) => track.id === trackId);
		return source === "source" && position >= 0 ? [{ ...rest, position }] : [];
	});
}

/**
 * One repair plan for every pair, built from the plan of the layout its source
 * belongs to. A source whose layout has no plan means the files changed since
 * the layouts were read, so nothing is queued.
 */
export function buildLayoutRepairPlans(options: {
	pairs: { targetPath: string; sourcePath: string }[];
	sources: Map<string, RepairInspectionFile>;
	layouts: { signature: string; tracks: RepairLayoutTrackPlan[] }[];
	replaceTarget: boolean;
}): RepairPlan[] {
	const { pairs, sources, layouts, replaceTarget } = options;
	const bySignature = new Map(layouts.map((layout) => [layout.signature, layout]));
	return pairs.map((pair) => {
		const source = sources.get(pair.sourcePath);
		if (!source) throw new Error(`${basename(pair.sourcePath)} could not be inspected`);
		const layout = bySignature.get(subtitleLayoutSignature(source.subtitles));
		if (!layout) throw new Error(`The subtitles of ${basename(pair.sourcePath)} changed since the layouts were read. Read them again.`);
		if (!Array.isArray(layout.tracks)) throw new Error("Every layout needs a track list");
		const tracks = layout.tracks.map((track, order): RepairSubtitleTrackPlan => {
			const subtitle = source.subtitles[Number(track?.position)];
			if (!Number.isInteger(Number(track?.position)) || !subtitle) throw new Error(`Track ${order + 1} of a layout points at a subtitle that does not exist`);
			if (track.mode === "rabbit" && !subtitle.canRabbitProcess)
				throw new Error(`${subtitle.title || `Subtitle ${subtitle.id}`} (${subtitle.codec}) cannot use Rabbit defaults`);
			const { position: _position, ...rest } = track;
			return { ...rest, source: "source", trackId: subtitle.id, order };
		});
		return sanitizeRepairPlan({ targetPath: pair.targetPath, sourcePath: pair.sourcePath, replaceTarget, tracks });
	});
}
