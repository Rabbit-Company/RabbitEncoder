import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { basename, dirname, extname, join, parse as parsePath } from "path";
import type {
	AppConfig,
	Job,
	JobStep,
	RepairInspectionFile,
	RepairAuditFile,
	RepairAuditGroup,
	RepairAuditTrack,
	RepairAuditGroupEdit,
	RepairAuditLanguage,
	RepairAuditLanguageRemoval,
	RepairFolderAudit,
	RepairPlan,
	RepairSource,
	RepairSubtitleTrack,
	RepairSubtitleTrackPlan,
	SubtitleStyle,
	JobSettings,
} from "../core/types";
import { Logger } from "../core/logger";
import { CancelledError, humanSize, run } from "../core/process";
import { collectKeptAttachments, fontRegistry, keptAttachmentArgs, scanMkvAttachmentFontNames, type KeptAttachment } from "../fonts/fonts";
import { createFaceMaterializer, isRabbitGroupFace, type FaceMaterializer } from "../fonts/inject";
import { extractUsedFonts, normalizeFontName } from "../subtitles/ass-classifier";
import { styleSrtAss, restyleAssDialogueFont } from "../subtitles/ass-style";
import { zlibWorthIt } from "../subtitles/zlib-probe";
import { DEFAULT_STYLE_APPEARANCE } from "../subtitles/subtitle-style";
import { detectSubtitleTrackType, normalizeLanguageGroup, sanitizeLanguageTag } from "../tracks/tracks";
import { planSubtitleTracks } from "../tracks/subtitle-plan";
import { resolveUniqueOutputPath } from "./output";
import { probeFile } from "./probe";
import { analyzeSourceTracks } from "./source-analysis";
import {
	alignmentProblem,
	describeTiming,
	mkvmergeSync,
	retimeSubtitleText,
	retimingFailed,
	retimingFits,
	sourceTimingFor,
	type SourceTiming,
} from "./repair-timing";
import { alignReleaseFiles } from "../sync/release-align";
import {
	fontAttachment,
	planSourceFonts,
	readInputFonts,
	renameAssFonts,
	renamedNames,
	renameFontFamily,
	type AssFontRename,
	type InputFont,
} from "./repair-fonts";
import { buildReference, type ReferenceTimeline } from "../subsearch/reference";

interface MkvTrackProperties {
	codec_id?: string;
	language?: string;
	language_ietf?: string;
	track_name?: string;
	default_track?: boolean;
	forced_track?: boolean;
	enabled_track?: boolean;
	flag_hearing_impaired?: boolean;
	flag_visual_impaired?: boolean;
	flag_text_descriptions?: boolean;
	flag_original?: boolean;
	flag_commentary?: boolean;
	content_encoding_algorithms?: string;
	/** Track length from mkvmerge's statistics tags, such as "00:23:40.123000000". */
	tag_duration?: string;
}

interface MkvTrack {
	id: number;
	type: string;
	codec: string;
	properties: MkvTrackProperties;
}

export interface MkvIdentification {
	tracks?: MkvTrack[];
	attachments?: { id: number; file_name: string }[];
	errors?: string[];
	container?: { properties?: { duration?: number } };
}

const MAX_REPAIR_TRACKS = 128;

function checkedText(value: unknown, max: number): string {
	return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function isRabbitProcessable(track: MkvTrack): boolean {
	const codec = `${track.codec} ${track.properties.codec_id || ""}`.toLowerCase();
	return (
		codec.includes("substation") || codec.includes("s_text/ass") || codec.includes("s_text/ssa") || codec.includes("subrip") || codec.includes("s_text/utf8")
	);
}

export async function identifyMatroska(path: string, signal?: AbortSignal): Promise<MkvIdentification> {
	const result = await run(["mkvmerge", "-J", path], { signal });
	if (signal?.aborted) throw new CancelledError();
	if (result.code !== 0) throw new Error(`mkvmerge could not inspect ${basename(path)}: ${(result.stderr || result.stdout).slice(-500)}`);
	try {
		return JSON.parse(result.stdout) as MkvIdentification;
	} catch {
		throw new Error(`mkvmerge returned invalid identification data for ${basename(path)}`);
	}
}

export async function inspectRepairFile(path: string, signal?: AbortSignal): Promise<RepairInspectionFile> {
	const identified = await identifyMatroska(path, signal);
	const subtitles: RepairSubtitleTrack[] = (identified.tracks || [])
		.filter((track) => track.type === "subtitles")
		.map((track) => ({
			id: track.id,
			codec: track.codec,
			codecId: track.properties.codec_id || "",
			language: track.properties.language_ietf || track.properties.language || "und",
			title: track.properties.track_name || "",
			isDefault: !!track.properties.default_track,
			isForced: !!track.properties.forced_track,
			isEnabled: track.properties.enabled_track !== false,
			isHearingImpaired: !!track.properties.flag_hearing_impaired,
			isOriginal: !!track.properties.flag_original,
			isCommentary: !!track.properties.flag_commentary,
			canRabbitProcess: isRabbitProcessable(track),
			currentCompression: track.properties.content_encoding_algorithms?.split(",").includes("0") ? "zlib" : "none",
		}));
	return { path, filename: basename(path), durationSeconds: (identified.container?.properties?.duration || 0) / 1_000_000_000, subtitles };
}

/**
 * Build a plan that throws away the encode's subtitles and re-imports every
 * subtitle the source offers, run through the same workflow an encode uses:
 * language and type filters, source priority ordering, dedupe, track naming,
 * and the default/forced/SDH/commentary flags.
 *
 * Tracks Rabbit can restyle are planned as "rabbit"; picture-based ones are
 * copied verbatim. The caller still shows the result for review before it runs.
 */
export async function buildSourceReplacementPlan(options: {
	targetPath: string;
	sourcePath: string;
	settings: JobSettings;
	tempDir: string;
	replaceTarget: boolean;
	signal?: AbortSignal;
}): Promise<RepairPlan> {
	const { targetPath, sourcePath, settings, tempDir, replaceTarget, signal } = options;

	const [identified, probe] = await Promise.all([identifyMatroska(sourcePath, signal), probeFile(sourcePath)]);
	if (signal?.aborted) throw new CancelledError();

	// ffprobe stream indexes and mkvmerge track IDs are different numbering
	// schemes, so the two lists are matched by their order among subtitles.
	const sourceSubtitleTracks = (identified.tracks || []).filter((track) => track.type === "subtitles");
	const probeSubtitles = probe.subtitleStreams || [];
	if (sourceSubtitleTracks.length === 0) throw new Error("The source has no subtitle tracks to import");
	if (sourceSubtitleTracks.length !== probeSubtitles.length) {
		throw new Error(`Could not match the source's subtitle tracks (mkvmerge reports ${sourceSubtitleTracks.length}, ffprobe ${probeSubtitles.length})`);
	}
	const trackByStreamIndex = new Map<number, MkvTrack>();
	probeSubtitles.forEach((stream, ordinal) => trackByStreamIndex.set(stream.index, sourceSubtitleTracks[ordinal]!));

	const analyzed = await analyzeSourceTracks(probe, settings, sourcePath, tempDir, signal ?? new AbortController().signal);
	if (signal?.aborted) throw new CancelledError();
	if (analyzed.subtitleStreams.length === 0) throw new Error("No source subtitle tracks survived the current subtitle settings");

	const tracks: RepairSubtitleTrackPlan[] = [];
	for (const planned of planSubtitleTracks(analyzed.subtitleStreams, { renameTracks: settings.renameSubtitleTracks })) {
		const track = trackByStreamIndex.get(planned.stream.index);
		if (!track) continue;
		tracks.push({
			source: "source",
			trackId: track.id,
			mode: isRabbitProcessable(track) ? "rabbit" : "copy",
			order: tracks.length,
			title: planned.trackName,
			language: sanitizeLanguageTag(planned.effectiveLang),
			compression: settings.compressSubtitles ? "auto" : "none",
			isDefault: planned.isDefault,
			isForced: planned.isForced,
			isEnabled: true,
			isHearingImpaired: planned.isHearingImpaired,
			isOriginal: planned.isOriginal,
			isCommentary: planned.isCommentary,
		});
	}
	if (tracks.length === 0) throw new Error("No source subtitle tracks could be matched to the file's tracks");

	Logger.info(`[repair] Replacement plan: ${tracks.length} source subtitle track(s) for ${basename(targetPath)}`);
	return sanitizeRepairPlan({ targetPath, sourcePath, replaceTarget, tracks });
}

function auditTrack(track: MkvTrack): RepairAuditTrack {
	return {
		id: track.id,
		type: track.type as "audio" | "subtitles",
		codec: track.codec,
		language: track.properties.language_ietf || track.properties.language || "und",
		title: track.properties.track_name || "",
		isDefault: !!track.properties.default_track,
		isForced: !!track.properties.forced_track,
		isEnabled: track.properties.enabled_track !== false,
		isHearingImpaired: !!track.properties.flag_hearing_impaired,
		isVisualImpaired: !!track.properties.flag_visual_impaired,
		isTextDescriptions: !!track.properties.flag_text_descriptions,
		isOriginal: !!track.properties.flag_original,
		isCommentary: !!track.properties.flag_commentary,
		compression: track.properties.content_encoding_algorithms?.split(",").includes("0") ? "zlib" : "none",
	};
}

export async function inspectRepairAuditFile(path: string, signal?: AbortSignal): Promise<Omit<RepairAuditFile, "group" | "groupLabel" | "differences">> {
	const identified = await identifyMatroska(path, signal);
	return {
		path,
		filename: basename(path),
		tracks: (identified.tracks || []).filter((track) => track.type === "audio" || track.type === "subtitles").map(auditTrack),
	};
}

function auditFlags(track: RepairAuditTrack): boolean[] {
	return [
		track.isDefault,
		track.isForced,
		track.isEnabled,
		track.isHearingImpaired,
		track.isVisualImpaired,
		track.isTextDescriptions,
		track.isOriginal,
		track.isCommentary,
	];
}

function auditFlagNames(track: RepairAuditTrack): string {
	const names = ["Default", "Forced", track.isEnabled ? "Enabled" : "Disabled", "HI", "VI", "Descriptions", "Original", "Commentary"].filter(
		(_, index) => index === 2 || auditFlags(track)[index],
	);
	return names.length ? names.join(", ") : "none";
}

function auditSignature(file: Pick<RepairAuditFile, "tracks">): string {
	return JSON.stringify(file.tracks.map((track) => [track.type, track.language, track.title, ...auditFlags(track)]));
}

export function repairAuditGroupLabel(group: number): string {
	let value = Math.max(0, Math.floor(group));
	let label = "";
	do {
		label = String.fromCharCode(65 + (value % 26)) + label;
		value = Math.floor(value / 26) - 1;
	} while (value >= 0);
	return label;
}

function shortTrack(track: RepairAuditTrack): string {
	const title = track.title ? ` (${track.title})` : "";
	return `${track.language}${title}`;
}

const AUDIT_GAP_COST = 10;

/** How unlike two tracks are. Tracks that differ in both language and title cost more than a missing plus an extra track. */
function auditTrackDistance(actual: RepairAuditTrack, expected: RepairAuditTrack): number {
	return (
		(actual.language !== expected.language ? 12 : 0) +
		(actual.title !== expected.title ? 9 : 0) +
		(JSON.stringify(auditFlags(actual)) !== JSON.stringify(auditFlags(expected)) ? 3 : 0)
	);
}

/**
 * Pair up the tracks of a file with the tracks of the majority layout by edit distance,
 * so one missing or extra track does not shift every later track into a mismatch.
 * Each pair holds the indexes of the matched tracks, or undefined on the side that has none.
 */
function alignAuditTracks(actual: RepairAuditTrack[], expected: RepairAuditTrack[]): [number | undefined, number | undefined][] {
	const cost: number[][] = Array.from({ length: actual.length + 1 }, () => new Array<number>(expected.length + 1).fill(0));
	for (let i = 1; i <= actual.length; i++) cost[i]![0] = i * AUDIT_GAP_COST;
	for (let j = 1; j <= expected.length; j++) cost[0]![j] = j * AUDIT_GAP_COST;
	for (let i = 1; i <= actual.length; i++) {
		for (let j = 1; j <= expected.length; j++) {
			cost[i]![j] = Math.min(
				cost[i - 1]![j - 1]! + auditTrackDistance(actual[i - 1]!, expected[j - 1]!),
				cost[i - 1]![j]! + AUDIT_GAP_COST,
				cost[i]![j - 1]! + AUDIT_GAP_COST,
			);
		}
	}
	const pairs: [number | undefined, number | undefined][] = [];
	let i = actual.length;
	let j = expected.length;
	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && cost[i]![j] === cost[i - 1]![j - 1]! + auditTrackDistance(actual[i - 1]!, expected[j - 1]!)) {
			pairs.push([--i, --j]);
		} else if (i > 0 && cost[i]![j] === cost[i - 1]![j]! + AUDIT_GAP_COST) {
			pairs.push([--i, undefined]);
		} else {
			pairs.push([undefined, --j]);
		}
	}
	return pairs.reverse();
}

