import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "fs";
import { basename, dirname, extname, join, parse as parsePath } from "path";
import {
	audioDefaults,
	audioDetectOptions,
	audioTrackName,
	canKeepOpus,
	opusBitrateFor,
	opusencArgs,
	selectAudioStreams,
	sortAudioLikeEncode,
	type AudioDropReason,
	type AudioSettings,
} from "../audio/audio-step";
import { mapPool } from "../core/concurrency";
import { Logger } from "../core/logger";
import { CancelledError, humanSize, run } from "../core/process";
import type { AppConfig, AudioStreamInfo, AudioTrackType, Job, JobSettings, JobStep, AudioTracksPlan, AudioTracksPlanTrack } from "../core/types";
import { detectAudioTrackType, normalizeLanguageGroup, sanitizeLanguageTag } from "../tracks/tracks";
import { resolveUniqueOutputPath } from "./output";
import { mkvtoolnixProgress } from "./prepare-progress";
import { probeFile } from "./probe";
import { audioFormatLabel, audioTracksOf, checked, normalizedAudioArgs } from "./release-audio";
import { durationSeconds, identifyMatroska, type MkvIdentification } from "./repair";
import { releaseLanguageKey, releaseLanguageName } from "./release-subs";

export type AudioTrackChoice = "auto" | "copy" | "encode" | "remove";
export type AudioTrackAction = "copy" | "encode" | "remove";

const KIND_LABELS: Record<AudioTrackType, string> = { main: "", commentary: "Commentary", descriptive: "Audio Description", karaoke: "Karaoke" };
const MAX_TRACKS = 64;

/** An audio track of a video, with what ffprobe and mkvmerge know of it. `index` is the mkvmerge track ID. */
export interface AudioTracksFileTrack extends AudioStreamInfo {
	/** The title as the file has it. `title` may carry the kind a flag gives, so detection sees it. */
	currentName: string;
	kind: AudioTrackType;
	format: string;
	isDefault: boolean;
	isCommentaryFlag: boolean;
	isVisualImpairedFlag: boolean;
	isHearingImpaired: boolean;
	/** Same language, kind, codec and channels: the same track in another episode. */
	signature: string;
}

export interface AudioTracksFile {
	path: string;
	name: string;
	tracks: AudioTracksFileTrack[];
}

const cache = new Map<string, { key: string; file: AudioTracksFile }>();

/** Reads a video's audio tracks. Kept while the file is unchanged, so a grid can be planned again at once. */
export async function inspectAudioTracksFile(path: string, settings: AudioSettings, signal?: AbortSignal): Promise<AudioTracksFile> {
	const { size, mtimeMs } = statSync(path);
	const detect = audioDetectOptions(settings);
	const key = `${size}:${mtimeMs}:${JSON.stringify(detect)}`;
	const hit = cache.get(path);
	if (hit?.key === key) return hit.file;
	const [identified, probe] = await Promise.all([identifyMatroska(path, signal), probeFile(path)]);
	const mkvAudio = audioTracksOf(identified);
	if (mkvAudio.length !== probe.audioStreams.length) throw new Error(`${basename(path)}: mkvmerge and ffprobe see a different number of audio tracks`);
	const tracks = mkvAudio.map((t, i): AudioTracksFileTrack => {
		const s = probe.audioStreams[i]!;
		const fromTitle = detectAudioTrackType({ ...s, title: t.title }, detect);
		const kind = t.isCommentary ? "commentary" : t.isVisualImpaired ? "descriptive" : fromTitle;
		return {
			...s,
			index: t.id,
			language: t.language,
			// A flag says what the title may not, and the encode's filters read titles.
			title: kind !== fromTitle ? `${KIND_LABELS[kind]} ${t.title}`.trim() : t.title,
			currentName: t.title,
			kind,
			format: audioFormatLabel(t),
			isDefault: t.isDefault,
			isOriginal: t.isOriginal,
			isCommentaryFlag: t.isCommentary,
			isVisualImpairedFlag: t.isVisualImpaired,
			isHearingImpaired: t.isHearingImpaired,
			signature: [normalizeLanguageGroup(t.language), kind, t.codec, t.channels].join("|"),
		};
	});
	const file = { path, name: basename(path), tracks };
	cache.set(path, { key, file });
	return file;
}

