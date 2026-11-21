import { readFileSync } from "fs";
import { join } from "path";
import type { RepairAuditTimingFile, RepairAuditTimingTrack, RepairAuditTrack, SubtitleTimeMap } from "../core/types";
import { CancelledError, run } from "../core/process";
import { alignToReference } from "../subsearch/align";
import { dialogueCues, mapCue, offsetAt, type Interval, type SubFormat } from "../subsearch/cues";
import { audioReference, NOT_DIALOGUE_TITLE } from "../subsearch/reference";
import { measureSync } from "../subsearch/score";
import { normalizeLanguageCode, normalizeLanguageGroup } from "../tracks/tracks";
import { probeFile } from "./probe";
import { auditTrack, identifyMatroska, isTextSubtitleCodec, videoEndSeconds } from "./repair";
import { snapOffsetsToFrames } from "./repair-timing";

/** A track with fewer dialogue lines, such as signs, is too sparse to measure on its own. */
export const MIN_TIMING_CUES = 80;
/** Desyncs inside a file are seconds, so a wider search only adds false matches. */
const MAX_SEARCH_MS = 120_000;
/** Speech found in audio is only this exact, so smaller shifts are left alone. */
export const MIN_SHIFT_MS = 300;
/** A moved track must fit the speech at least this well. */
export const MIN_TRUSTED_FIT = 0.5;
/** And fit it this much better than before. */
export const MIN_FIT_GAIN = 0.05;
/** Below this the lines do not follow the speech at all, so the timing cannot be judged. */
const MIN_FOLLOW_FIT = 0.25;
/** A fix fine-tuned on a track in sync may differ from the audio's by this much, which is what speech detection is off by. */
const MAX_REFINE_DIFF_MS = 500;

const COMMENTARY_TITLE = /commentary/i;
/** Title words that say what kind of track it is, not which release it came from. */
const KIND_WORDS = new Set([
	"sign",
	"signs",
	"song",
	"songs",
	"full",
	"subtitles",
	"subtitle",
	"subs",
	"sub",
	"forced",
	"karaoke",
	"dialogue",
	"and",
	"s",
	"the",
]);

type Judged = Omit<RepairAuditTimingTrack, "id" | "language" | "title">;

const round2 = (value: number) => Math.round(value * 100) / 100;

function moves(map: SubtitleTimeMap): boolean {
	return map.scale !== 1 || map.pieces.some((piece) => Math.abs(piece.offsetMs) >= MIN_SHIFT_MS);
}

/**
 * Measures one dialogue track against the speech in the audio. A change is
 * only offered when the moved track fits the speech well and clearly better
 * than it does now, so a weak match never moves a track.
 */
export function judgeDialogueTiming(cues: Interval[], speech: Interval[], durationMs: number, frameRate = 0): Judged {
	if (cues.length < MIN_TIMING_CUES) return { status: "unchecked", note: `Only ${cues.length} dialogue lines, too few to measure` };
	const aligned = alignToReference(cues, speech, { maxOffsetMs: MAX_SEARCH_MS });
	const map = frameRate > 0 ? snapOffsetsToFrames(aligned.map, frameRate) : aligned.map;
	const fit = (list: Interval[]) => {
		const quality = measureSync(list, speech, durationMs, "audio");
		return round2(quality.sync * (1 - quality.missingShare));
	};
	const fitBefore = fit(cues);
	if (!moves(map)) {
		if (fitBefore < MIN_FOLLOW_FIT)
			return { status: "unsure", fitBefore, note: "Its lines barely follow the speech in the audio, so its timing cannot be judged" };
		return { status: "synced", fitBefore };
	}
	const fitAfter = fit(cues.map((cue) => mapCue(cue, map)));
	if (fitAfter >= MIN_TRUSTED_FIT && fitAfter - fitBefore >= MIN_FIT_GAIN) return { status: "off", map, fitBefore, fitAfter };
	return { status: "unsure", map, fitBefore, fitAfter, note: "The audio suggests moving it, but the match is too weak to trust" };
}