function auditDifferences(file: Pick<RepairAuditFile, "tracks">, majority: Pick<RepairAuditFile, "tracks">): string[] {
	const differences: string[] = [];
	for (const type of ["audio", "subtitles"] as const) {
		const actualTracks = file.tracks.filter((track) => track.type === type);
		const expectedTracks = majority.tracks.filter((track) => track.type === type);
		const label = (index: number) => `${type === "audio" ? "Audio" : "Subtitle"} ${index + 1}`;
		const pairs = alignAuditTracks(actualTracks, expectedTracks);
		const missing = pairs.filter(([actual]) => actual === undefined).map(([, expected]) => expected!);
		const extra = pairs.filter(([, expected]) => expected === undefined).map(([actual]) => actual!);

		// An extra track that is identical to a missing one is the same track in another position.
		const moved: [number, number][] = [];
		for (const actualIndex of [...extra]) {
			const match = missing.find((expectedIndex) => auditTrackDistance(actualTracks[actualIndex]!, expectedTracks[expectedIndex]!) === 0);
			if (match === undefined) continue;
			moved.push([actualIndex, match]);
			extra.splice(extra.indexOf(actualIndex), 1);
			missing.splice(missing.indexOf(match), 1);
		}

		for (const index of missing) differences.push(`Missing ${label(index)}: ${shortTrack(expectedTracks[index]!)}`);
		for (const index of extra) differences.push(`Extra ${label(index)}: ${shortTrack(actualTracks[index]!)}`);
		for (const [actualIndex, expectedIndex] of moved) {
			differences.push(`${label(actualIndex)} is ${label(expectedIndex)} in group A: ${shortTrack(actualTracks[actualIndex]!)}`);
		}

		for (const [actualIndex, expectedIndex] of pairs) {
			if (actualIndex === undefined || expectedIndex === undefined) continue;
			const actual = actualTracks[actualIndex]!;
			const expected = expectedTracks[expectedIndex]!;
			// Name the group A position too when the matched track sits somewhere else there.
			const name = actualIndex === expectedIndex ? label(actualIndex) : `${label(actualIndex)} (${label(expectedIndex)} in group A)`;
			if (actual.language !== expected.language) differences.push(`${name} language is ${actual.language}. Group A uses ${expected.language}.`);
			if (actual.title !== expected.title)
				differences.push(`${name} title is “${actual.title || "untitled"}”. Group A uses “${expected.title || "untitled"}”.`);
			if (JSON.stringify(auditFlags(actual)) !== JSON.stringify(auditFlags(expected))) {
				differences.push(`${name} flags are ${auditFlagNames(actual)}. Group A uses ${auditFlagNames(expected)}.`);
			}
		}
	}
	return differences;
}

/** Cluster files by their ordered audio/subtitle metadata. Group A is the largest layout. */
export function groupRepairAuditFiles(rawFiles: Array<Omit<RepairAuditFile, "group" | "groupLabel" | "differences">>, path?: string): RepairFolderAudit {
	const signatures: { signature: string; firstIndex: number; count: number }[] = [];
	for (const [index, file] of rawFiles.entries()) {
		const signature = auditSignature(file);
		const existing = signatures.find((entry) => entry.signature === signature);
		if (existing) existing.count++;
		else signatures.push({ signature, firstIndex: index, count: 1 });
	}
	const ranked = [...signatures].sort((a, b) => b.count - a.count || a.firstIndex - b.firstIndex);
	const groupBySignature = new Map(ranked.map((entry, group) => [entry.signature, group]));
	const majority = ranked[0] ? rawFiles[ranked[0].firstIndex]! : undefined;
	const files: RepairAuditFile[] = rawFiles.map((file) => {
		const group = groupBySignature.get(auditSignature(file)) || 0;
		return {
			...file,
			group,
			groupLabel: repairAuditGroupLabel(group),
			differences: group === 0 || !majority ? [] : auditDifferences(file, majority),
		};
	});
	const groups: RepairAuditGroup[] = ranked.map((entry, group) => ({
		group,
		label: repairAuditGroupLabel(group),
		count: entry.count,
		representativePath: rawFiles[entry.firstIndex]!.path,
	}));
	return { path, files, groups, languages: auditLanguages(rawFiles) };
}

/** Each subtitle language of the files, the most widespread first, with the files it is missing from. */
export function auditLanguages(files: Pick<RepairAuditFile, "filename" | "tracks">[]): RepairAuditLanguage[] {
	const byLanguage = new Map<string, { files: Set<string>; tracks: number }>();
	for (const file of files) {
		for (const track of file.tracks) {
			if (track.type !== "subtitles") continue;
			const entry = byLanguage.get(track.language) ?? { files: new Set<string>(), tracks: 0 };
			entry.files.add(file.filename);
			entry.tracks++;
			byLanguage.set(track.language, entry);
		}
	}
	return [...byLanguage]
		.map(([language, entry]) => ({
			language,
			fileCount: entry.files.size,
			trackCount: entry.tracks,
			missingFrom: files.map((file) => file.filename).filter((name) => !entry.files.has(name)),
		}))
		.sort((a, b) => b.fileCount - a.fileCount || a.language.localeCompare(b.language));
}

