import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "fs";
import { basename, dirname, extname, join, parse as parsePath } from "path";
import { mapPool } from "../core/concurrency";
import { Logger } from "../core/logger";
import { CancelledError, humanSize, run } from "../core/process";
import type {
	AppConfig,
	AudioCodecPriority,
	AudioTrackType,
	Job,
	JobSettings,
	JobStep,
	ProbeResult,
	ReleaseAudioAddition,
	ReleaseAudioPlan,
} from "../core/types";
import { IDENTITY_MAP, mergeIntervals, type Interval, type TimeMap } from "../subsearch/cues";
import { alignReleaseFiles } from "../sync/release-align";
import { buildAudioTrackName, buildLangTier, detectAudioTrackType, sanitizeLanguageTag, type AudioDetectOptions } from "../tracks/tracks";
import {
	audioDefaults,
	audioDetectOptions,
	audioTrackName,
	canKeepOpus,
	opusBitrateFor,
	opusencArgs,
	sortAudioLikeEncode,
	type AudioSettings,
} from "../audio/audio-step";
import { resolveUniqueOutputPath } from "./output";
import { ffmpegProgress, mkvtoolnixProgress } from "./prepare-progress";
import { probeFile } from "./probe";
import { durationSeconds, identifyMatroska, type MkvIdentification } from "./repair";
import { alignmentProblem, describeTiming, isIdentityTiming } from "./repair-timing";
import {
	pairReleaseFolders,
	releaseCredit,
	releaseLanguageKey,
	releaseLanguageName,
	type ReleaseCellAction,
	type ReleaseFolder,
	type ReleaseOverride,
	type ReleaseSource,
} from "./release-subs";

type MkvTrack = NonNullable<MkvIdentification["tracks"]>[number];
type AudioProperties = MkvTrack["properties"] & { audio_channels?: number; audio_sampling_frequency?: number; tag_bps?: string };

const KINDS: AudioTrackType[] = ["main", "commentary", "descriptive", "karaoke"];
const KIND_LABELS: Record<AudioTrackType, string> = { main: "", commentary: "Commentary", descriptive: "Audio Description", karaoke: "Karaoke" };
const LOSSLESS = /flac|truehd|mlp|pcm|master audio|alac|lossless/i;
/** A track copied as it is may run this far past the video. A longer one is rebuilt and cut at the video's end. */
const OVERHANG_MS = 1000;
const MAX_ADDITIONS = 32;

export interface ReleaseAudioTrack {
	id: number;
	codec: string;
	codecId: string;
	language: string;
	title: string;
	channels: number;
	sampleRate: number;
	/** Bits per second from mkvmerge's statistics tags, 0 when unknown. */
	bitrate: number;
	durationMs: number;
	isDefault: boolean;
	isOriginal: boolean;
	isCommentary: boolean;
	isVisualImpaired: boolean;
	isHearingImpaired: boolean;
}

export interface ReleaseAudioFile {
	path: string;
	filename: string;
	/** How long the video lasts, which an added track may not run past. */
	durationMs: number;
	audio: ReleaseAudioTrack[];
}

function tagMs(value: string | undefined): number {
	const m = value?.match(/^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/);
	return m ? Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000) : 0;
}

export function audioTracksOf(identified: MkvIdentification): ReleaseAudioTrack[] {
	return (identified.tracks ?? [])
		.filter((track) => track.type === "audio")
		.map((track) => {
			const p = track.properties as AudioProperties;
			return {
				id: track.id,
				codec: track.codec,
				codecId: p.codec_id || "",
				language: p.language_ietf || p.language || "und",
				title: p.track_name || "",
				channels: p.audio_channels || 0,
				sampleRate: p.audio_sampling_frequency || 0,
				bitrate: Number(p.tag_bps) || 0,
				durationMs: tagMs(p.tag_duration),
				isDefault: !!p.default_track,
				isOriginal: !!p.flag_original,
				isCommentary: !!p.flag_commentary,
				isVisualImpaired: !!p.flag_visual_impaired,
				isHearingImpaired: !!p.flag_hearing_impaired,
			};
		});
}

export function videoDurationMs(identified: MkvIdentification): number {
	const video = (identified.tracks ?? []).filter((t) => t.type === "video").map((t) => tagMs(t.properties.tag_duration));
	return Math.max(0, ...video) || Math.round(durationSeconds(identified) * 1000);
}

export async function inspectReleaseAudioFile(path: string, signal?: AbortSignal): Promise<ReleaseAudioFile> {
	const identified = await identifyMatroska(path, signal);
	return { path, filename: basename(path), durationMs: videoDurationMs(identified), audio: audioTracksOf(identified) };
}

export function releaseAudioKind(track: Pick<ReleaseAudioTrack, "title" | "isCommentary" | "isVisualImpaired">, detect?: AudioDetectOptions): AudioTrackType {
	if (track.isCommentary) return "commentary";
	if (track.isVisualImpaired) return "descriptive";
	return detectAudioTrackType({ index: 0, channels: 0, channelLayout: "", delayMs: 0, title: track.title }, detect);
}

export function isLosslessAudio(codec: string): boolean {
	return LOSSLESS.test(codec);
}

function channelLabel(channels: number): string {
	const known: Record<number, string> = { 1: "1.0", 2: "2.0", 3: "2.1", 6: "5.1", 7: "6.1", 8: "7.1" };
	return known[channels] ?? (channels ? `${channels}ch` : "");
}