/**
 * Speech in audio starts a little after the subtitles that show it, so a fix
 * found on the audio lands a frame or few early. Lining the track up with the
 * lines of a track in sync is exact. That fix is only kept when the audio
 * agrees with it, so a wrong match between the tracks changes nothing.
 */
export function refineOnTrack(cues: Interval[], anchor: Interval[], audioMap: SubtitleTimeMap, frameRate = 0): SubtitleTimeMap {
	const aligned = alignToReference(cues, anchor, { maxOffsetMs: MAX_SEARCH_MS, scales: [audioMap.scale] });
	const map = frameRate > 0 ? snapOffsetsToFrames(aligned.map, frameRate) : aligned.map;
	const agrees = map.pieces.every((piece) => Math.abs(piece.offsetMs - offsetAt(audioMap, piece.fromMs)) <= MAX_REFINE_DIFF_MS);
	return agrees && moves(map) ? map : audioMap;
}

type Role = "dialogue" | "follower" | "commentary";

function roleOf(track: RepairAuditTrack, cueCount: number): Role {
	if (track.isCommentary || COMMENTARY_TITLE.test(track.title)) return "commentary";
	if (track.isForced || NOT_DIALOGUE_TITLE.test(track.title) || cueCount < MIN_TIMING_CUES) return "follower";
	return "dialogue";
}