/**
 * Plans that drop every subtitle track in the chosen languages and keep the
 * rest as they are. Files without any of those languages are left out.
 */
export function buildRepairLanguageRemovalPlans(files: Pick<RepairAuditFile, "path" | "tracks">[], removal: RepairAuditLanguageRemoval): RepairPlan[] {
	if (!Array.isArray(removal.languages) || !removal.languages.length) throw new Error("Choose at least one language to remove");
	const remove = new Set(removal.languages.filter((language) => typeof language === "string"));
	const plans = files.flatMap((file) => {
		const subtitles = file.tracks.filter((track) => track.type === "subtitles");
		if (!subtitles.some((track) => remove.has(track.language))) return [];
		const kept = subtitles.filter((track) => !remove.has(track.language));
		return [
			sanitizeRepairPlan({
				targetPath: file.path,
				replaceTarget: !!removal.replaceTarget,
				tracks: kept.map((track, order) => ({
					title: track.title,
					language: track.language,
					isDefault: track.isDefault,
					isForced: track.isForced,
					isEnabled: track.isEnabled,
					isHearingImpaired: track.isHearingImpaired,
					isOriginal: track.isOriginal,
					isCommentary: track.isCommentary,
					source: "target",
					trackId: track.id,
					mode: "copy",
					order,
					compression: "preserve",
				})),
			}),
		];
	});
	if (!plans.length) throw new Error("None of the files have subtitles in those languages");
	return plans;
}

/** Match subtitles by their ordered position, since MKV track IDs can differ between episodes. */
export function buildRepairAuditGroupPlans(files: Pick<RepairAuditFile, "path" | "tracks">[], edit: RepairAuditGroupEdit): RepairPlan[] {
	if (!Array.isArray(edit.expectedTracks) || !Array.isArray(edit.subtitles)) throw new Error("Group track metadata is required");
	const expectedSignature = auditSignature({ tracks: edit.expectedTracks });
	const subtitleCount = edit.expectedTracks.filter((track) => track.type === "subtitles").length;
	if (!subtitleCount || edit.subtitles.length !== subtitleCount) throw new Error("Group edits must preserve every subtitle track");
	return files.map((file) => {
		if (auditSignature(file) !== expectedSignature) throw new Error(`${basename(file.path)} metadata changed since the audit. Audit the folder again.`);
		return sanitizeRepairPlan({
			targetPath: file.path,
			replaceTarget: edit.replaceTarget,
			tracks: file.tracks
				.filter((track) => track.type === "subtitles")
				.map((track, order) => {
					const metadata = edit.subtitles[order]!;
					return {
						title: metadata.title,
						language: metadata.language,
						isDefault: metadata.isDefault,
						isForced: metadata.isForced,
						isEnabled: metadata.isEnabled,
						isHearingImpaired: metadata.isHearingImpaired,
						isOriginal: metadata.isOriginal,
						isCommentary: metadata.isCommentary,
						source: "target",
						trackId: track.id,
						mode: "copy",
						order,
						compression: "preserve",
					};
				}),
		});
	});
}

function tagSeconds(value: string | undefined): number {
	const m = value?.match(/^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/);
	return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

/**
 * How long the video and audio last. A subtitle track can run past them and
 * stretch the file, so removing it would look like lost video if the
 * container duration were compared. That is only the fallback.
 */
export function durationSeconds(identified: MkvIdentification): number {
	const media = (identified.tracks ?? [])
		.filter((track) => track.type === "video" || track.type === "audio")
		.map((track) => tagSeconds(track.properties.tag_duration))
		.filter((seconds) => seconds > 0);
	return media.length ? Math.max(...media) : (identified.container?.properties?.duration || 0) / 1_000_000_000;
}

function durationsAreCompatible(a: MkvIdentification, b: MkvIdentification): boolean {
	const aSeconds = durationSeconds(a);
	const bSeconds = durationSeconds(b);
	if (aSeconds <= 0 || bSeconds <= 0) return true;
	return Math.abs(aSeconds - bSeconds) <= Math.max(2, aSeconds * 0.01);
}

/** Every source of a plan: `sourcePath` first, then its extra sources. */
export function repairSources(plan: Pick<RepairPlan, "sourcePath" | "alignSource" | "extraSources">): RepairSource[] {
	if (!plan.sourcePath) return [];
	return [{ path: plan.sourcePath, ...(plan.alignSource ? { alignSource: true } : {}) }, ...(plan.extraSources ?? [])];
}

/** Which source a source track comes from, or -1 for a target track. */
export function sourceIndexOf(track: Pick<RepairSubtitleTrackPlan, "source" | "sourceIndex">): number {
	return track.source === "source" ? (track.sourceIndex ?? 0) : -1;
}

/** "target:3", "source:5" for a track of the first source, "source2:5" for one of the third. */
export function repairTrackKey(track: Pick<RepairSubtitleTrackPlan, "source" | "sourceIndex" | "trackId">): string {
	if (track.source === "target") return `target:${track.trackId}`;
	return `source${track.sourceIndex || ""}:${track.trackId}`;
}

const MAX_EXTRA_SOURCES = 9;

/** Normalize untrusted API/persisted repair input before it reaches mkvmerge. */
export function sanitizeRepairPlan(raw: RepairPlan): RepairPlan {
	if (!raw || typeof raw !== "object") throw new Error("Invalid repair plan");
	const targetPath = checkedText(raw.targetPath, 4096);
	const sourcePath = checkedText(raw.sourcePath, 4096) || undefined;
	if (!targetPath) throw new Error("An encoded target path is required");
	const replaceFromSource = !!raw.replaceFromSource;
	if (replaceFromSource && !sourcePath) throw new Error("Replacing subtitles from source requires a source path");
	const alignSource = !!raw.alignSource && !!sourcePath;
	if (raw.extraSources !== undefined && !Array.isArray(raw.extraSources)) throw new Error("Invalid extra subtitle sources");
	const extraSources: RepairSource[] = (raw.extraSources ?? []).map((item, index) => {
		const path = checkedText(item?.path, 4096);
		if (!path) throw new Error(`Subtitle source ${index + 2} has no path`);
		return { path, ...(item.alignSource ? { alignSource: true } : {}) };
	});
	if (extraSources.length && !sourcePath) throw new Error("Extra subtitle sources need a first source");
	if (extraSources.length > MAX_EXTRA_SOURCES) throw new Error(`A repair job may take subtitles from at most ${MAX_EXTRA_SOURCES + 1} sources`);
	if (new Set([sourcePath, ...extraSources.map((s) => s.path)]).size !== extraSources.length + 1) throw new Error("The same subtitle source was chosen twice");
	if (extraSources.length && replaceFromSource) throw new Error("Replacing subtitles from source takes a single source");
	const sourceFields = { ...(alignSource ? { alignSource } : {}), ...(extraSources.length ? { extraSources } : {}) };
	if (!Array.isArray(raw.tracks)) {
		// A replacement plan is built when the job runs, so it starts without tracks.
		if (replaceFromSource) return { targetPath, sourcePath, replaceTarget: !!raw.replaceTarget, replaceFromSource, ...sourceFields, tracks: [] };
		throw new Error("Subtitle track plan is required");
	}
	if (raw.tracks.length > MAX_REPAIR_TRACKS) throw new Error(`A repair job may contain at most ${MAX_REPAIR_TRACKS} subtitle tracks`);

	const seen = new Set<string>();
	const tracks = raw.tracks.map((item, index): RepairSubtitleTrackPlan => {
		const source = item?.source === "source" ? "source" : item?.source === "target" ? "target" : null;
		const trackId = Number(item?.trackId);
		if (!source || !Number.isInteger(trackId) || trackId < 0) throw new Error(`Invalid subtitle track at position ${index + 1}`);
		if (source === "source" && !sourcePath) throw new Error("A source path is required for imported subtitle tracks");
		const sourceIndex = source === "source" && item.sourceIndex !== undefined ? Number(item.sourceIndex) : 0;
		if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex > extraSources.length)
			throw new Error(`Subtitle track at position ${index + 1} names a source the plan does not have`);
		const key = repairTrackKey({ source, trackId, sourceIndex });
		if (seen.has(key)) throw new Error(`Subtitle track ${key} was selected more than once`);
		seen.add(key);
		const mode = item.mode === "rabbit" ? "rabbit" : "copy";
		const compression = item.compression === "zlib" ? "zlib" : item.compression === "none" ? "none" : item.compression === "auto" ? "auto" : "preserve";
		return {
			source,
			trackId,
			mode,
			order: Number.isFinite(item.order) ? Math.max(0, Math.round(item.order)) : index,
			title: checkedText(item.title, 512),
			language: sanitizeLanguageTag(item.language, `repair ${key}`),
			compression,
			isDefault: !!item.isDefault,
			isForced: !!item.isForced,
			isEnabled: item.isEnabled !== false,
			isHearingImpaired: !!item.isHearingImpaired,
			isOriginal: !!item.isOriginal,
			isCommentary: !!item.isCommentary,
			...(sourceIndex ? { sourceIndex } : {}),
		};
	});
	tracks.sort((a, b) => a.order - b.order);
	tracks.forEach((track, index) => (track.order = index));
	return { targetPath, sourcePath, replaceTarget: !!raw.replaceTarget, replaceFromSource, ...sourceFields, tracks };
}