/** Such as "E-AC-3 5.1". */
export function audioFormatLabel(track: Pick<ReleaseAudioTrack, "codec" | "channels">): string {
	return [track.codec, channelLabel(track.channels)].filter(Boolean).join(" ");
}

export interface ReleaseAudioOptions {
	codecPriority: AudioCodecPriority;
	renameTracks: boolean;
	languagePriority: string[];
	/** Languages added without being picked by hand. Empty adds every language. */
	autoLanguages: string[];
	/** Kinds added without being picked by hand. */
	autoKinds: AudioTrackType[];
	/** Which titles mark commentary, audio description and karaoke, as the settings detect them. */
	detect?: AudioDetectOptions;
	/** Chosen by hand: a source track per key, or null to leave the key alone. */
	choices?: Record<string, { sourcePath: string; trackId: number } | null>;
}

/**
 * What the encode settings would keep, so the grid starts with the languages
 * and kinds an encode would have. Applying the settings names added tracks as
 * an encode does. Without them, tracks keep the release's own names.
 */
export function releaseAudioDefaults(settings: JobSettings, applySettings = false): Omit<ReleaseAudioOptions, "choices"> {
	return {
		codecPriority: settings.audioCodecPriority,
		renameTracks: applySettings,
		detect: audioDetectOptions(settings),
		languagePriority: settings.audioLanguagePriority,
		autoLanguages: settings.audioLanguages ?? [],
		autoKinds: KINDS.filter(
			(kind) =>
				kind === "main" ||
				(kind === "commentary" && !settings.removeCommentaryAudio) ||
				(kind === "descriptive" && !settings.removeDescriptiveAudio) ||
				(kind === "karaoke" && !settings.removeKaraokeAudio),
		),
	};
}

export interface ReleaseAudioCandidate {
	sourcePath: string;
	trackId: number;
	codec: string;
	format: string;
	language: string;
	title: string;
	credit: string | null;
	channels: number;
	bitrate: number;
	lossless: boolean;
	isOriginal: boolean;
	isHearingImpaired: boolean;
}

export interface ReleaseAudioHave {
	trackId: number;
	title: string;
	language: string;
	format: string;
}

export interface ReleaseAudioCell {
	key: string;
	language: string;
	kind: AudioTrackType;
	have: ReleaseAudioHave[];
	/** Source tracks of this language and kind, the best first. */
	candidates: ReleaseAudioCandidate[];
	action: ReleaseCellAction;
	chosen?: ReleaseAudioCandidate;
}

export interface ReleaseAudioPlanned extends ReleaseAudioCandidate {
	key: string;
	kind: AudioTrackType;
	trackName: string;
	/** Target tracks it replaces. */
	replaces: number[];
}

export interface ReleaseAudioTargetPlan {
	targetPath: string;
	cells: ReleaseAudioCell[];
	additions: ReleaseAudioPlanned[];
}

function keyOf(track: ReleaseAudioTrack, detect?: AudioDetectOptions): { key: string; language: string; kind: AudioTrackType } | null {
	const language = releaseLanguageKey(track.language);
	if (!language) return null;
	const kind = releaseAudioKind(track, detect);
	return { key: `${language}:${kind}`, language, kind };
}

function orderCells<T extends { language: string; kind: AudioTrackType }>(cells: T[], priority: string[]): T[] {
	const tier = buildLangTier(priority.length ? priority : ["*"]);
	return [...cells].sort(
		(a, b) => tier(a.language) - tier(b.language) || a.language.localeCompare(b.language) || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind),
	);
}

/** Better first: lossless, more channels and a higher bitrate, or the smallest when that is the priority. */
function compareQuality(a: ReleaseAudioCandidate, b: ReleaseAudioCandidate, priority: AudioCodecPriority): number {
	if (priority === "smallest-first") return Number(a.lossless) - Number(b.lossless) || (a.bitrate || Infinity) - (b.bitrate || Infinity);
	return Number(b.lossless) - Number(a.lossless) || b.channels - a.channels || b.bitrate - a.bitrate;
}

/**
 * Which audio languages and kinds one target lacks that other releases of it
 * have, and the source track to take for each. Languages and kinds the encode
 * settings keep are added on their own, the rest when picked by hand. A track
 * the target has is only replaced by hand.
 */
