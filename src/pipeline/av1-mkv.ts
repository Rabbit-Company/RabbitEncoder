import { existsSync, readFileSync, renameSync, statSync } from "fs";
import { basename, join } from "path";
import { CancelledError, run } from "../core/process";
import type { ProbeResult } from "../core/types";
import { applyColorMetadata } from "../video/color-metadata";

/** Shared by the tools that change the AV1 video of an MKV in place: take the track out, change it, and put it back. */

export interface MkvTrackJson {
	id: number;
	type: string;
	codec: string;
	properties: Record<string, unknown>;
}

export interface MkvJson {
	tracks?: MkvTrackJson[];
	attachments?: unknown[];
	chapters?: { num_entries?: number }[];
	global_tags?: { num_entries?: number }[];
	container?: { properties?: { duration?: number } };
}

export async function identify(path: string, signal?: AbortSignal): Promise<MkvJson> {
	const result = await run(["mkvmerge", "-J", path], { signal });
	if (signal?.aborted) throw new CancelledError();
	if (result.code !== 0 && result.code !== 1) throw new Error(`mkvmerge could not read ${basename(path)}: ${(result.stderr || result.stdout).slice(-300)}`);
	return JSON.parse(result.stdout) as MkvJson;
}

/** The AV1 video track of an MKV, or why the file cannot be changed. `subject` names what would change, such as "HDR metadata". */
export function videoTrackOf(identified: MkvJson, subject: string): { track?: MkvTrackJson; reason?: string } {
	const videos = (identified.tracks ?? []).filter((track) => track.type === "video");
	if (videos.length !== 1) return { reason: `The file has ${videos.length} video tracks, ${subject} can only be changed with exactly one` };
	const track = videos[0]!;
	if (track.properties.codec_id !== "V_AV1") return { reason: `The video is ${track.codec}, ${subject} can only be changed in AV1` };
	return { track };
}

/** mkvmerge options that give the new video track the properties of the old one. */
export function videoTrackOptions(track: MkvTrackJson, timestampsPath: string | null): string[] {
	const p = track.properties;
	const flag = (value: unknown) => (value === true ? "yes" : "no");
	const options: string[] = [];
	if (timestampsPath) options.push("--timestamps", `0:${timestampsPath}`);
	const language = typeof p.language_ietf === "string" ? p.language_ietf : typeof p.language === "string" ? p.language : "";
	if (language) options.push("--language", `0:${language}`);
	if (typeof p.track_name === "string" && p.track_name) options.push("--track-name", `0:${p.track_name}`);
	if (typeof p.default_track === "boolean") options.push("--default-track-flag", `0:${flag(p.default_track)}`);
	if (typeof p.forced_track === "boolean") options.push("--forced-display-flag", `0:${flag(p.forced_track)}`);
	if (typeof p.enabled_track === "boolean") options.push("--track-enabled-flag", `0:${flag(p.enabled_track)}`);
	if (typeof p.flag_original === "boolean") options.push("--original-flag", `0:${flag(p.flag_original)}`);
	return options;
}

/** Extracts the video track as IVF, with its frame timestamps. `timestamps` is null when mkvextract wrote none. */
export async function extractAv1Track(
	path: string,
	track: MkvTrackJson,
	dir: string,
	signal?: AbortSignal,
): Promise<{ ivf: string; timestamps: string | null }> {
	const ivf = join(dir, "video.ivf");
	const timestamps = join(dir, "timestamps.txt");
	const extracted = await run(["mkvextract", path, "tracks", `${track.id}:${ivf}`, "timestamps_v2", `${track.id}:${timestamps}`], { signal });
	if (signal?.aborted) throw new CancelledError();
	if (extracted.code !== 0 || !existsSync(ivf)) throw new Error(`mkvextract failed: ${(extracted.stderr || extracted.stdout).slice(-500)}`);
	return { ivf, timestamps: existsSync(timestamps) && statSync(timestamps).size > 0 ? timestamps : null };
}