function trackUsesZlib(track: MkvTrack | undefined): boolean {
	return !!track?.properties.content_encoding_algorithms?.split(",").includes("0");
}

function trackOptions(plan: RepairSubtitleTrackPlan, trackId: number, original?: MkvTrack): string[] {
	const args = [
		"--language",
		`${trackId}:${plan.language}`,
		"--track-name",
		`${trackId}:${plan.title}`,
		"--default-track-flag",
		`${trackId}:${plan.isDefault ? 1 : 0}`,
		"--forced-display-flag",
		`${trackId}:${plan.isForced ? 1 : 0}`,
		"--track-enabled-flag",
		`${trackId}:${plan.isEnabled ? 1 : 0}`,
		"--hearing-impaired-flag",
		`${trackId}:${plan.isHearingImpaired ? 1 : 0}`,
		"--original-flag",
		`${trackId}:${plan.isOriginal ? 1 : 0}`,
		"--commentary-flag",
		`${trackId}:${plan.isCommentary ? 1 : 0}`,
	];

	const keepExisting = plan.compression === "preserve" || plan.compression === "auto";
	const compression = keepExisting ? (trackUsesZlib(original) ? "zlib" : "none") : plan.compression;
	args.push("--compression", `${trackId}:${compression}`);
	return args;
}

function languageMatches(planLanguage: string, properties: MkvTrackProperties): boolean {
	const ietf = properties.language_ietf || "";
	if (planLanguage.includes("-")) return ietf.toLowerCase() === planLanguage.toLowerCase();
	return normalizeLanguageGroup(ietf || properties.language || "und") === normalizeLanguageGroup(planLanguage);
}

function assertSubtitlePlanApplied(plan: RepairPlan, outputTracks: MkvTrack[], target: MkvIdentification, sources: MkvIdentification[]): void {
	for (let index = 0; index < plan.tracks.length; index++) {
		const expected = plan.tracks[index]!;
		const actual = outputTracks[index];
		if (!actual) throw new Error(`Verification failed: subtitle ${index + 1} is missing`);
		const properties = actual.properties;
		if ((properties.track_name || "") !== expected.title) throw new Error(`Verification failed: subtitle ${index + 1} title was not applied`);
		if (!languageMatches(expected.language, properties)) throw new Error(`Verification failed: subtitle ${index + 1} language was not applied`);
		if (!!properties.default_track !== expected.isDefault) throw new Error(`Verification failed: subtitle ${index + 1} default flag was not applied`);
		if (!!properties.forced_track !== expected.isForced) throw new Error(`Verification failed: subtitle ${index + 1} forced flag was not applied`);
		if ((properties.enabled_track !== false) !== expected.isEnabled) throw new Error(`Verification failed: subtitle ${index + 1} enabled flag was not applied`);
		if (!!properties.flag_hearing_impaired !== expected.isHearingImpaired)
			throw new Error(`Verification failed: subtitle ${index + 1} HI flag was not applied`);
		if (!!properties.flag_original !== expected.isOriginal) throw new Error(`Verification failed: subtitle ${index + 1} original flag was not applied`);
		if (!!properties.flag_commentary !== expected.isCommentary) throw new Error(`Verification failed: subtitle ${index + 1} commentary flag was not applied`);
		const original = findTrack(expected.source === "target" ? target : sources[sourceIndexOf(expected)]!, expected);
		const expectedZlib = expected.compression === "zlib" || (expected.compression === "preserve" && trackUsesZlib(original));
		if (trackUsesZlib(actual) !== expectedZlib) throw new Error(`Verification failed: subtitle ${index + 1} compression was not applied`);
	}
}

function findTrack(identified: MkvIdentification, plan: RepairSubtitleTrackPlan): MkvTrack {
	const track = (identified.tracks || []).find((candidate) => candidate.type === "subtitles" && candidate.id === plan.trackId);
	if (!track) throw new Error(`${plan.source} subtitle track ${plan.trackId} no longer exists`);
	if (plan.mode === "rabbit" && !isRabbitProcessable(track))
		throw new Error(`${plan.source} subtitle track ${plan.trackId} (${track.codec}) cannot be Rabbit-processed`);
	return track;
}

export function isMetadataOnlyRepair(plan: RepairPlan, target: MkvIdentification): boolean {
	const originalSubtitles = (target.tracks || []).filter((track) => track.type === "subtitles");
	return (
		plan.tracks.length === originalSubtitles.length &&
		plan.tracks.every(
			(track, index) =>
				track.source === "target" && track.mode === "copy" && track.compression === "preserve" && track.trackId === originalSubtitles[index]?.id,
		)
	);
}

export function buildRepairMkvpropeditArgs(path: string, plan: RepairPlan, target: MkvIdentification): string[] {
	if (!isMetadataOnlyRepair(plan, target)) throw new Error("mkvpropedit can only be used when the subtitle set, order, and compression are unchanged");
	const args = ["mkvpropedit", path];
	for (const track of plan.tracks) {
		const allTrackIndex = (target.tracks || []).findIndex((candidate) => candidate.type === "subtitles" && candidate.id === track.trackId);
		if (allTrackIndex < 0) throw new Error(`target subtitle track ${track.trackId} no longer exists`);
		args.push(
			"--edit",
			`track:${allTrackIndex + 1}`,
			"--set",
			`name=${track.title}`,
			"--set",
			`language-ietf=${track.language}`,
			"--set",
			`flag-default=${track.isDefault ? 1 : 0}`,
			"--set",
			`flag-forced=${track.isForced ? 1 : 0}`,
			"--set",
			`flag-enabled=${track.isEnabled ? 1 : 0}`,
			"--set",
			`flag-hearing-impaired=${track.isHearingImpaired ? 1 : 0}`,
			"--set",
			`flag-original=${track.isOriginal ? 1 : 0}`,
			"--set",
			`flag-commentary=${track.isCommentary ? 1 : 0}`,
		);
	}
	return args;
}

function extractedExtension(track: MkvTrack): ".ass" | ".srt" {
	const codec = `${track.codec} ${track.properties.codec_id || ""}`.toLowerCase();
	return codec.includes("substation") || codec.includes("ass") || codec.includes("ssa") ? ".ass" : ".srt";
}

interface PreparedTrack {
	plan: RepairSubtitleTrackPlan;
	path: string;
	attachFontPath?: string;
	attachFontName?: string;
	attachFontMime?: string;
}

/**
 * A subtitle track pulled out of its MKV, before any styling. Fonts can only be
 * decided once every track's text is known, so extraction happens on its own.
 */
interface ExtractedTrack {
	plan: RepairSubtitleTrackPlan;
	/** The file to mux when nothing is styled (a passthrough SRT). */
	path: string;
	/** ASS text, when this track has one. */
	rawText?: string;
	/** Which transform this track will get. */
	kind: "srt-passthrough" | "converted-srt" | "ass";
	/** For `ass`: the track type is in the restyle targets. */
	restyle: boolean;
}

/** Extract one track, converting SRT→ASS when that setting is on. */
async function extractRabbitTrack(
	plan: RepairSubtitleTrackPlan,
	track: MkvTrack,
	inputPath: string,
	tempDir: string,
	settings: Job["settings"],
	signal?: AbortSignal,
): Promise<ExtractedTrack> {
	const extension = extractedExtension(track);
	const prefix = repairTrackKey(plan).replace(":", "_");
	const extracted = join(tempDir, `${prefix}.raw${extension}`);
	const extract = await run(["mkvextract", inputPath, "tracks", `${plan.trackId}:${extracted}`], { signal });
	if (signal?.aborted) throw new CancelledError();
	if (extract.code !== 0) throw new Error(`Could not extract ${plan.source} subtitle track ${plan.trackId}: ${(extract.stderr || extract.stdout).slice(-500)}`);

	if (extension === ".srt") {
		if (!settings.convertSrtToAss) return { plan, path: extracted, kind: "srt-passthrough", restyle: false };
		const assPath = join(tempDir, `${prefix}.converted.ass`);
		const convert = await run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", extracted, assPath], { signal });
		if (signal?.aborted) throw new CancelledError();
		if (convert.code !== 0) throw new Error(`Could not convert subtitle track ${plan.trackId} to ASS: ${(convert.stderr || convert.stdout).slice(-500)}`);
		return { plan, path: assPath, rawText: readFileSync(assPath, "utf-8"), kind: "converted-srt", restyle: true };
	}

	const type = detectSubtitleTrackType({
		index: plan.trackId,
		codec: track.codec,
		language: plan.language,
		title: plan.title,
		isDefault: plan.isDefault,
		isForced: plan.isForced,
		isHearingImpaired: plan.isHearingImpaired,
		isOriginal: plan.isOriginal,
	});
	return {
		plan,
		path: extracted,
		rawText: readFileSync(extracted, "utf-8"),
		kind: "ass",
		restyle: settings.restyleAssFont && settings.assRestyleTargets.includes(type),
	};
}