export function planReleaseAudio(target: ReleaseAudioFile, sources: ReleaseAudioFile[], options: ReleaseAudioOptions): ReleaseAudioTargetPlan {
	const cells = new Map<string, ReleaseAudioCell>();
	const cellFor = (k: { key: string; language: string; kind: AudioTrackType }) => {
		let cell = cells.get(k.key);
		if (!cell) cells.set(k.key, (cell = { ...k, have: [], candidates: [], action: "missing" }));
		return cell;
	};
	for (const track of target.audio) {
		const k = keyOf(track, options.detect);
		if (k) cellFor(k).have.push({ trackId: track.id, title: track.title, language: track.language, format: audioFormatLabel(track) });
	}
	for (const source of sources) {
		for (const track of source.audio) {
			const k = keyOf(track, options.detect);
			if (!k) continue;
			cellFor(k).candidates.push({
				sourcePath: source.path,
				trackId: track.id,
				codec: track.codec,
				format: audioFormatLabel(track),
				language: track.language,
				title: track.title,
				credit: releaseCredit(track.title, source.filename),
				channels: track.channels,
				bitrate: track.bitrate,
				lossless: isLosslessAudio(track.codec),
				isOriginal: track.isOriginal,
				isHearingImpaired: track.isHearingImpaired,
			});
		}
	}

	const autoLanguages = new Set(options.autoLanguages.map((l) => releaseLanguageKey(l)).filter(Boolean));
	const sourceOrder = new Map(sources.map((s, i) => [s.path, i]));
	for (const cell of cells.values()) {
		cell.candidates.sort(
			(a, b) => compareQuality(a, b, options.codecPriority) || sourceOrder.get(a.sourcePath)! - sourceOrder.get(b.sourcePath)! || a.trackId - b.trackId,
		);
		const choice = options.choices?.[cell.key];
		const auto = !cell.have.length && (!autoLanguages.size || autoLanguages.has(cell.language)) && options.autoKinds.includes(cell.kind);
		const picked =
			choice === null
				? undefined
				: choice
					? cell.candidates.find((c) => c.sourcePath === choice.sourcePath && c.trackId === choice.trackId)
					: auto
						? cell.candidates[0]
						: undefined;
		if (!cell.have.length) cell.action = picked ? "add" : cell.candidates.length ? "skip" : "missing";
		else cell.action = picked ? "replace" : "keep";
		if (picked) cell.chosen = picked;
	}

	const ordered = orderCells([...cells.values()], options.languagePriority);
	const additions = ordered
		.filter((cell) => cell.chosen)
		.map((cell): ReleaseAudioPlanned => {
			const c = cell.chosen!;
			return {
				...c,
				language: sanitizeLanguageTag(c.language, `${basename(c.sourcePath)} audio ${c.trackId}`),
				key: cell.key,
				kind: cell.kind,
				trackName: options.renameTracks ? buildAudioTrackName(cell.kind, c.title) : c.title,
				replaces: cell.action === "replace" ? cell.have.map((h) => h.trackId) : [],
			};
		});
	return { targetPath: target.path, cells: ordered, additions };
}

export interface ReleaseAudioColumn {
	key: string;
	language: string;
	kind: AudioTrackType;
	label: string;
}

export interface ReleaseAudioRow extends ReleaseAudioTargetPlan {
	targetName: string;
	sources: ReleaseSource[];
}

export interface ReleaseAudioScan {
	columns: ReleaseAudioColumn[];
	rows: ReleaseAudioRow[];
	unmatchedSources: string[];
}

/** One column per language and kind any file has, with every row holding a cell for each. */
export function releaseAudioGrid(rows: ReleaseAudioRow[], languagePriority: string[] = []): Omit<ReleaseAudioScan, "unmatchedSources"> {
	const seen = new Map<string, { key: string; language: string; kind: AudioTrackType }>();
	for (const row of rows)
		for (const cell of row.cells) if (!seen.has(cell.key)) seen.set(cell.key, { key: cell.key, language: cell.language, kind: cell.kind });
	const columns = orderCells([...seen.values()], languagePriority).map((c) => ({
		...c,
		label: [releaseLanguageName(c.language), KIND_LABELS[c.kind]].filter(Boolean).join(" "),
	}));
	return {
		columns,
		rows: rows.map((row) => {
			const byKey = new Map(row.cells.map((c) => [c.key, c]));
			return {
				...row,
				cells: columns.map(
					(col) => byKey.get(col.key) ?? { key: col.key, language: col.language, kind: col.kind, have: [], candidates: [], action: "missing" },
				),
			};
		}),
	};
}

/** Pairs every target with its episode in each release folder and plans the audio it lacks. Only track lists are read. */
export async function scanReleaseAudio(input: {
	targets: string[];
	sourceDirs: Array<string | ReleaseFolder>;
	overrides?: ReleaseOverride[];
	options: ReleaseAudioOptions;
	signal?: AbortSignal;
}): Promise<ReleaseAudioScan> {
	const { targets, options, signal } = input;
	const { pairedSources, unmatchedSources } = pairReleaseFolders(targets, input.sourceDirs, input.overrides);
	const files = [...new Set([...targets, ...[...pairedSources.values()].flat().map((s) => s.path)])];
	const inspected = new Map<string, ReleaseAudioFile>();
	await mapPool(files, 4, async (path) => {
		inspected.set(path, await inspectReleaseAudioFile(path, signal));
	});
	const rows = targets.map((targetPath): ReleaseAudioRow => {
		const sources = pairedSources.get(targetPath)!;
		const plan = planReleaseAudio(
			inspected.get(targetPath)!,
			sources.map((s) => inspected.get(s.path)!),
			options,
		);
		return { ...plan, targetName: basename(targetPath), sources };
	});
	return { ...releaseAudioGrid(rows, options.languagePriority), unmatchedSources };
}

/** The job plan that carries out one target's plan, or null when there is nothing to add. */
export function buildReleaseAudioPlan(
	plan: Pick<ReleaseAudioTargetPlan, "targetPath" | "additions">,
	replaceTarget: boolean,
	applySettings = false,
): ReleaseAudioPlan | null {
	if (!plan.additions.length) return null;
	const sources = [...new Set(plan.additions.map((a) => a.sourcePath))];
	return sanitizeReleaseAudioPlan({
		targetPath: plan.targetPath,
		sources,
		replaceTarget,
		applySettings,
		additions: plan.additions.map((a) => ({
			sourceIndex: sources.indexOf(a.sourcePath),
			trackId: a.trackId,
			language: a.language,
			trackName: a.trackName,
			isOriginal: a.isOriginal,
			isCommentary: a.kind === "commentary",
			isVisualImpaired: a.kind === "descriptive",
			isHearingImpaired: a.isHearingImpaired,
			replaces: a.replaces,
		})),
	});
}