export interface PlannedAudioTrack {
	trackId: number;
	signature: string;
	language: string;
	kind: AudioTrackType;
	format: string;
	currentName: string;
	/** What the settings do with it, and why. */
	suggested: AudioTrackAction;
	reason: string;
	action: AudioTrackAction;
	/** Opus kbps when encoded. */
	bitrate: number;
	/** Place among the tracks the video keeps, from 0, or null when removed. */
	position: number | null;
	trackName: string;
	isDefault: boolean;
}

export interface AudioTracksFilePlan {
	path: string;
	name: string;
	/** Kept tracks in their new order, then the removed ones. */
	tracks: PlannedAudioTrack[];
	/** What the job would change, empty when the audio is already as the settings want it. */
	changes: string[];
}

function dropReason(reason: AudioDropReason | undefined, kind: AudioTrackType): string {
	if (reason === "ignored") return "Marked to be ignored";
	if (reason === "language") return "Not one of your audio languages";
	if (reason === "duplicate") return "A better track of the same language and kind is kept";
	return kind === "main" ? "A compatibility track, which your settings drop" : `${KIND_LABELS[kind]} is removed in your settings`;
}

/**
 * What an encode with these settings would do with a video's audio, without
 * touching its video: which tracks it keeps, in which order, which it encodes
 * to Opus, and the names and defaults it gives them. `choices` overrides the
 * settings for every track of a signature.
 */
export function planAudioTracks(
	file: AudioTracksFile,
	settings: AudioSettings & Pick<JobSettings, "audioEncode">,
	choices: Record<string, AudioTrackChoice> = {},
): AudioTracksFilePlan {
	const dropped = new Map<number, AudioDropReason>();
	const selected = new Set(selectAudioStreams(file.tracks, settings, dropped).map((s) => s.index));
	const decided = file.tracks.map((t) => {
		const bitrate = opusBitrateFor(t, settings);
		let suggested: AudioTrackAction;
		let reason: string;
		if (!selected.has(t.index)) {
			suggested = "remove";
			reason = dropReason(dropped.get(t.index), t.kind);
		} else if (settings.audioEncode === "copy") {
			suggested = "copy";
			reason = "Your settings copy audio";
		} else if (canKeepOpus(t, bitrate)) {
			suggested = "copy";
			reason = `Already Opus at or under ${bitrate} kbps`;
		} else {
			suggested = "encode";
			reason = `At ${bitrate} kbps`;
		}
		const choice = choices[t.signature] ?? "auto";
		return { track: t, suggested, reason, bitrate, action: choice === "auto" ? suggested : choice };
	});

	const kept = sortAudioLikeEncode(
		decided.filter((d) => d.action !== "remove").map((d) => d.track),
		settings,
	);
	const defaults = audioDefaults(kept.map((t) => ({ language: t.language, trackType: t.kind })));
	const byId = new Map(decided.map((d) => [d.track.index, d]));
	const view = (t: AudioTracksFileTrack, position: number | null): PlannedAudioTrack => {
		const d = byId.get(t.index)!;
		return {
			trackId: t.index,
			signature: t.signature,
			language: t.language || "und",
			kind: t.kind,
			format: t.format,
			currentName: t.currentName,
			suggested: d.suggested,
			reason: d.reason,
			action: d.action,
			bitrate: d.bitrate,
			position,
			trackName: position === null ? t.currentName : audioTrackName(t.kind, t.currentName),
			isDefault: position === null ? t.isDefault : defaults[position]!,
		};
	};
	const tracks = [...kept.map((t, i) => view(t, i)), ...file.tracks.filter((t) => !kept.includes(t)).map((t) => view(t, null))];

	const changes: string[] = [];
	const count = (action: AudioTrackAction) => decided.filter((d) => d.action === action).length;
	const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
	if (count("encode")) changes.push(`${plural(count("encode"), "track")} encoded to Opus`);
	if (count("remove")) changes.push(`${plural(count("remove"), "track")} removed`);
	const original = file.tracks.filter((t) => kept.includes(t)).map((t) => t.index);
	if (kept.some((t, i) => t.index !== original[i])) changes.push("reordered");
	const relabeled = tracks.filter(
		(p) =>
			p.position !== null &&
			(() => {
				const t = file.tracks.find((x) => x.index === p.trackId)!;
				return (
					p.trackName !== t.currentName ||
					p.isDefault !== t.isDefault ||
					(t.kind === "commentary") !== t.isCommentaryFlag ||
					(t.kind === "descriptive") !== t.isVisualImpairedFlag
				);
			})(),
	);
	if (relabeled.length) changes.push(`${plural(relabeled.length, "track")} renamed or reflagged`);
	return { path: file.path, name: file.name, tracks, changes };
}