/** The transform this track will receive, applied with `fontName`. */
function styleExtractedText(extracted: ExtractedTrack, style: SubtitleStyle): string {
	const rawText = extracted.rawText ?? "";
	if (extracted.kind === "converted-srt") return styleSrtAss(rawText, style);
	if (extracted.kind === "ass" && extracted.restyle) return restyleAssDialogueFont(rawText, style, true);
	return rawText;
}

/** Apply the real transform with the final injected face and write the output. */
async function styleRabbitTrack(
	extracted: ExtractedTrack,
	tempDir: string,
	settings: Job["settings"],
	materializeFace: FaceMaterializer,
): Promise<PreparedTrack> {
	const { plan, rawText } = extracted;
	if (extracted.kind === "srt-passthrough" || rawText === undefined) return { plan, path: extracted.path };

	const { face: baseFace, appearance } = fontRegistry.resolveFaceAndStyle(settings.fontGroup, plan.language, rawText);
	// Pins variable axes (weight) and keeps the family clear of attachments that
	// survive the mux - without this the track asks for a family an earlier
	// encode already attached, and renders at the wrong weight.
	const face = await materializeFace(baseFace, appearance);
	const family = face?.family || settings.fontGroup;
	const styled = styleExtractedText(extracted, { ...appearance, fontName: family });

	const output = join(tempDir, `${repairTrackKey(plan).replace(":", "_")}.rabbit.ass`);
	writeFileSync(output, styled, "utf-8");
	const changed = styled !== rawText;
	return {
		plan,
		path: output,
		attachFontPath: changed ? face?.path : undefined,
		attachFontName: changed ? face?.fileName : undefined,
		attachFontMime: changed ? face?.mime : undefined,
	};
}

/**
 * Read the ASS text of every track copied verbatim. Their fonts must survive
 * the unused-font pass, so a track we cannot read makes the whole pass unsafe
 * and `complete` false — the caller then keeps all attachments.
 */
async function readCopiedAssText(
	plan: RepairPlan,
	target: MkvIdentification,
	sources: MkvIdentification[],
	tempDir: string,
	signal?: AbortSignal,
	prepared: PreparedTrack[] = [],
): Promise<{ texts: string[]; complete: boolean }> {
	const texts: string[] = [];
	let complete = true;
	const sourcePaths = repairSources(plan).map((s) => s.path);
	for (const trackPlan of plan.tracks) {
		if (trackPlan.mode !== "copy") continue;
		const identified = trackPlan.source === "target" ? target : sources[sourceIndexOf(trackPlan)];
		const inputPath = trackPlan.source === "target" ? plan.targetPath : sourcePaths[sourceIndexOf(trackPlan)];
		if (!identified || !inputPath) {
			complete = false;
			continue;
		}
		const track = (identified.tracks || []).find((candidate) => candidate.type === "subtitles" && candidate.id === trackPlan.trackId);
		if (!track) {
			complete = false;
			continue;
		}
		if (extractedExtension(track) !== ".ass") continue; // SRT and bitmap tracks use no fonts
		// A copied track rewritten for this repair uses the fonts its rewrite names.
		const rewritten = prepared.find((item) => repairTrackKey(item.plan) === repairTrackKey(trackPlan));
		if (rewritten && existsSync(rewritten.path)) {
			texts.push(readFileSync(rewritten.path, "utf-8"));
			continue;
		}

		const out = join(tempDir, `copied_${repairTrackKey(trackPlan).replace(":", "_")}.ass`);
		const extract = await run(["mkvextract", inputPath, "tracks", `${trackPlan.trackId}:${out}`], { signal });
		if (signal?.aborted) throw new CancelledError();
		if (extract.code !== 0 || !existsSync(out)) {
			complete = false;
			Logger.warn(`[repair] Could not read copied track ${repairTrackKey(trackPlan)}: ${(extract.stderr || extract.stdout).slice(-200)}`);
			continue;
		}
		texts.push(readFileSync(out, "utf-8"));
	}
	return { texts, complete };
}

/** Private stand-in for the injected family, so it never counts as a source font. */
const FONT_PROBE_FAMILY = "__RabbitEncoderRepairFontProbe_9C2E17__";

/**
 * Fonts still referenced once the repair is applied: what restyled tracks keep
 * (signs, songs, inline \fn overrides, non-targeted styles) plus everything
 * copied tracks use. The injected face is excluded via a probe family, so an
 * attachment is not retained merely because it shares our dialogue font's name
 * — that attachment is exactly the stale copy we want dropped.
 */
export function usedFontsAfterRepair(extracted: readonly ExtractedTrack[], copiedAssText: readonly string[]): Set<string> {
	const probe = normalizeFontName(FONT_PROBE_FAMILY);
	const used = new Set<string>();
	for (const track of extracted) {
		if (track.rawText === undefined) continue;
		const probeText = styleExtractedText(track, { ...DEFAULT_STYLE_APPEARANCE, fontName: FONT_PROBE_FAMILY });
		for (const font of extractUsedFonts(probeText)) if (font !== probe) used.add(font);
	}
	for (const text of copiedAssText) for (const font of extractUsedFonts(text)) used.add(font);
	return used;
}

/**
 * Rewrite every "auto" track to "zlib" or "none" from a decision per track key
 * (`source:trackId`). A track with no decision is left uncompressed, matching
 * what a failed probe means in an encode.
 */
export function applyAutoCompression(plan: RepairPlan, decisions: ReadonlyMap<string, boolean>): void {
	for (const track of plan.tracks) {
		if (track.compression !== "auto") continue;
		track.compression = decisions.get(repairTrackKey(track)) ? "zlib" : "none";
	}
}

/**
 * Decide "auto" tracks by trial-muxing each one, exactly as an encode does:
 * compress only when zlib saves at least `compressSubtitlesMinSavings` percent.
 * Matroska zlib works per block, so short dialogue tracks usually grow.
 *
 * Restyled tracks are probed as the file we will mux; copied tracks are pulled
 * into a single-track MKV first, so any codec (including PGS) can be measured.
 */
async function resolveAutoCompression(options: {
	plan: RepairPlan;
	target: MkvIdentification;
	sources: MkvIdentification[];
	prepared: PreparedTrack[];
	tempDir: string;
	minSavings: number;
	signal?: AbortSignal;
}): Promise<void> {
	const { plan, target, sources, prepared, tempDir, minSavings, signal } = options;
	const sourcePaths = repairSources(plan).map((s) => s.path);
	const pending = plan.tracks.filter((track) => track.compression === "auto");
	if (pending.length === 0) return;

	const decisions = new Map<string, boolean>();
	for (const track of pending) {
		const key = repairTrackKey(track);
		const preparedItem = prepared.find((item) => repairTrackKey(item.plan) === key);
		let probePath = preparedItem?.path;

		if (!probePath) {
			const inputPath = track.source === "target" ? plan.targetPath : sourcePaths[sourceIndexOf(track)];
			const identified = track.source === "target" ? target : sources[sourceIndexOf(track)];
			if (!inputPath || !identified) continue;
			const single = join(tempDir, `zprobe_src_${key.replace(":", "_")}.mkv`);
			const extract = await run(
				["mkvmerge", "-o", single, "--subtitle-tracks", String(track.trackId), "--no-video", "--no-audio", "--no-attachments", "--no-chapters", inputPath],
				{ signal },
			);
			if (signal?.aborted) throw new CancelledError();
			if (extract.code > 1 || !existsSync(single)) {
				Logger.warn(`[repair] Could not measure compression for ${key}; leaving it uncompressed`);
				continue;
			}
			probePath = single;
		}

		decisions.set(key, await zlibWorthIt(probePath, tempDir, minSavings, signal));
		if (signal?.aborted) throw new CancelledError();
	}
	applyAutoCompression(plan, decisions);
}