const trackId = (value: unknown, what: string): number => {
	const id = Number(value);
	if (!Number.isInteger(id) || id < 0 || id > 10_000) throw new Error(`Invalid ${what}`);
	return id;
};

/** Normalizes a plan read from the queue file before it reaches mkvmerge. */
export function sanitizeReleaseAudioPlan(raw: ReleaseAudioPlan): ReleaseAudioPlan {
	if (typeof raw?.targetPath !== "string" || !raw.targetPath) throw new Error("The audio plan has no target");
	const sources = Array.isArray(raw.sources) ? raw.sources.filter((s): s is string => typeof s === "string" && !!s) : [];
	if (!sources.length || sources.length !== raw.sources.length) throw new Error("The audio plan has an invalid release");
	if (!Array.isArray(raw.additions) || !raw.additions.length || raw.additions.length > MAX_ADDITIONS) throw new Error("The audio plan has no tracks to add");
	const seen = new Set<string>();
	const additions = raw.additions.map((a): ReleaseAudioAddition => {
		const sourceIndex = trackId(a?.sourceIndex, "release in the audio plan");
		if (sourceIndex >= sources.length) throw new Error("The audio plan names a release it does not have");
		const id = trackId(a.trackId, "audio track");
		if (seen.has(`${sourceIndex}:${id}`)) throw new Error(`Audio track ${id} was chosen more than once`);
		seen.add(`${sourceIndex}:${id}`);
		return {
			sourceIndex,
			trackId: id,
			language: sanitizeLanguageTag(a.language, `added audio ${id}`),
			trackName: typeof a.trackName === "string" ? a.trackName.trim().slice(0, 512) : "",
			isOriginal: !!a.isOriginal,
			isCommentary: !!a.isCommentary,
			isVisualImpaired: !!a.isVisualImpaired,
			isHearingImpaired: !!a.isHearingImpaired,
			replaces: Array.isArray(a.replaces) ? [...new Set(a.replaces.map((r) => trackId(r, "replaced audio track")))] : [],
		};
	});
	return { targetPath: raw.targetPath, sources, additions, replaceTarget: raw.replaceTarget !== false, ...(raw.applySettings ? { applySettings: true } : {}) };
}

export function describeReleaseAudioPlan(plan: ReleaseAudioPlan): string {
	return `Adding ${[...new Set(plan.additions.map((a) => a.language))].join(", ")} audio`;
}

/** A part of the source audio and where it starts in the target. */
export interface AudioSegment {
	sourceStartMs: number;
	sourceEndMs: number;
	targetStartMs: number;
}

/** Parts of `from` to `to` that no interval of `cuts` covers. */
function uncovered(from: number, to: number, cuts: Interval[]): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	let at = from;
	for (const cut of cuts) {
		if (cut.endMs <= at || cut.startMs >= to) continue;
		if (cut.startMs > at) out.push([at, cut.startMs]);
		at = Math.max(at, cut.endMs);
	}
	if (at < to) out.push([at, to]);
	return out;
}

/**
 * The parts of a release's audio that make up the target's timeline: each
 * piece of the time map with the parts the target lacks taken out. Parts
 * never overlap in the target, and nothing runs past `targetEndMs`. Where the
 * target has footage the release lacks, the parts leave a gap for silence.
 */
export function planAudioSegments(map: TimeMap, removed: Interval[], sourceEndMs: number, targetEndMs: number): AudioSegment[] {
	const cuts = mergeIntervals(removed);
	const pieces = [...map.pieces].sort((a, b) => a.fromMs - b.fromMs);
	const out: AudioSegment[] = [];
	let cursor = 0;
	pieces.forEach((piece, k) => {
		const from = k === 0 ? 0 : piece.fromMs;
		const to = Math.min(k + 1 < pieces.length ? pieces[k + 1]!.fromMs : sourceEndMs, sourceEndMs);
		for (const [start, end] of uncovered(from, to, cuts)) {
			let sourceStartMs = start;
			let targetStartMs = start * map.scale + piece.offsetMs;
			if (targetStartMs < cursor) {
				sourceStartMs += (cursor - targetStartMs) / map.scale;
				targetStartMs = cursor;
			}
			const sourceEndMs = Math.min(end, sourceStartMs + (targetEndMs - targetStartMs) / map.scale);
			if (sourceEndMs - sourceStartMs < 1) continue;
			out.push({ sourceStartMs, sourceEndMs, targetStartMs });
			cursor = targetStartMs + (sourceEndMs - sourceStartMs) * map.scale;
		}
	});
	return out;
}

/** ffmpeg decoding one audio track to FLAC whose first sample is the file's zero, as the encoder extracts audio. */
export function normalizedAudioArgs(sourcePath: string, audioOrder: number, delayMs: number, outputPath: string): string[] {
	const args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", sourcePath, "-map", `0:a:${audioOrder}`, "-vn", "-sn", "-dn"];
	if (delayMs < 0) args.push("-af", `atrim=start=${Math.abs(delayMs) / 1000}`);
	else if (delayMs > 0) args.push("-af", `adelay=${delayMs}:all=1`);
	args.push("-c:a", "flac", outputPath);
	return args;
}