function trackSignature(identified: MkvJson): string[] {
	return (identified.tracks ?? [])
		.filter((track) => track.type !== "video")
		.map((track) => `${track.type}:${track.properties.codec_id}:${track.properties.language ?? ""}:${track.properties.track_name ?? ""}`);
}

export interface ReplaceVideoOptions {
	targetPath: string;
	stagePath: string;
	/** mkvmerge -J of the target before the change. */
	original: MkvJson;
	track: MkvTrackJson;
	/** The changed video as IVF. */
	video: string;
	timestamps: string | null;
	/** The colour elements the new video track gets. */
	probe: ProbeResult;
	tempDir: string;
	signal?: AbortSignal;
	onProgress?: (progress: number, detail: string) => void;
}

/**
 * Builds a copy of the MKV with the new video and every other track, attachment, chapter and tag of the old one,
 * checks that only the video changed, and moves it over the original.
 */
export async function replaceVideoTrack(opts: ReplaceVideoOptions): Promise<void> {
	const { signal, stagePath, original } = opts;
	const checkCancelled = () => {
		if (signal?.aborted) throw new CancelledError();
	};
	opts.onProgress?.(10, "Rebuilding the MKV");
	const merged = await run(["mkvmerge", "-o", stagePath, ...videoTrackOptions(opts.track, opts.timestamps), opts.video, "--no-video", opts.targetPath], {
		signal,
	});
	checkCancelled();
	if (merged.code !== 0 && merged.code !== 1) throw new Error(`mkvmerge failed (exit ${merged.code}): ${(merged.stderr || merged.stdout).slice(-800)}`);
	const edit = ["mkvpropedit", stagePath, "--edit", "track:v1"];
	const defaultDuration = opts.track.properties.default_duration;
	if (typeof defaultDuration === "number" && defaultDuration > 0) edit.push("--set", `default-duration=${defaultDuration}`);
	if (edit.length > 4) {
		const edited = await run(edit, { signal });
		if (edited.code !== 0) throw new Error(`mkvpropedit failed: ${(edited.stderr || edited.stdout).slice(-500)}`);
	}
	await applyColorMetadata(stagePath, opts.probe, signal);
	checkCancelled();

	opts.onProgress?.(70, "Verifying the new MKV");
	const rebuilt = await identify(stagePath, signal);
	const rebuiltVideo = videoTrackOf(rebuilt, "the video").track;
	if (!rebuiltVideo) throw new Error("Verification failed: the new MKV has no AV1 video track");
	if (JSON.stringify(trackSignature(rebuilt)) !== JSON.stringify(trackSignature(original)))
		throw new Error("Verification failed: the audio or subtitle tracks changed");
	if ((rebuilt.attachments?.length ?? 0) !== (original.attachments?.length ?? 0)) throw new Error("Verification failed: attachments changed");
	const chapters = (identified: MkvJson) => (identified.chapters ?? []).reduce((sum, entry) => sum + (entry.num_entries ?? 0), 0);
	if (chapters(rebuilt) !== chapters(original)) throw new Error("Verification failed: chapters changed");
	const duration = (identified: MkvJson) => (identified.container?.properties?.duration ?? 0) / 1e9;
	if (Math.abs(duration(rebuilt) - duration(original)) > 0.5) throw new Error("Verification failed: the duration changed");
	if (opts.timestamps) {
		const check = join(opts.tempDir, "timestamps-check.txt");
		const extracted = await run(["mkvextract", stagePath, "timestamps_v2", `${rebuiltVideo.id}:${check}`], { signal });
		if (extracted.code !== 0 || readFileSync(check, "utf8") !== readFileSync(opts.timestamps, "utf8"))
			throw new Error("Verification failed: frame timestamps changed");
	}
	checkCancelled();
	renameSync(stagePath, opts.targetPath);
}