/** The job that carries out a file's plan, or null when it changes nothing. */
export function buildAudioTracksPlan(plan: AudioTracksFilePlan, file: AudioTracksFile, replaceTarget: boolean): AudioTracksPlan | null {
	if (!plan.changes.length) return null;
	return sanitizeAudioTracksPlan({
		targetPath: plan.path,
		replaceTarget,
		tracks: plan.tracks
			.filter((p) => p.position !== null)
			.map((p) => {
				const t = file.tracks.find((x) => x.index === p.trackId)!;
				return {
					trackId: p.trackId,
					action: p.action === "encode" ? "encode" : "copy",
					bitrate: p.bitrate,
					language: p.language,
					trackName: p.trackName,
					isDefault: p.isDefault,
					isOriginal: !!t.isOriginal,
					isCommentary: p.kind === "commentary",
					isVisualImpaired: p.kind === "descriptive",
					isHearingImpaired: t.isHearingImpaired,
				};
			}),
	});
}

/** Normalizes a plan read from the queue file before it reaches mkvmerge. */
export function sanitizeAudioTracksPlan(raw: AudioTracksPlan): AudioTracksPlan {
	if (typeof raw?.targetPath !== "string" || !raw.targetPath) throw new Error("The audio plan has no video");
	if (!Array.isArray(raw.tracks) || raw.tracks.length > MAX_TRACKS) throw new Error("Invalid audio tracks");
	const seen = new Set<number>();
	const tracks = raw.tracks.map((t): AudioTracksPlanTrack => {
		const trackId = Number(t?.trackId);
		if (!Number.isInteger(trackId) || trackId < 0 || seen.has(trackId)) throw new Error("Invalid audio track");
		seen.add(trackId);
		const bitrate = Number(t.bitrate);
		if (t.action === "encode" && !(bitrate >= 6 && bitrate <= 1024)) throw new Error(`Invalid Opus bitrate for track ${trackId}`);
		return {
			trackId,
			action: t.action === "encode" ? "encode" : "copy",
			bitrate: Number.isFinite(bitrate) ? Math.round(bitrate) : 0,
			language: sanitizeLanguageTag(t.language, `audio ${trackId}`),
			trackName: typeof t.trackName === "string" ? t.trackName.trim().slice(0, 512) : "",
			isDefault: !!t.isDefault,
			isOriginal: !!t.isOriginal,
			isCommentary: !!t.isCommentary,
			isVisualImpaired: !!t.isVisualImpaired,
			isHearingImpaired: !!t.isHearingImpaired,
		};
	});
	return { targetPath: raw.targetPath, tracks, replaceTarget: raw.replaceTarget !== false };
}