/**
 * ffmpeg laying the segments of a normalized track out on the target's
 * timeline: each segment is read on its own, played `scale` times slower
 * when the frame rates differ, and followed by the silence up to the next.
 * The speed is changed by resampling, so a PAL speed-up loses its raised
 * pitch too. Upsampling first keeps the rounding of the rate under 5 ms an
 * hour.
 */
export function syncedAudioArgs(inputPath: string, outputPath: string, segments: AudioSegment[], scale: number, sampleRate: number): string[] {
	if (!segments.length) throw new Error("No audio to place");
	const seconds = (ms: number) => (ms / 1000).toFixed(6);
	const samples = (ms: number) => Math.round((ms * sampleRate) / 1000);
	const args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1", "-y"];
	for (const s of segments) args.push("-ss", seconds(s.sourceStartMs), "-t", seconds(s.sourceEndMs - s.sourceStartMs), "-i", inputPath);
	const chains = segments.map((s, k) => {
		const chain = ["asetpts=PTS-STARTPTS"];
		if (scale !== 1) {
			const up = sampleRate * 4;
			chain.push(`aresample=${up}`, `asetrate=${Math.round(up / scale)}`, `aresample=${sampleRate}`);
		}
		if (k === 0 && samples(s.targetStartMs) > 0) chain.push(`adelay=delays=${samples(s.targetStartMs)}S:all=1`);
		const next = segments[k + 1];
		if (next) {
			const gap = samples(next.targetStartMs) - samples(s.targetStartMs + (s.sourceEndMs - s.sourceStartMs) * scale);
			if (gap > 0) chain.push(`apad=pad_len=${gap}`);
		}
		return `[${k}:a]${chain.join(",")}[s${k}]`;
	});
	const graph =
		segments.length === 1
			? chains[0]!.replace(/\[s0\]$/, "[out]")
			: `${chains.join(";")};${segments.map((_, k) => `[s${k}]`).join("")}concat=n=${segments.length}:v=0:a=1[out]`;
	args.push("-filter_complex", graph, "-map", "[out]", "-c:a", "flac", outputPath);
	return args;
}

/** An added track as the mux takes it: straight from its release, moved by `syncMs`, or from a rebuilt file. */
export interface PreparedAudio {
	addition: ReleaseAudioAddition;
	syncMs?: number;
	file?: string;
	/** The release's own title and channels, which order it among the rest when the settings are applied. */
	sourceTitle?: string;
	channels?: number;
}

function addedTrackOptions(id: number, a: ReleaseAudioAddition, isDefault: boolean): string[] {
	return [
		"--language",
		`${id}:${a.language}`,
		"--track-name",
		`${id}:${a.trackName}`,
		"--default-track-flag",
		`${id}:${isDefault ? 1 : 0}`,
		"--forced-display-flag",
		`${id}:0`,
		"--track-enabled-flag",
		`${id}:1`,
		"--original-flag",
		`${id}:${a.isOriginal ? 1 : 0}`,
		"--commentary-flag",
		`${id}:${a.isCommentary ? 1 : 0}`,
		"--visual-impaired-flag",
		`${id}:${a.isVisualImpaired ? 1 : 0}`,
		"--hearing-impaired-flag",
		`${id}:${a.isHearingImpaired ? 1 : 0}`,
	];
}

const kindRank = (kind: AudioTrackType) => (kind === "main" ? 0 : kind === "commentary" ? 1 : 2);

/**
 * mkvmerge copying the target with its audio tracks less the replaced ones,
 * and the prepared tracks placed among them by the audio language priority.
 * Added tracks are never the default unless the target keeps no audio. With
 * `settings`, every audio track is ordered, named and flagged as an encode
 * with those settings would do it.
 */