function titleWords(title: string): Set<string> {
	return new Set((title.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((word) => !KIND_WORDS.has(word)));
}

/**
 * The dialogue tracks a signs track most likely came with: the same language,
 * then the same format and the most shared title words, such as a group name.
 */
export function followCandidates(track: RepairAuditTrack, dialogue: RepairAuditTrack[]): RepairAuditTrack[] {
	const language = normalizeLanguageGroup(track.language);
	const same = dialogue.filter((other) => normalizeLanguageGroup(other.language) === language);
	if (!same.length) return [];
	const own = titleWords(track.title);
	const score = (other: RepairAuditTrack) =>
		(normalizeLanguageCode(other.language) === normalizeLanguageCode(track.language) ? 8 : 0) +
		(other.codec === track.codec ? 1 : 0) +
		[...titleWords(other.title)].filter((word) => own.has(word)).length * 2;
	const best = Math.max(...same.map(score));
	return same.filter((other) => score(other) === best);
}

const sameOutcome = (a: Judged, b: Judged) => a.status === b.status && JSON.stringify(a.map) === JSON.stringify(b.map);

function trackName(track: RepairAuditTrack): string {
	return track.title ? `${track.language} ${track.title}` : `${track.language} track ${track.id}`;
}

/**
 * Timing of every text subtitle track of a file. Dialogue tracks are measured
 * against the speech in the audio. Signs, songs and forced tracks follow
 * their dialogue track instead, as they show with on-screen text and not
 * with speech, so measuring them would pull them onto the nearest line.
 */
export function judgeFileTiming(
	tracks: Array<{ track: RepairAuditTrack; cues: Interval[] }>,
	speech: Interval[] | null,
	durationMs: number,
	frameRate = 0,
): RepairAuditTimingTrack[] {
	const roles = tracks.map(({ track, cues }) => roleOf(track, cues.length));
	const judged = new Map<number, Judged>();
	tracks.forEach(({ track, cues }, index) => {
		if (roles[index] !== "dialogue") return;
		judged.set(
			track.id,
			speech ? judgeDialogueTiming(cues, speech, durationMs, frameRate) : { status: "unchecked", note: "No speech could be found in the audio" },
		);
	});
	const dialogue = tracks.filter((_, index) => roles[index] === "dialogue").map(({ track }) => track);
	// Fixes are fine-tuned on the dialogue track in sync with the most lines, of the same language when there is one.
	const anchors = tracks.filter(({ track }) => judged.get(track.id)?.status === "synced").sort((a, b) => b.cues.length - a.cues.length);
	for (const { track, cues } of tracks) {
		const result = judged.get(track.id);
		if (result?.status !== "off" || !result.map || !speech) continue;
		const group = normalizeLanguageGroup(track.language);
		const anchor = anchors.find((other) => normalizeLanguageGroup(other.track.language) === group) ?? anchors[0];
		if (!anchor) continue;
		const map = refineOnTrack(cues, anchor.cues, result.map, frameRate);
		if (map === result.map) continue;
		const quality = measureSync(
			cues.map((cue) => mapCue(cue, map)),
			speech,
			durationMs,
			"audio",
		);
		judged.set(track.id, { ...result, map, fitAfter: round2(quality.sync * (1 - quality.missingShare)) });
	}
	return tracks.map(({ track }, index): RepairAuditTimingTrack => {
		const base = { id: track.id, language: track.language, title: track.title };
		if (roles[index] === "dialogue") return { ...base, ...judged.get(track.id)! };
		if (roles[index] === "commentary") return { ...base, status: "unchecked", note: "Commentary follows its own audio, so it is not measured" };
		const candidates = followCandidates(track, dialogue);
		if (!candidates.length) return { ...base, status: "unchecked", note: "No dialogue track of the same language to follow" };
		const outcomes = candidates.map((candidate) => judged.get(candidate.id)!);
		if (outcomes.some((outcome) => !sameOutcome(outcome, outcomes[0]!)))
			return {
				...base,
				status: "unchecked",
				note: `The ${candidates.length} dialogue tracks of the same language disagree, so it is unclear which one to follow`,
			};
		const partner = candidates[0]!;
		const outcome = outcomes[0]!;
		const follows = { follows: partner.id, ...(outcome.map ? { map: outcome.map } : {}) };
		if (outcome.status === "synced" || outcome.status === "off") return { ...base, status: outcome.status, ...follows };
		return { ...base, status: outcome.status, ...follows, note: `Follows ${trackName(partner)}, which could not be confirmed` };
	});
}

function formatOf(codec: string): SubFormat {
	return /substation|\bass\b|\bssa\b/i.test(codec) ? "ass" : "srt";
}

/** Reads the speech of a file's audio and the dialogue of its text subtitles, then judges every text track. */
export async function analyzeSubtitleTiming(path: string, workDir: string, signal?: AbortSignal): Promise<RepairAuditTimingFile> {
	const identified = await identifyMatroska(path, signal);
	const tracks = (identified.tracks || [])
		.filter((track) => track.type === "subtitles")
		.map(auditTrack)
		.filter((track) => isTextSubtitleCodec(track.codec));
	if (!tracks.length) return { path, tracks: [] };

	const outputs = tracks.map((track) => join(workDir, `${track.id}.${formatOf(track.codec)}`));
	const extract = await run(["mkvextract", path, "tracks", ...tracks.map((track, index) => `${track.id}:${outputs[index]}`)], { signal });
	if (signal?.aborted) throw new CancelledError();
	if (extract.code !== 0) throw new Error(`Could not extract the subtitles: ${(extract.stderr || extract.stdout).slice(-300)}`);
	const withCues = tracks.map((track, index) => {
		const content = readFileSync(outputs[index]!, "utf-8").replace(/^\uFEFF/, "");
		return { track, cues: dialogueCues({ format: formatOf(track.codec), content }) as Interval[] };
	});

	const probe = await probeFile(path);
	if (signal?.aborted) throw new CancelledError();
	const speech = await audioReference(path, probe, signal);
	const durationMs = (videoEndSeconds(identified) || probe.duration || 0) * 1000;
	const frameRate = !probe.isFrameRateMismatch && probe.videoStreamFps > 0 ? probe.videoStreamFps : 0;
	return { path, tracks: judgeFileTiming(withCues, speech?.intervals ?? null, durationMs, frameRate) };
}