/** Build the mkvmerge command separately so selection/order behavior is unit-testable. */
export function buildRepairMkvmergeArgs(options: {
	outputPath: string;
	plan: RepairPlan;
	target: MkvIdentification;
	/** The plan's first source. */
	source?: MkvIdentification;
	/** Every source of the plan, in the order `repairSources` gives them, when there is more than one. */
	sources?: MkvIdentification[];
	prepared: PreparedTrack[];
	/**
	 * Attachments that survive the unused-font pass, already extracted. When
	 * given, every input is muxed with `--no-attachments` and only these are
	 * re-attached; omit it to pass input attachments through untouched.
	 */
	keptAttachments?: KeptAttachment[] | null;
	/** Timing per source for its tracks muxed straight from it, when it is another release. */
	sourceSyncs?: Array<{ delayMs: number; scale: number } | null>;
	/**
	 * The source fonts chosen for this repair, already extracted and renamed
	 * where they clashed. Sources then bring no attachments of their own.
	 */
	sourceFonts?: KeptAttachment[] | null;
}): string[] {
	const { outputPath, plan, target, prepared, keptAttachments, sourceSyncs = [], sourceFonts } = options;
	const sourceIds = options.sources ?? (options.source ? [options.source] : []);
	const sourcePaths = repairSources(plan).map((s) => s.path);
	const rewriteAttachments = !!keptAttachments;
	const preparedIndex = (track: RepairSubtitleTrackPlan) => prepared.findIndex((item) => repairTrackKey(item.plan) === repairTrackKey(track));
	// A copied track that had to be rewritten, such as one retimed to another release, is muxed from its prepared file.
	const isDirect = (track: RepairSubtitleTrackPlan) => track.mode === "copy" && preparedIndex(track) < 0;
	const directTarget = plan.tracks.filter((track) => track.source === "target" && isDirect(track));
	// Sources in use, each muxed as its own input after the target.
	const usedSources = [...new Set(plan.tracks.filter((track) => track.source === "source").map(sourceIndexOf))].sort((a, b) => a - b);
	const fileIndexOfSource = new Map(usedSources.map((index, i) => [index, i + 1]));
	const firstPreparedFileIndex = usedSources.length + 1;

	const targetNonSubs = (target.tracks || []).filter((track) => track.type !== "subtitles").map((track) => `0:${track.id}`);
	const plannedOrder = plan.tracks.map((track) => {
		if (isDirect(track)) return `${track.source === "target" ? 0 : fileIndexOfSource.get(sourceIndexOf(track))}:${track.trackId}`;
		const index = preparedIndex(track);
		if (index < 0) throw new Error(`Prepared subtitle ${repairTrackKey(track)} is missing`);
		return `${firstPreparedFileIndex + index}:0`;
	});

	const args = ["mkvmerge", "-o", outputPath, "--track-order", [...targetNonSubs, ...plannedOrder].join(",")];
	if (rewriteAttachments) args.push("--no-attachments");
	if (directTarget.length) {
		args.push("--subtitle-tracks", directTarget.map((track) => track.trackId).join(","));
		for (const track of directTarget) args.push(...trackOptions(track, track.trackId, findTrack(target, track)));
	} else {
		args.push("--no-subtitles");
	}
	args.push(plan.targetPath);

	// Passing through, a source brings only attachments no earlier input has under the same name.
	const availableAttachmentNames = new Set((target.attachments || []).map((attachment) => attachment.file_name.toLowerCase()));
	for (const index of usedSources) {
		const identified = sourceIds[index];
		if (!identified || !sourcePaths[index]) throw new Error(`Subtitle source ${index + 1} is missing`);
		args.push("--no-video", "--no-audio", "--no-chapters", "--no-global-tags");
		const all = identified.attachments || [];
		const fresh = rewriteAttachments || sourceFonts ? [] : all.filter((attachment) => !availableAttachmentNames.has(attachment.file_name.toLowerCase()));
		if (!fresh.length) args.push("--no-attachments");
		else if (fresh.length < all.length) args.push("--attachments", fresh.map((attachment) => attachment.id).join(","));
		for (const attachment of fresh) availableAttachmentNames.add(attachment.file_name.toLowerCase());
		const direct = plan.tracks.filter((track) => track.source === "source" && sourceIndexOf(track) === index && isDirect(track));
		if (direct.length) {
			args.push("--subtitle-tracks", direct.map((track) => track.trackId).join(","));
			const sync = sourceSyncs[index];
			for (const track of direct) {
				args.push(...trackOptions(track, track.trackId, findTrack(identified, track)));
				if (sync) args.push("--sync", `${track.trackId}:${sync.delayMs},${sync.scale}`);
			}
		} else {
			args.push("--no-subtitles");
		}
		args.push(sourcePaths[index]!);
	}

	for (const item of prepared) {
		const originalIdentification = item.plan.source === "target" ? target : sourceIds[sourceIndexOf(item.plan)]!;
		args.push(...trackOptions(item.plan, 0, findTrack(originalIdentification, item.plan)), item.path);
	}

	const attached = new Set<string>();
	if (sourceFonts && !rewriteAttachments) {
		args.push(...keptAttachmentArgs(sourceFonts));
		for (const font of sourceFonts) availableAttachmentNames.add(font.fileName.toLowerCase());
	}
	if (rewriteAttachments) {
		// Only the attachments that survived are re-attached, so a stale font is
		// gone and its family name is free for the face we inject below.
		args.push(...keptAttachmentArgs(keptAttachments!));
		availableAttachmentNames.clear();
		for (const attachment of keptAttachments!) availableAttachmentNames.add(attachment.fileName.toLowerCase());
	}
	for (const item of prepared) {
		if (!item.attachFontPath || attached.has(item.attachFontPath)) continue;
		if (item.attachFontName && availableAttachmentNames.has(item.attachFontName.toLowerCase())) continue;
		attached.add(item.attachFontPath);
		args.push(
			"--attachment-mime-type",
			item.attachFontMime || "font/ttf",
			"--attachment-name",
			item.attachFontName || basename(item.attachFontPath),
			"--attach-file",
			item.attachFontPath,
		);
	}
	return args;
}

function makeSteps(align: boolean): JobStep[] {
	return [
		{ label: "Inspect files", status: "pending", progress: 0 },
		...(align ? [{ label: "Align timing", status: "pending" as const, progress: 0 }] : []),
		{ label: "Prepare subtitles", status: "pending", progress: 0 },
		{ label: "Stream-copy remux", status: "pending", progress: 0 },
	];
}