export function buildReleaseAudioMkvmergeArgs(options: {
	outputPath: string;
	plan: ReleaseAudioPlan;
	target: MkvIdentification;
	prepared: PreparedAudio[];
	languagePriority: string[];
	settings?: AudioSettings;
}): string[] {
	const { outputPath, plan, target, prepared } = options;
	const tracks = target.tracks ?? [];
	const removed = new Set(prepared.flatMap((p) => p.addition.replaces));
	const allAudio = tracks.filter((t) => t.type === "audio");
	const kept = allAudio.filter((t) => !removed.has(t.id));
	const directSources = [...new Set(prepared.filter((p) => !p.file).map((p) => p.addition.sourceIndex))].sort((a, b) => a - b);
	const firstFile = directSources.length + 1;
	const files = prepared.filter((p) => p.file);
	const refOf = (p: PreparedAudio) =>
		p.file ? `${firstFile + files.indexOf(p)}:0` : `${directSources.indexOf(p.addition.sourceIndex) + 1}:${p.addition.trackId}`;

	type Entry = { ref: string; key?: [number, number]; added?: PreparedAudio; target?: MkvTrack; kind: AudioTrackType; isDefault?: boolean };
	const addedKind = (a: ReleaseAudioAddition): AudioTrackType => (a.isCommentary ? "commentary" : a.isVisualImpaired ? "descriptive" : "main");
	const detect = options.settings ? audioDetectOptions(options.settings) : undefined;
	const targetKind = (t: MkvTrack) =>
		releaseAudioKind(
			{ title: t.properties.track_name || "", isCommentary: !!t.properties.flag_commentary, isVisualImpaired: !!t.properties.flag_visual_impaired },
			detect,
		);
	const targetLanguage = (t: MkvTrack) => t.properties.language_ietf || t.properties.language || "und";
	let audio: Entry[];
	if (options.settings) {
		// The encode's own sort, fed titles that carry each track's kind, so flagged tracks without a telling title sort as what they are.
		const items = [
			...kept.map((t, i) => {
				const kind = targetKind(t);
				const p = t.properties as AudioProperties;
				return {
					entry: { ref: `0:${t.id}`, target: t, kind } as Entry,
					language: targetLanguage(t),
					title: p.track_name || "",
					channels: p.audio_channels || 0,
					i,
				};
			}),
			...prepared.map((p, i) => {
				const kind = addedKind(p.addition);
				const entry: Entry = { ref: refOf(p), added: p, kind };
				return { entry, language: p.addition.language, title: p.sourceTitle ?? p.addition.trackName, channels: p.channels ?? 0, i: kept.length + i };
			}),
		].map((item) => ({
			...item,
			index: item.i,
			channelLayout: "",
			delayMs: 0,
			title: item.entry.kind === "main" ? item.title : `${audioTrackName(item.entry.kind)} ${item.title}`.trim(),
		}));
		const sorted = sortAudioLikeEncode(items, options.settings);
		const defaults = audioDefaults(sorted.map((item) => ({ language: item.language, trackType: item.entry.kind })));
		audio = sorted.map((item, i) => ({ ...item.entry, isDefault: defaults[i] }));
	} else {
		const tier = buildLangTier(options.languagePriority.length ? options.languagePriority : ["*"]);
		const keyFor = (language: string, kind: AudioTrackType): [number, number] => [tier(language), kindRank(kind)];
		audio = kept.map((t) => {
			const kind = targetKind(t);
			return { ref: `0:${t.id}`, key: keyFor(targetLanguage(t), kind), kind };
		});
		for (const p of prepared) {
			const kind = addedKind(p.addition);
			const key = keyFor(p.addition.language, kind);
			let at = 0;
			audio.forEach((e, i) => {
				if (e.key && (e.key[0] < key[0] || (e.key[0] === key[0] && e.key[1] <= key[1]))) at = i + 1;
			});
			audio.splice(at, 0, { ref: refOf(p), key, added: p, kind });
		}
		const first = kept.length ? undefined : audio[0];
		if (first) first.isDefault = true;
	}
	const isDefault = (p: PreparedAudio) => !!audio.find((e) => e.added === p)?.isDefault;

	const order = [
		...tracks.filter((t) => t.type === "video").map((t) => `0:${t.id}`),
		...audio.map((e) => e.ref),
		...tracks.filter((t) => t.type !== "video" && t.type !== "audio").map((t) => `0:${t.id}`),
	];
	const args = ["mkvmerge", "--gui-mode", "-o", outputPath, "--track-order", order.join(",")];
	if (removed.size) args.push(...(kept.length ? ["--audio-tracks", kept.map((t) => t.id).join(",")] : ["--no-audio"]));
	if (options.settings) {
		for (const e of audio) {
			if (!e.target) continue;
			const id = e.target.id;
			args.push(
				"--track-name",
				`${id}:${audioTrackName(e.kind, e.target.properties.track_name || "")}`,
				"--default-track-flag",
				`${id}:${e.isDefault ? 1 : 0}`,
				"--forced-display-flag",
				`${id}:0`,
				"--commentary-flag",
				`${id}:${e.kind === "commentary" ? 1 : 0}`,
				"--visual-impaired-flag",
				`${id}:${e.kind === "descriptive" ? 1 : 0}`,
			);
		}
	}
	args.push(plan.targetPath);
	for (const index of directSources) {
		const direct = prepared.filter((p) => !p.file && p.addition.sourceIndex === index);
		args.push("--no-video", "--no-subtitles", "--no-chapters", "--no-attachments", "--no-global-tags", "--no-track-tags");
		args.push("--audio-tracks", direct.map((p) => p.addition.trackId).join(","));
		for (const p of direct) {
			args.push(...addedTrackOptions(p.addition.trackId, p.addition, isDefault(p)));
			if (p.syncMs) args.push("--sync", `${p.addition.trackId}:${p.syncMs}`);
		}
		args.push(plan.sources[index]!);
	}
	for (const p of files) args.push("--no-track-tags", ...addedTrackOptions(0, p.addition, isDefault(p)), p.file!);
	return args;
}

async function audioFileInfo(path: string, signal?: AbortSignal): Promise<{ sampleRate: number; durationMs: number }> {
	const result = await run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate:format=duration", "-of", "json", path], {
		signal,
	});
	if (signal?.aborted) throw new CancelledError();
	try {
		const data = JSON.parse(result.stdout);
		return { sampleRate: Number(data.streams?.[0]?.sample_rate) || 0, durationMs: Math.round(Number(data.format?.duration) * 1000) || 0 };
	} catch {
		return { sampleRate: 0, durationMs: 0 };
	}
}

export async function checked(args: string[], what: string, signal?: AbortSignal, onStdoutLine?: (line: string) => void): Promise<void> {
	const result = await run(args, { signal, onStdoutLine });
	if (signal?.aborted) throw new CancelledError();
	if (result.code !== 0) throw new Error(`${what} failed (exit ${result.code}): ${(result.stderr || result.stdout).trim().slice(-500)}`);
}

interface SourceTiming {
	map: TimeMap;
	removed: Interval[];
}