export function describeAudioTracksPlan(plan: AudioTracksPlan): string {
	const encoded = plan.tracks.filter((t) => t.action === "encode").length;
	return encoded ? `Encoding ${encoded} audio track(s) to Opus` : "Reordering and renaming audio tracks";
}

export interface AudioTracksType {
	signature: string;
	label: string;
	format: string;
	files: number;
	/** What the settings do with it, or "mixed" when that differs between files. */
	suggested: AudioTrackAction | "mixed";
	reason: string;
}

export interface AudioTracksScan {
	types: AudioTracksType[];
	files: AudioTracksFilePlan[];
}

/** Plans every file and sums up each kind of track, which is what a choice applies to. */
export async function scanAudioTracks(
	paths: string[],
	settings: AudioSettings & Pick<JobSettings, "audioEncode">,
	choices: Record<string, AudioTrackChoice>,
	signal?: AbortSignal,
): Promise<AudioTracksScan> {
	const files = new Map<string, AudioTracksFile>();
	await mapPool(paths, 4, async (path) => {
		files.set(path, await inspectAudioTracksFile(path, settings, signal));
	});
	const plans = paths.map((path) => planAudioTracks(files.get(path)!, settings, choices));
	const types = new Map<string, AudioTracksType & { order: number }>();
	for (const plan of plans) {
		for (const t of plan.tracks) {
			const type = types.get(t.signature);
			if (!type) {
				const key = releaseLanguageKey(t.language);
				types.set(t.signature, {
					signature: t.signature,
					label: [key ? releaseLanguageName(key) : "Unknown language", KIND_LABELS[t.kind]].filter(Boolean).join(" "),
					format: t.format,
					files: 1,
					suggested: t.suggested,
					reason: t.reason,
					order: t.position ?? 1000 + types.size,
				});
				continue;
			}
			type.files++;
			if (type.suggested !== t.suggested) {
				type.suggested = "mixed";
				type.reason = "Differs between files";
			}
		}
	}
	return {
		types: [...types.values()].sort((a, b) => a.order - b.order).map(({ order: _order, ...type }) => type),
		files: plans,
	};
}

function trackOptions(id: number, t: AudioTracksPlanTrack, withLanguage: boolean): string[] {
	return [
		...(withLanguage
			? [
					"--language",
					`${id}:${t.language}`,
					"--original-flag",
					`${id}:${t.isOriginal ? 1 : 0}`,
					"--hearing-impaired-flag",
					`${id}:${t.isHearingImpaired ? 1 : 0}`,
				]
			: []),
		"--track-name",
		`${id}:${t.trackName}`,
		"--default-track-flag",
		`${id}:${t.isDefault ? 1 : 0}`,
		"--forced-display-flag",
		`${id}:0`,
		"--commentary-flag",
		`${id}:${t.isCommentary ? 1 : 0}`,
		"--visual-impaired-flag",
		`${id}:${t.isVisualImpaired ? 1 : 0}`,
	];
}

/** mkvmerge writing the video with only the planned audio, copied from it or read from the encoded files, in the planned order. */
export function buildAudioTracksMkvmergeArgs(options: {
	outputPath: string;
	plan: AudioTracksPlan;
	target: MkvIdentification;
	encoded: Map<number, string>;
}): string[] {
	const { outputPath, plan, target, encoded } = options;
	const tracks = target.tracks ?? [];
	const copied = plan.tracks.filter((t) => t.action === "copy");
	const files = plan.tracks.filter((t) => t.action === "encode");
	const order = [
		...tracks.filter((t) => t.type === "video").map((t) => `0:${t.id}`),
		...plan.tracks.map((t) => (t.action === "copy" ? `0:${t.trackId}` : `${files.indexOf(t) + 1}:0`)),
		...tracks.filter((t) => t.type !== "video" && t.type !== "audio").map((t) => `0:${t.id}`),
	];
	const args = ["mkvmerge", "--gui-mode", "-o", outputPath, "--track-order", order.join(",")];
	args.push(...(copied.length ? ["--audio-tracks", copied.map((t) => t.trackId).join(",")] : ["--no-audio"]));
	for (const t of copied) args.push(...trackOptions(t.trackId, t, false));
	args.push(plan.targetPath);
	for (const t of files) {
		const file = encoded.get(t.trackId);
		if (!file) throw new Error(`Encoded audio for track ${t.trackId} is missing`);
		args.push("--no-track-tags", ...trackOptions(0, t, true), file);
	}
	return args;
}