export async function runRepairJob(job: Job, config: AppConfig, updateJob: (partial: Partial<Job>) => void, signal?: AbortSignal): Promise<void> {
	if (!job.repairPlan) throw new Error("Repair job has no plan");
	let plan = sanitizeRepairPlan(job.repairPlan);
	const tempDir = join(config.tempDir, job.id);
	mkdirSync(tempDir, { recursive: true });
	const stagePath = join(dirname(plan.targetPath), `.rabbit-repair-${job.id}.mkv`);
	const aligning = repairSources(plan).some((source) => source.alignSource);
	const steps = makeSteps(aligning);
	const S_ALIGN = 1;
	const S_PREPARE = aligning ? 2 : 1;
	const S_MUX = S_PREPARE + 1;

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
		if (!existsSync(plan.targetPath)) throw new Error("Encoded target file no longer exists");
		if (extname(plan.targetPath).toLowerCase() !== ".mkv") throw new Error("Subtitle repair currently supports MKV targets only");
		for (const source of repairSources(plan)) if (!existsSync(source.path)) throw new Error(`Subtitle source ${basename(source.path)} no longer exists`);
		if (existsSync(stagePath)) throw new Error(`Repair staging file already exists: ${stagePath}`);

		setStep(0, { status: "active", progress: 10 });
		updateJob({ status: "probing" });

		// Batch replacement queues jobs without a track list: building one means
		// analysing the source, which belongs in the job, not in the request that
		// queued dozens of them.
		if (plan.replaceFromSource) {
			setStep(0, { progress: 25, detail: "Analysing source subtitles" });
			const planDir = join(tempDir, "plan");
			mkdirSync(planDir, { recursive: true });
			const alignSource = plan.alignSource;
			plan = await buildSourceReplacementPlan({
				targetPath: plan.targetPath,
				sourcePath: plan.sourcePath!,
				settings: job.settings,
				tempDir: planDir,
				replaceTarget: plan.replaceTarget,
				signal,
			});
			if (alignSource) plan.alignSource = true;
			checkCancelled();
			updateJob({ repairPlan: plan });
		}

		const sources = repairSources(plan);
		const [targetId, probe, ...sourceIds] = await Promise.all([
			identifyMatroska(plan.targetPath, signal),
			probeFile(plan.targetPath),
			...sources.map((source) => identifyMatroska(source.path, signal)),
		]);
		checkCancelled();
		const usesSource = (index: number) => plan.tracks.some((track) => sourceIndexOf(track) === index);
		// Another release may be longer or shorter, so its audio decides instead.
		sources.forEach((source, index) => {
			if (source.alignSource || !usesSource(index) || durationsAreCompatible(targetId, sourceIds[index]!)) return;
			throw new Error(
				`Source and target durations differ (${durationSeconds(sourceIds[index]!).toFixed(1)}s vs ${durationSeconds(targetId).toFixed(1)}s). Refusing to combine unrelated files.`,
			);
		});
		const identifiedFor = (track: RepairSubtitleTrackPlan) => (track.source === "target" ? targetId : sourceIds[sourceIndexOf(track)]!);
		const inputFor = (track: RepairSubtitleTrackPlan) => (track.source === "target" ? plan.targetPath : sources[sourceIndexOf(track)]!.path);
		for (const trackPlan of plan.tracks) findTrack(identifiedFor(trackPlan), trackPlan);
		updateJob({ probe });
		setStep(0, { status: "done", progress: 100, detail: `${plan.tracks.length} subtitle track(s) selected` });

		const warnings: string[] = [];
		const dropTrack = (trackPlan: RepairSubtitleTrackPlan, reason: string) => {
			plan = { ...plan, tracks: plan.tracks.filter((track) => track !== trackPlan) };
			const from = sources.length > 1 ? `${basename(inputFor(trackPlan))} track` : "source track";
			warnings.push(`Left out ${from} ${trackPlan.trackId} (${trackPlan.language}): ${reason}`);
			Logger.warn(`[repair] ${warnings[warnings.length - 1]}`);
		};
		const timings: Array<SourceTiming | null> = sources.map(() => null);
		if (aligning) {
			setStep(S_ALIGN, { status: "active", progress: 10, detail: "Comparing the audio of the releases" });
			const details: string[] = [];
			const hadSourceTracks = plan.tracks.some((track) => track.source === "source");
			const problems: string[] = [];
			for (const [index, source] of sources.entries()) {
				if (!source.alignSource || !usesSource(index)) continue;
				const label = sources.length > 1 ? `${basename(source.path)}: ` : "";
				const alignment = await alignReleaseFiles(plan.targetPath, source.path, { cacheDir: config.tempDir, targetProbe: probe, signal });
				checkCancelled();
				const problem = alignmentProblem(alignment);
				if (problem) {
					problems.push(problem);
					for (const trackPlan of plan.tracks.filter((track) => sourceIndexOf(track) === index)) dropTrack(trackPlan, problem);
					details.push(`${label}does not match`);
					continue;
				}
				const timing = sourceTimingFor(alignment, durationSeconds(targetId) * 1000, probe);
				timings[index] = timing;
				const described = describeTiming(alignment.map, alignment.removed);
				Logger.info(
					`[repair] Timing of ${basename(source.path)} against ${basename(plan.targetPath)}: ${described}, ${Math.round(alignment.coveredShare * 100)}% matched`,
				);
				// Picture tracks are copied as they are, which can shift and scale them but not follow cuts.
				if (timing && !mkvmergeSync(timing.map)) {
					for (const trackPlan of plan.tracks.filter((track) => sourceIndexOf(track) === index && !isRabbitProcessable(findTrack(sourceIds[index]!, track))))
						dropTrack(trackPlan, "picture subtitles cannot follow the scenes cut between the releases");
				}
				details.push(`${label}${timing ? `retiming by ${described}` : "already lines up"}`);
			}
			// One release that does not belong is left out, but a job with nothing left to take fails.
			if (hadSourceTracks && problems.length && !plan.tracks.some((track) => track.source === "source")) throw new Error(problems.join(". "));
			const detail = details.join(", ") || "No source tracks to retime";
			setStep(S_ALIGN, { status: "done", progress: 100, detail: detail.charAt(0).toUpperCase() + detail.slice(1) });
		}

		const durationMs = durationSeconds(targetId) * 1000;
		let reference: Promise<ReferenceTimeline | null> | undefined;
		const targetReference = () => {
			if (!reference) {
				const dir = join(tempDir, "reference");
				mkdirSync(dir, { recursive: true });
				reference = buildReference(plan.targetPath, probe, dir, signal);
			}
			return reference;
		};
		/** The retimed text, or null when it does not fit the encode after all. */
		const retimeChecked = async (text: string, format: "ass" | "srt", trackPlan: RepairSubtitleTrackPlan, timing: SourceTiming): Promise<string | null> => {
			const retimed = retimeSubtitleText(text, format, timing);
			const fits = await retimingFits(text, retimed, format, targetReference, durationMs);
			checkCancelled();
			if (retimingFailed(fits)) {
				dropTrack(trackPlan, `retiming made it fit the encode worse (${Math.round(fits!.before * 100)}% before, ${Math.round(fits!.after * 100)}% after)`);
				return null;
			}
			return retimed;
		};

		setStep(S_PREPARE, { status: "active", progress: 0 });
		const rabbitPlans = plan.tracks.filter((track) => track.mode === "rabbit");
		const prepared: PreparedTrack[] = [];
		let keptAttachments: KeptAttachment[] | null = null;

		// Pass 1 - extract every track we restyle. Fonts can only be decided once
		// all of the text is known.
		const extracted: ExtractedTrack[] = [];
		for (let i = 0; i < rabbitPlans.length; i++) {
			checkCancelled();
			const trackPlan = rabbitPlans[i]!;
			setStep(S_PREPARE, {
				progress: Math.round((i / Math.max(1, rabbitPlans.length)) * 50),
				detail: `Extracting ${trackPlan.source} track ${trackPlan.trackId}`,
			});
			extracted.push(await extractRabbitTrack(trackPlan, findTrack(identifiedFor(trackPlan), trackPlan), inputFor(trackPlan), tempDir, job.settings, signal));
		}

		// Tracks from another release move to the encode's timing before anything else reads them.
		const timingOf = (track: RepairSubtitleTrackPlan) => (track.source === "source" ? timings[sourceIndexOf(track)] : null);
		if (timings.some(Boolean)) {
			setStep(S_PREPARE, { progress: 50, detail: "Retiming source subtitles" });
			for (const item of [...extracted]) {
				const timing = timingOf(item.plan);
				if (!timing) continue;
				const text = item.rawText ?? readFileSync(item.path, "utf-8");
				const retimed = await retimeChecked(text, item.rawText !== undefined ? "ass" : "srt", item.plan, timing);
				if (retimed === null) {
					extracted.splice(extracted.indexOf(item), 1);
					continue;
				}
				if (item.rawText !== undefined) item.rawText = retimed;
				else {
					item.path = join(tempDir, `${repairTrackKey(item.plan).replace(":", "_")}.retimed.srt`);
					writeFileSync(item.path, retimed, "utf-8");
				}
			}
			for (const trackPlan of plan.tracks.filter((track) => track.mode === "copy" && timingOf(track))) {
				checkCancelled();
				const track = findTrack(identifiedFor(trackPlan), trackPlan);
				if (!isRabbitProcessable(track)) continue;
				const extension = extractedExtension(track);
				const name = repairTrackKey(trackPlan).replace(":", "_");
				const raw = join(tempDir, `${name}.copy${extension}`);
				const extract = await run(["mkvextract", inputFor(trackPlan), "tracks", `${trackPlan.trackId}:${raw}`], { signal });
				checkCancelled();
				if (extract.code !== 0)
					throw new Error(`Could not extract source subtitle track ${trackPlan.trackId}: ${(extract.stderr || extract.stdout).slice(-500)}`);
				const retimed = await retimeChecked(readFileSync(raw, "utf-8"), extension === ".ass" ? "ass" : "srt", trackPlan, timingOf(trackPlan)!);
				if (retimed === null) continue;
				const out = join(tempDir, `${name}.retimed${extension}`);
				writeFileSync(out, retimed, "utf-8");
				prepared.push({ plan: trackPlan, path: out });
			}
		}
		// Fonts of the sources are compared with the target's, and earlier sources', by content and name.
		let sourceFonts: KeptAttachment[] | null = null;
		if (plan.tracks.some((track) => track.source === "source")) {
			setStep(S_PREPARE, { progress: 52, detail: "Comparing the fonts of the files" });
			const fontDir = join(tempDir, "fonts");
			const targetFonts = await readInputFonts(plan.targetPath, -1, fontDir, signal);
			const candidates: InputFont[] = [];
			for (const [index, source] of sources.entries()) if (usesSource(index)) candidates.push(...(await readInputFonts(source.path, index, fontDir, signal)));
			checkCancelled();
			const fontPlan = planSourceFonts(targetFonts, candidates);
			sourceFonts = fontPlan.keep.map((font) => fontAttachment(font.path, font.fileName, font.names));
			const assRenames = new Map<number, Map<string, AssFontRename>>();
			for (const rename of fontPlan.renames) {
				const out = join(fontDir, `renamed_${rename.font.input}_${rename.font.id}${extname(rename.font.path)}`);
				if (!(await renameFontFamily(rename.font.path, out, rename.font.family, rename.family, signal))) {
					sourceFonts.push(fontAttachment(rename.font.path, rename.fileName, rename.font.names));
					warnings.push(`${rename.font.fileName} could not be renamed, so another font of the same name may show in its place`);
					continue;
				}
				sourceFonts.push(fontAttachment(out, rename.fileName, renamedNames(rename.font, rename.family)));
				const byFamily = assRenames.get(rename.font.input) ?? new Map<string, AssFontRename>();
				const entry = byFamily.get(rename.family) ?? { names: new Set<string>(), from: rename.font.family, to: rename.family };
				for (const name of rename.font.names) entry.names.add(name);
				byFamily.set(rename.family, entry);
				assRenames.set(rename.font.input, byFamily);
			}
			checkCancelled();
			Logger.info(
				`[repair] Source fonts: ${fontPlan.keep.length} added, ${fontPlan.duplicates.length} already in the file, ${fontPlan.renames.length} renamed${fontPlan.renames.length ? ` (${[...new Set(fontPlan.renames.map((r) => r.family))].join(", ")})` : ""}`,
			);
			// Tracks of a source whose fonts were renamed point at the new names.
			const renamesOf = (track: RepairSubtitleTrackPlan) => [...(assRenames.get(sourceIndexOf(track))?.values() ?? [])];
			for (const item of extracted) {
				const renames = renamesOf(item.plan);
				if (renames.length && item.kind === "ass" && item.rawText !== undefined) item.rawText = renameAssFonts(item.rawText, renames);
			}
			for (const trackPlan of plan.tracks.filter((track) => track.mode === "copy" && renamesOf(track).length)) {
				const track = findTrack(identifiedFor(trackPlan), trackPlan);
				if (!isRabbitProcessable(track) || extractedExtension(track) !== ".ass") continue;
				let item = prepared.find((p) => repairTrackKey(p.plan) === repairTrackKey(trackPlan));
				if (!item) {
					const out = join(tempDir, `${repairTrackKey(trackPlan).replace(":", "_")}.fonts.ass`);
					const extract = await run(["mkvextract", inputFor(trackPlan), "tracks", `${trackPlan.trackId}:${out}`], { signal });
					checkCancelled();
					if (extract.code !== 0)
						throw new Error(`Could not extract source subtitle track ${trackPlan.trackId}: ${(extract.stderr || extract.stdout).slice(-500)}`);
					prepared.push((item = { plan: trackPlan, path: out }));
				}
				writeFileSync(item.path, renameAssFonts(readFileSync(item.path, "utf-8"), renamesOf(trackPlan)), "utf-8");
			}
		}
		if (warnings.length) updateJob({ repairPlan: plan, warning: warnings.join(". ") });

		// Pass 2 - work out which attachments survive. A font still referenced by
		// a copied or partly-restyled track is kept and keeps its family name; the
		// rest are dropped, which frees their names for the faces we inject.
		const occupiedFontNames = new Set<string>();
		if (rabbitPlans.length > 0) {
			setStep(S_PREPARE, { progress: 55, detail: "Checking which fonts are still used" });
			const copied = await readCopiedAssText(plan, targetId, sourceIds, tempDir, signal, prepared);
			checkCancelled();
			const dropUnusedFonts = job.settings.removeUnusedFonts && copied.complete;
			if (job.settings.removeUnusedFonts && !copied.complete) {
				Logger.warn("[repair] Could not read every copied subtitle track; keeping all attachments for safety.");
			}
			const usedFonts = usedFontsAfterRepair(extracted, copied.texts);

			// Source fonts were chosen above, so only the target's attachments are read here.
			const inputs = [{ path: plan.targetPath, prefix: "att_target" }];

			const collected: KeptAttachment[] = [];
			let complete = true;
			for (const input of inputs) {
				const kept = await collectKeptAttachments(input.path, usedFonts, tempDir, dropUnusedFonts, signal, input.prefix);
				checkCancelled();
				if (!kept) {
					// Without the real inventory we cannot safely drop anything, so fall
					// back to passing attachments through and reserve names best-effort.
					complete = false;
					const names = await scanMkvAttachmentFontNames(input.path, tempDir, new Set(), false, signal);
					checkCancelled();
					if (names) for (const name of names) occupiedFontNames.add(name);
					Logger.warn(`[repair] Could not read attachments of ${basename(input.path)}; keeping all of them.`);
					continue;
				}
				for (const attachment of kept) {
					if (collected.some((existing) => existing.fileName.toLowerCase() === attachment.fileName.toLowerCase())) continue;
					collected.push(attachment);
					// A face Rabbit attached in an earlier pass is reused, so its names stay free.
					if (attachment.isFont && isRabbitGroupFace(attachment.fileName, attachment.family ?? "", job.settings.fontGroup)) continue;
					for (const name of attachment.names) occupiedFontNames.add(name);
				}
			}
			for (const font of sourceFonts ?? []) {
				for (const name of font.names) occupiedFontNames.add(name);
				if (!dropUnusedFonts || font.names.some((name) => usedFonts.has(name))) collected.push(font);
			}
			// Rewriting the attachment set is only safe with a complete inventory;
			// otherwise the collected names still serve as collision reservations.
			if (complete && dropUnusedFonts) {
				keptAttachments = collected;
				Logger.info(`[repair] Keeping ${collected.filter((item) => item.isFont).length} used font attachment(s); dropping the rest`);
			}
		}

		// Pass 3 - restyle with the final face, now that its family is known to be free.
		const materializeFace = createFaceMaterializer({ tempDir, occupiedNames: occupiedFontNames, signal });
		for (let i = 0; i < extracted.length; i++) {
			checkCancelled();
			const item = extracted[i]!;
			setStep(S_PREPARE, {
				progress: 60 + Math.round((i / Math.max(1, extracted.length)) * 40),
				detail: `Styling ${item.plan.source} track ${item.plan.trackId}`,
			});
			prepared.push(await styleRabbitTrack(item, tempDir, job.settings, materializeFace));
		}
		setStep(S_PREPARE, {
			status: "done",
			progress: 100,
			detail: rabbitPlans.length
				? `${rabbitPlans.length} track(s) processed`
				: timings.some(Boolean)
					? "Source subtitles retimed"
					: "No subtitle conversion needed",
		});

		await resolveAutoCompression({
			plan,
			target: targetId,
			sources: sourceIds,
			prepared,
			tempDir,
			minSavings: job.settings.compressSubtitlesMinSavings ?? 10,
			signal,
		});
		checkCancelled();

		const metadataOnly = isMetadataOnlyRepair(plan, targetId);
		setStep(S_MUX, { status: "active", progress: 10, detail: metadataOnly ? "Creating safe metadata-edit copy" : "Copying streams without video encoding" });
		updateJob({ status: "muxing" });
		if (metadataOnly) {
			Logger.info(`[repair] Applying metadata-only repair to ${basename(plan.targetPath)} with mkvpropedit`);
			let copied = await run(["cp", "--reflink=auto", "--sparse=always", plan.targetPath, stagePath], { signal });
			if (copied.code !== 0) copied = await run(["cp", plan.targetPath, stagePath], { signal });
			checkCancelled();
			if (copied.code !== 0) throw new Error(`Could not stage metadata repair: ${(copied.stderr || copied.stdout).slice(-500)}`);
			const edited = await run(buildRepairMkvpropeditArgs(stagePath, plan, targetId), { signal });
			checkCancelled();
			if (edited.code !== 0) throw new Error(`mkvpropedit repair failed (exit ${edited.code}): ${(edited.stderr || edited.stdout).slice(-800)}`);
		} else {
			const args = buildRepairMkvmergeArgs({
				outputPath: stagePath,
				plan,
				target: targetId,
				sources: sourceIds,
				prepared,
				keptAttachments,
				sourceFonts,
				sourceSyncs: timings.map((timing) => (timing ? mkvmergeSync(timing.map) : null)),
			});
			Logger.info(`[repair] Remuxing ${basename(plan.targetPath)} with ${plan.tracks.length} subtitle track(s)`);
			const merged = await run(args, { signal });
			checkCancelled();
			if (merged.code !== 0 && merged.code !== 1)
				throw new Error(`mkvmerge repair failed (exit ${merged.code}): ${(merged.stderr || merged.stdout).slice(-800)}`);
			if (merged.code === 1) Logger.warn(`[repair] mkvmerge completed with warnings: ${(merged.stderr || merged.stdout).slice(-500)}`);
		}

		setStep(S_MUX, { progress: 80, detail: "Verifying repaired MKV" });
		const verified = await identifyMatroska(stagePath, signal);
		checkCancelled();
		const targetVideo = (targetId.tracks || []).filter((track) => track.type === "video").map((track) => track.properties.codec_id || track.codec);
		const outputVideo = (verified.tracks || []).filter((track) => track.type === "video").map((track) => track.properties.codec_id || track.codec);
		const targetAudio = (targetId.tracks || []).filter((track) => track.type === "audio").map((track) => track.properties.codec_id || track.codec);
		const outputAudio = (verified.tracks || []).filter((track) => track.type === "audio").map((track) => track.properties.codec_id || track.codec);
		const outputSubs = (verified.tracks || []).filter((track) => track.type === "subtitles");
		if (JSON.stringify(targetVideo) !== JSON.stringify(outputVideo)) throw new Error("Verification failed: target video tracks changed during repair");
		if (JSON.stringify(targetAudio) !== JSON.stringify(outputAudio)) throw new Error("Verification failed: target audio tracks changed during repair");
		if (outputSubs.length !== plan.tracks.length)
			throw new Error(`Verification failed: expected ${plan.tracks.length} subtitle tracks, found ${outputSubs.length}`);
		assertSubtitlePlanApplied(plan, outputSubs, targetId, sourceIds);
		if (!durationsAreCompatible(targetId, verified)) throw new Error("Verification failed: repaired duration differs from the encoded target");

		const parsed = parsePath(plan.targetPath);
		const finalPath = plan.replaceTarget ? plan.targetPath : resolveUniqueOutputPath(parsed.dir, `${parsed.name}.repaired.mkv`);
		renameSync(stagePath, finalPath);
		setStep(S_MUX, { status: "done", progress: 100, detail: plan.replaceTarget ? "Target replaced after verification" : "Repaired copy created" });
		updateJob({
			status: "done",
			currentStage: "Complete",
			progress: 100,
			outputFilename: finalPath,
			encodedFileSize: humanSize(statSync(finalPath).size),
			finishedAt: Date.now(),
		});
		Logger.info(`[repair] Complete: ${finalPath}`);
	} catch (error: any) {
		const active = steps.find((step) => step.status === "active");
		if (active) active.status = "error";
		if (error instanceof CancelledError) {
			updateJob({ status: "cancelled", currentStage: "Cancelled", steps: [...steps] });
			throw error;
		}
		Logger.error(`[repair] ${error?.message || error}`);
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