/** Copied as it is, with at most a delay, when the release only starts at another time and ends with the video. */
function canCopy(timing: SourceTiming | null, track: ReleaseAudioTrack, sourceDurationMs: number, targetEndMs: number): boolean {
	if (!timing) return (track.durationMs || sourceDurationMs) <= targetEndMs + OVERHANG_MS;
	if (timing.map.scale !== 1 || timing.map.pieces.length !== 1 || timing.removed.length) return false;
	return (track.durationMs || sourceDurationMs) + timing.map.pieces[0]!.offsetMs <= targetEndMs + OVERHANG_MS;
}

/**
 * Adds audio tracks from other releases to a video. Each release is lined up
 * with the video by the audio both have. A release that only starts at
 * another time has its tracks copied with a delay. One with another frame
 * rate, cuts, or audio running past the video has them rebuilt on the video's
 * timeline and encoded to Opus at the bitrates of the settings.
 */
export async function runReleaseAudioJob(job: Job, config: AppConfig, updateJob: (partial: Partial<Job>) => void, signal?: AbortSignal): Promise<void> {
	if (!job.audioPlan) throw new Error("Audio job has no plan");
	const plan = sanitizeReleaseAudioPlan(job.audioPlan);
	const tempDir = join(config.tempDir, job.id);
	mkdirSync(tempDir, { recursive: true });
	const stagePath = join(dirname(plan.targetPath), `.rabbit-audio-${job.id}.mkv`);
	const steps: JobStep[] = [
		{ label: "Inspect files", status: "pending", progress: 0 },
		{ label: "Align timing", status: "pending", progress: 0 },
		{ label: "Prepare audio", status: "pending", progress: 0 },
		{ label: "Stream-copy remux", status: "pending", progress: 0 },
	];
	const [S_INSPECT, S_ALIGN, S_PREPARE, S_MUX] = [0, 1, 2, 3];
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
		if (extname(plan.targetPath).toLowerCase() !== ".mkv") throw new Error("Audio can only be added to MKV files");
		for (const source of plan.sources) if (!existsSync(source)) throw new Error(`Release ${basename(source)} no longer exists`);
		if (existsSync(stagePath)) throw new Error(`Staging file already exists: ${stagePath}`);

		setStep(S_INSPECT, { status: "active", progress: 10 });
		updateJob({ status: "probing" });
		const [targetId, targetProbe] = await Promise.all([identifyMatroska(plan.targetPath, signal), probeFile(plan.targetPath)]);
		const sourceIds = await Promise.all(plan.sources.map((path) => identifyMatroska(path, signal)));
		const sourceProbes: ProbeResult[] = [];
		for (const path of plan.sources) sourceProbes.push(await probeFile(path));
		checkCancelled();
		updateJob({ probe: targetProbe });
		const targetAudio = audioTracksOf(targetId);
		const sourceAudio = sourceIds.map(audioTracksOf);
		for (const a of plan.additions) {
			if (!sourceAudio[a.sourceIndex]!.some((t) => t.id === a.trackId))
				throw new Error(`${basename(plan.sources[a.sourceIndex]!)} no longer has audio track ${a.trackId}`);
			for (const id of a.replaces) if (!targetAudio.some((t) => t.id === id)) throw new Error(`The video no longer has audio track ${id}`);
		}
		setStep(S_INSPECT, { status: "done", progress: 100, detail: `${plan.additions.length} audio track(s) to add` });

		setStep(S_ALIGN, { status: "active", progress: 10, detail: "Comparing the audio of the releases" });
		const warnings: string[] = [];
		let additions = [...plan.additions];
		const timings = new Map<number, SourceTiming | null>();
		const details: string[] = [];
		const used = [...new Set(additions.map((a) => a.sourceIndex))];
		for (const [n, index] of used.entries()) {
			const path = plan.sources[index]!;
			const label = used.length > 1 ? `${basename(path)}: ` : "";
			const alignment = await alignReleaseFiles(plan.targetPath, path, { cacheDir: config.tempDir, targetProbe, sourceProbe: sourceProbes[index], signal });
			checkCancelled();
			const problem = alignmentProblem(alignment);
			if (problem) {
				const dropped = [...new Set(additions.filter((a) => a.sourceIndex === index).map((a) => a.language))];
				additions = additions.filter((a) => a.sourceIndex !== index);
				const own = alignment.targetAudio.language || "und";
				const other = alignment.sourceAudio.language !== alignment.targetAudio.language;
				const hint = other ? `. It has no ${own} audio, so its ${alignment.sourceAudio.language || "und"} audio was compared, which rarely matches` : "";
				warnings.push(`Left out ${dropped.join(", ")} audio from ${basename(path)}: ${problem}${hint}`);
				details.push(`${label}does not match`);
			} else {
				const same = isIdentityTiming(alignment.map, alignment.removed);
				timings.set(index, same ? null : { map: alignment.map, removed: alignment.removed });
				const described = describeTiming(alignment.map, alignment.removed);
				Logger.info(
					`[audio] Timing of ${basename(path)} against ${basename(plan.targetPath)}: ${described}, ${Math.round(alignment.coveredShare * 100)}% matched`,
				);
				details.push(`${label}${same ? "already lines up" : `moving by ${described}`}`);
			}
			setStep(S_ALIGN, { progress: Math.round(((n + 1) / used.length) * 100) });
		}
		for (const warning of warnings) Logger.warn(`[audio] ${warning}`);
		if (!additions.length) throw new Error(warnings.join(". "));
		const detail = details.join(", ");
		setStep(S_ALIGN, { status: "done", progress: 100, detail: detail.charAt(0).toUpperCase() + detail.slice(1) });

		setStep(S_PREPARE, { status: "active", progress: 0 });
		updateJob({ status: "encoding_audio" });
		const targetEndMs = videoDurationMs(targetId);
		const prepared: PreparedAudio[] = [];
		let rebuilt = 0;
		const toOpus = !!plan.applySettings && job.settings.audioEncode !== "copy";
		for (const [n, addition] of additions.entries()) {
			checkCancelled();
			const index = addition.sourceIndex;
			const timing = timings.get(index) ?? null;
			const tracks = sourceAudio[index]!;
			const track = tracks.find((t) => t.id === addition.trackId)!;
			const name = `${addition.language} track ${addition.trackId}`;
			const share = (part: number) => Math.round(((n + part) / additions.length) * 100);
			const order = tracks.indexOf(track);
			const stream = sourceProbes[index]!.audioStreams[order];
			const own = { sourceTitle: track.title, channels: track.channels };
			const bitrate = opusBitrateFor({ channelLayout: stream?.channelLayout ?? "", channels: track.channels }, job.settings);
			const keepCodec = !toOpus || canKeepOpus({ codec: stream?.codec ?? track.codec, bitrate: stream?.bitrate || track.bitrate || undefined }, bitrate);
			if (keepCodec && canCopy(timing, track, Math.round(durationSeconds(sourceIds[index]!) * 1000), targetEndMs)) {
				prepared.push({ addition, ...own, ...(timing ? { syncMs: Math.round(timing.map.pieces[0]!.offsetMs) } : {}) });
				setStep(S_PREPARE, { progress: share(1), detail: `Copying ${name} as it is` });
				continue;
			}

			const normalized = join(tempDir, `audio_${n}.source.flac`);
			setStep(S_PREPARE, { progress: share(0), detail: `Decoding ${name}` });
			await checked(normalizedAudioArgs(plan.sources[index]!, order, stream?.delayMs ?? 0, normalized), `Decoding ${name}`, signal);
			const info = await audioFileInfo(normalized, signal);
			if (!info.sampleRate) throw new Error(`Could not read the sample rate of ${name}`);
			const map = timing?.map ?? IDENTITY_MAP;
			const segments = planAudioSegments(map, timing?.removed ?? [], info.durationMs || track.durationMs, targetEndMs);
			if (!segments.length) {
				warnings.push(`Left out ${name}: none of it falls inside the video`);
				rmSync(normalized, { force: true });
				continue;
			}
			const synced = join(tempDir, `audio_${n}.synced.flac`);
			const placedMs = segments.reduce((sum, s) => sum + (s.sourceEndMs - s.sourceStartMs) * map.scale, 0);
			setStep(S_PREPARE, { progress: share(0.2), detail: `Placing ${name} on the video's timeline` });
			await checked(syncedAudioArgs(normalized, synced, segments, map.scale, info.sampleRate), `Syncing ${name}`, signal, (line) => {
				const done = ffmpegProgress(line, placedMs / 1000);
				if (done !== null) setStep(S_PREPARE, { progress: share(0.2 + done * 0.5) });
			});
			rmSync(normalized, { force: true });
			const opus = join(tempDir, `audio_${n}.opus`);
			setStep(S_PREPARE, { progress: share(0.7), detail: `Encoding ${name} to Opus at ${bitrate} kbps` });
			await checked(opusencArgs(synced, opus, bitrate, job.settings), `Encoding ${name}`, signal);
			rmSync(synced, { force: true });
			prepared.push({ addition, ...own, file: opus });
			rebuilt++;
		}
		if (!prepared.length) throw new Error(warnings.join(". "));
		if (warnings.length) updateJob({ warning: warnings.join(". ") });
		const copied = prepared.length - rebuilt;
		setStep(S_PREPARE, {
			status: "done",
			progress: 100,
			detail: [copied ? `${copied} copied` : "", rebuilt ? `${rebuilt} encoded to Opus` : ""].filter(Boolean).join(", "),
		});

		setStep(S_MUX, { status: "active", progress: 0, detail: "Copying streams without video encoding" });
		updateJob({ status: "muxing" });
		const args = buildReleaseAudioMkvmergeArgs({
			outputPath: stagePath,
			plan,
			target: targetId,
			prepared,
			languagePriority: job.settings.audioLanguagePriority,
			...(plan.applySettings ? { settings: job.settings } : {}),
		});
		Logger.info(`[audio] Adding ${prepared.map((p) => p.addition.language).join(", ")} audio to ${basename(plan.targetPath)}`);
		const merged = await run(args, {
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
		const ofType = (id: MkvIdentification, type: string) => (id.tracks ?? []).filter((t) => t.type === type);
		const codecs = (id: MkvIdentification, type: string) => JSON.stringify(ofType(id, type).map((t) => t.properties.codec_id || t.codec));
		if (codecs(targetId, "video") !== codecs(verified, "video")) throw new Error("Verification failed: the video tracks changed");
		if (codecs(targetId, "subtitles") !== codecs(verified, "subtitles")) throw new Error("Verification failed: the subtitle tracks changed");
		const removed = new Set(prepared.flatMap((p) => p.addition.replaces));
		const expectedAudio = targetAudio.filter((t) => !removed.has(t.id)).length + prepared.length;
		if (ofType(verified, "audio").length !== expectedAudio)
			throw new Error(`Verification failed: expected ${expectedAudio} audio tracks, found ${ofType(verified, "audio").length}`);
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