/** Encodes, removes, reorders and renames a video's audio tracks as its plan says, copying the video and everything else. */
export async function runAudioTracksJob(job: Job, config: AppConfig, updateJob: (partial: Partial<Job>) => void, signal?: AbortSignal): Promise<void> {
	if (!job.audioTracksPlan) throw new Error("Audio job has no plan");
	const plan = sanitizeAudioTracksPlan(job.audioTracksPlan);
	const tempDir = join(config.tempDir, job.id);
	mkdirSync(tempDir, { recursive: true });
	const stagePath = join(dirname(plan.targetPath), `.rabbit-audio-${job.id}.mkv`);
	const steps: JobStep[] = [
		{ label: "Inspect files", status: "pending", progress: 0 },
		{ label: "Encode audio", status: "pending", progress: 0 },
		{ label: "Stream-copy remux", status: "pending", progress: 0 },
	];
	const [S_INSPECT, S_ENCODE, S_MUX] = [0, 1, 2];
	const setStep = (index: number, partial: Partial<JobStep>) => {
		const step = steps[index]!;
		if (partial.status === "active" && !step.startedAt) step.startedAt = Date.now();
		if ((partial.status === "done" || partial.status === "error") && !step.finishedAt) step.finishedAt = Date.now();
		Object.assign(step, partial);
		updateJob({
			steps: [...steps],
			progress: Math.round((steps.reduce((sum, item) => sum + item.progress, 0) / steps.length) * 100) / 100,
			currentStage: steps.find((item) => item.status === "active")?.label || job.currentStage,
		});
	};
	const checkCancelled = () => {
		if (signal?.aborted) throw new CancelledError();
	};

	try {
		if (!existsSync(plan.targetPath)) throw new Error("The video no longer exists");
		if (extname(plan.targetPath).toLowerCase() !== ".mkv") throw new Error("Audio tracks can only be changed in MKV files");
		if (existsSync(stagePath)) throw new Error(`Staging file already exists: ${stagePath}`);

		setStep(S_INSPECT, { status: "active", progress: 10 });
		updateJob({ status: "probing" });
		const [targetId, probe] = await Promise.all([identifyMatroska(plan.targetPath, signal), probeFile(plan.targetPath)]);
		checkCancelled();
		updateJob({ probe });
		const audio = audioTracksOf(targetId);
		for (const t of plan.tracks) if (!audio.some((a) => a.id === t.trackId)) throw new Error(`The video no longer has audio track ${t.trackId}`);
		setStep(S_INSPECT, { status: "done", progress: 100, detail: `${plan.tracks.length} of ${audio.length} audio track(s) kept` });

		const toEncode = plan.tracks.filter((t) => t.action === "encode");
		setStep(S_ENCODE, { status: "active", progress: 0 });
		updateJob({ status: "encoding_audio" });
		const encoded = new Map<number, string>();
		for (const [n, t] of toEncode.entries()) {
			checkCancelled();
			const order = audio.findIndex((a) => a.id === t.trackId);
			const name = `${t.language} track ${t.trackId}`;
			const flac = join(tempDir, `audio_${t.trackId}.flac`);
			const opus = join(tempDir, `audio_${t.trackId}.opus`);
			setStep(S_ENCODE, { progress: Math.round((n / toEncode.length) * 100), detail: `Decoding ${name}` });
			await checked(normalizedAudioArgs(plan.targetPath, order, probe.audioStreams[order]?.delayMs ?? 0, flac), `Decoding ${name}`, signal);
			setStep(S_ENCODE, { progress: Math.round(((n + 0.4) / toEncode.length) * 100), detail: `Encoding ${name} to Opus at ${t.bitrate} kbps` });
			await checked(opusencArgs(flac, opus, t.bitrate, job.settings), `Encoding ${name}`, signal);
			rmSync(flac, { force: true });
			encoded.set(t.trackId, opus);
		}
		setStep(S_ENCODE, { status: "done", progress: 100, detail: toEncode.length ? `${toEncode.length} encoded to Opus` : "Nothing to encode" });

		setStep(S_MUX, { status: "active", progress: 0, detail: "Copying streams without video encoding" });
		updateJob({ status: "muxing" });
		const merged = await run(buildAudioTracksMkvmergeArgs({ outputPath: stagePath, plan, target: targetId, encoded }), {
			signal,
			onStdoutLine: (line) => {
				const percent = mkvtoolnixProgress(line);
				if (percent !== null) setStep(S_MUX, { progress: Math.round(percent * 0.8) });
			},
		});
		checkCancelled();
		if (merged.code !== 0 && merged.code !== 1) throw new Error(`mkvmerge failed (exit ${merged.code}): ${(merged.stderr || merged.stdout).slice(-800)}`);
		if (merged.code === 1) Logger.warn(`[audio] mkvmerge completed with warnings: ${(merged.stderr || merged.stdout).slice(-500)}`);

		setStep(S_MUX, { progress: 85, detail: "Verifying the new MKV" });
		const verified = await identifyMatroska(stagePath, signal);
		checkCancelled();
		const codecs = (id: MkvIdentification, type: string) =>
			JSON.stringify((id.tracks ?? []).filter((t) => t.type === type).map((t) => t.properties.codec_id || t.codec));
		if (codecs(targetId, "video") !== codecs(verified, "video")) throw new Error("Verification failed: the video tracks changed");
		if (codecs(targetId, "subtitles") !== codecs(verified, "subtitles")) throw new Error("Verification failed: the subtitle tracks changed");
		const outAudio = (verified.tracks ?? []).filter((t) => t.type === "audio");
		if (outAudio.length !== plan.tracks.length) throw new Error(`Verification failed: expected ${plan.tracks.length} audio tracks, found ${outAudio.length}`);
		const before = durationSeconds(targetId);
		const after = durationSeconds(verified);
		if (before > 0 && Math.abs(after - before) > Math.max(2, before * 0.01))
			throw new Error(`Verification failed: the file would last ${after.toFixed(1)} s instead of ${before.toFixed(1)} s`);

		const parsed = parsePath(plan.targetPath);
		const finalPath = plan.replaceTarget ? plan.targetPath : resolveUniqueOutputPath(parsed.dir, `${parsed.name}.audio.mkv`);
		renameSync(stagePath, finalPath);
		setStep(S_MUX, { status: "done", progress: 100, detail: plan.replaceTarget ? "Video replaced after verification" : "Copy with the new audio created" });
		updateJob({
			status: "done",
			currentStage: "Complete",
			progress: 100,
			outputFilename: finalPath,
			encodedFileSize: humanSize(statSync(finalPath).size),
			finishedAt: Date.now(),
		});
		Logger.info(`[audio] Complete: ${finalPath}`);
	} catch (error: any) {
		const active = steps.find((step) => step.status === "active");
		if (active) active.status = "error";
		if (error instanceof CancelledError) {
			updateJob({ status: "cancelled", currentStage: "Cancelled", steps: [...steps] });
			throw error;
		}
		Logger.error(`[audio] ${error?.message || error}`);
		updateJob({ status: "error", currentStage: "Failed", steps: [...steps], error: error?.message || String(error) });
	} finally {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {}
		try {
			rmSync(stagePath, { force: true });
		} catch {}
	}
}
