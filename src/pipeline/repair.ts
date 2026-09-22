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
	RepairFolderAudit,
	RepairPlan,
	RepairSubtitleTrack,
	RepairSubtitleTrackPlan,
	SubtitleStyle,
} from "../core/types";
import { Logger } from "../core/logger";
import { CancelledError, humanSize, run } from "../core/process";
import { collectKeptAttachments, fontRegistry, keptAttachmentArgs, scanMkvAttachmentFontNames, type KeptAttachment } from "../fonts/fonts";
import { createFaceMaterializer, type FaceMaterializer } from "../fonts/inject";
import { extractUsedFonts, normalizeFontName } from "../subtitles/ass-classifier";
import { styleSrtAss, restyleAssDialogueFont } from "../subtitles/ass-style";
import { DEFAULT_STYLE_APPEARANCE } from "../subtitles/subtitle-style";
import { detectSubtitleTrackType, normalizeLanguageGroup, sanitizeLanguageTag } from "../tracks/tracks";
import { resolveUniqueOutputPath } from "./output";
import { probeFile } from "./probe";

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
}

interface MkvTrack {
	id: number;
	type: string;
	codec: string;
	properties: MkvTrackProperties;
}

interface MkvIdentification {
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

function auditDifferences(file: Pick<RepairAuditFile, "tracks">, majority: Pick<RepairAuditFile, "tracks">): string[] {
	const differences: string[] = [];
	for (const type of ["audio", "subtitles"] as const) {
		const actualTracks = file.tracks.filter((track) => track.type === type);
		const expectedTracks = majority.tracks.filter((track) => track.type === type);
		const max = Math.max(actualTracks.length, expectedTracks.length);
		for (let index = 0; index < max; index++) {
			const actual = actualTracks[index];
			const expected = expectedTracks[index];
			const label = `${type === "audio" ? "Audio" : "Subtitle"} ${index + 1}`;
			if (!actual && expected) {
				differences.push(`Missing ${label}: ${shortTrack(expected)}`);
				continue;
			}
			if (actual && !expected) {
				differences.push(`Extra ${label}: ${shortTrack(actual)}`);
				continue;
			}
			if (!actual || !expected) continue;
			if (actual.language !== expected.language) differences.push(`${label} language is ${actual.language}. Group A uses ${expected.language}.`);
			if (actual.title !== expected.title)
				differences.push(`${label} title is “${actual.title || "untitled"}”. Group A uses “${expected.title || "untitled"}”.`);
			if (JSON.stringify(auditFlags(actual)) !== JSON.stringify(auditFlags(expected))) {
				differences.push(`${label} flags are ${auditFlagNames(actual)}. Group A uses ${auditFlagNames(expected)}.`);
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
	return { path, files, groups };
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

function durationSeconds(identified: MkvIdentification): number {
	return (identified.container?.properties?.duration || 0) / 1_000_000_000;
}

function durationsAreCompatible(a: MkvIdentification, b: MkvIdentification): boolean {
	const aSeconds = durationSeconds(a);
	const bSeconds = durationSeconds(b);
	if (aSeconds <= 0 || bSeconds <= 0) return true;
	return Math.abs(aSeconds - bSeconds) <= Math.max(2, aSeconds * 0.01);
}

/** Normalize untrusted API/persisted repair input before it reaches mkvmerge. */
export function sanitizeRepairPlan(raw: RepairPlan): RepairPlan {
	if (!raw || typeof raw !== "object") throw new Error("Invalid repair plan");
	const targetPath = checkedText(raw.targetPath, 4096);
	const sourcePath = checkedText(raw.sourcePath, 4096) || undefined;
	if (!targetPath) throw new Error("An encoded target path is required");
	if (!Array.isArray(raw.tracks)) throw new Error("Subtitle track plan is required");
	if (raw.tracks.length > MAX_REPAIR_TRACKS) throw new Error(`A repair job may contain at most ${MAX_REPAIR_TRACKS} subtitle tracks`);

	const seen = new Set<string>();
	const tracks = raw.tracks.map((item, index): RepairSubtitleTrackPlan => {
		const source = item?.source === "source" ? "source" : item?.source === "target" ? "target" : null;
		const trackId = Number(item?.trackId);
		if (!source || !Number.isInteger(trackId) || trackId < 0) throw new Error(`Invalid subtitle track at position ${index + 1}`);
		if (source === "source" && !sourcePath) throw new Error("A source path is required for imported subtitle tracks");
		const key = `${source}:${trackId}`;
		if (seen.has(key)) throw new Error(`Subtitle track ${key} was selected more than once`);
		seen.add(key);
		const mode = item.mode === "rabbit" ? "rabbit" : "copy";
		const compression = item.compression === "zlib" ? "zlib" : item.compression === "none" ? "none" : "preserve";
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
		};
	});
	tracks.sort((a, b) => a.order - b.order);
	tracks.forEach((track, index) => (track.order = index));
	return { targetPath, sourcePath, replaceTarget: !!raw.replaceTarget, tracks };
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
	const compression = plan.compression === "preserve" ? (trackUsesZlib(original) ? "zlib" : "none") : plan.compression;
	args.push("--compression", `${trackId}:${compression}`);
	return args;
}

function languageMatches(planLanguage: string, properties: MkvTrackProperties): boolean {
	const ietf = properties.language_ietf || "";
	if (planLanguage.includes("-")) return ietf.toLowerCase() === planLanguage.toLowerCase();
	return normalizeLanguageGroup(ietf || properties.language || "und") === normalizeLanguageGroup(planLanguage);
}

function assertSubtitlePlanApplied(plan: RepairPlan, outputTracks: MkvTrack[], target: MkvIdentification, source?: MkvIdentification): void {
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
		const original = findTrack(expected.source === "target" ? target : source!, expected);
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
	const prefix = `${plan.source}_${plan.trackId}`;
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

	const output = join(tempDir, `${plan.source}_${plan.trackId}.rabbit.ass`);
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
	source: MkvIdentification | undefined,
	tempDir: string,
	signal?: AbortSignal,
): Promise<{ texts: string[]; complete: boolean }> {
	const texts: string[] = [];
	let complete = true;
	for (const trackPlan of plan.tracks) {
		if (trackPlan.mode !== "copy") continue;
		const identified = trackPlan.source === "target" ? target : source;
		const inputPath = trackPlan.source === "target" ? plan.targetPath : plan.sourcePath;
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

		const out = join(tempDir, `copied_${trackPlan.source}_${trackPlan.trackId}.ass`);
		const extract = await run(["mkvextract", inputPath, "tracks", `${trackPlan.trackId}:${out}`], { signal });
		if (signal?.aborted) throw new CancelledError();
		if (extract.code !== 0 || !existsSync(out)) {
			complete = false;
			Logger.warn(`[repair] Could not read copied ${trackPlan.source} track ${trackPlan.trackId}: ${(extract.stderr || extract.stdout).slice(-200)}`);
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

/** Build the mkvmerge command separately so selection/order behavior is unit-testable. */
export function buildRepairMkvmergeArgs(options: {
	outputPath: string;
	plan: RepairPlan;
	target: MkvIdentification;
	source?: MkvIdentification;
	prepared: PreparedTrack[];
	/**
	 * Attachments that survive the unused-font pass, already extracted. When
	 * given, both inputs are muxed with `--no-attachments` and only these are
	 * re-attached; omit it to pass every input attachment through untouched.
	 */
	keptAttachments?: KeptAttachment[] | null;
}): string[] {
	const { outputPath, plan, target, source, prepared, keptAttachments } = options;
	const rewriteAttachments = !!keptAttachments;
	const directTarget = plan.tracks.filter((track) => track.source === "target" && track.mode === "copy");
	const directSource = plan.tracks.filter((track) => track.source === "source" && track.mode === "copy");
	const needsSourceInput = plan.tracks.some((track) => track.source === "source");
	const targetAttachmentNames = new Set((target.attachments || []).map((attachment) => attachment.file_name.toLowerCase()));
	const sourceAddsAttachments =
		needsSourceInput && (source?.attachments || []).some((attachment) => !targetAttachmentNames.has(attachment.file_name.toLowerCase()));
	const sourceFileIndex = needsSourceInput ? 1 : -1;
	const firstPreparedFileIndex = needsSourceInput ? 2 : 1;

	const targetNonSubs = (target.tracks || []).filter((track) => track.type !== "subtitles").map((track) => `0:${track.id}`);
	const plannedOrder = plan.tracks.map((track) => {
		if (track.mode === "copy") return `${track.source === "target" ? 0 : sourceFileIndex}:${track.trackId}`;
		const preparedIndex = prepared.findIndex((item) => item.plan.source === track.source && item.plan.trackId === track.trackId);
		if (preparedIndex < 0) throw new Error(`Prepared subtitle ${track.source}:${track.trackId} is missing`);
		return `${firstPreparedFileIndex + preparedIndex}:0`;
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

	if (needsSourceInput) {
		args.push("--no-video", "--no-audio", "--no-chapters", "--no-global-tags");
		if (rewriteAttachments || !sourceAddsAttachments) args.push("--no-attachments");
		if (directSource.length) {
			args.push("--subtitle-tracks", directSource.map((track) => track.trackId).join(","));
			for (const track of directSource) args.push(...trackOptions(track, track.trackId, findTrack(source!, track)));
		} else {
			args.push("--no-subtitles");
		}
		args.push(plan.sourcePath!);
	}

	for (const item of prepared) {
		const originalIdentification = item.plan.source === "target" ? target : source!;
		args.push(...trackOptions(item.plan, 0, findTrack(originalIdentification, item.plan)), item.path);
	}

	const attached = new Set<string>();
	const availableAttachmentNames = new Set<string>();
	if (rewriteAttachments) {
		// Only the attachments that survived are re-attached, so a stale font is
		// gone and its family name is free for the face we inject below.
		args.push(...keptAttachmentArgs(keptAttachments!));
		for (const attachment of keptAttachments!) availableAttachmentNames.add(attachment.fileName.toLowerCase());
	} else {
		for (const name of targetAttachmentNames) availableAttachmentNames.add(name);
		if (sourceAddsAttachments) for (const attachment of source?.attachments || []) availableAttachmentNames.add(attachment.file_name.toLowerCase());
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

function makeSteps(): JobStep[] {
	return [
		{ label: "Inspect files", status: "pending", progress: 0 },
		{ label: "Prepare subtitles", status: "pending", progress: 0 },
		{ label: "Stream-copy remux", status: "pending", progress: 0 },
	];
}

export async function runRepairJob(job: Job, config: AppConfig, updateJob: (partial: Partial<Job>) => void, signal?: AbortSignal): Promise<void> {
	if (!job.repairPlan) throw new Error("Repair job has no plan");
	const plan = sanitizeRepairPlan(job.repairPlan);
	const tempDir = join(config.tempDir, job.id);
	mkdirSync(tempDir, { recursive: true });
	const stagePath = join(dirname(plan.targetPath), `.rabbit-repair-${job.id}.mkv`);
	const steps = makeSteps();

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
		if (plan.sourcePath && !existsSync(plan.sourcePath)) throw new Error("Subtitle source file no longer exists");
		if (existsSync(stagePath)) throw new Error(`Repair staging file already exists: ${stagePath}`);

		setStep(0, { status: "active", progress: 10 });
		updateJob({ status: "probing" });
		const [targetId, sourceId, probe] = await Promise.all([
			identifyMatroska(plan.targetPath, signal),
			plan.sourcePath ? identifyMatroska(plan.sourcePath, signal) : Promise.resolve(undefined),
			probeFile(plan.targetPath),
		]);
		checkCancelled();
		if (sourceId && plan.tracks.some((track) => track.source === "source") && !durationsAreCompatible(targetId, sourceId)) {
			throw new Error(
				`Source and target durations differ (${durationSeconds(sourceId).toFixed(1)}s vs ${durationSeconds(targetId).toFixed(1)}s). Refusing to combine unrelated files.`,
			);
		}
		for (const trackPlan of plan.tracks) findTrack(trackPlan.source === "target" ? targetId : sourceId!, trackPlan);
		updateJob({ probe });
		setStep(0, { status: "done", progress: 100, detail: `${plan.tracks.length} subtitle track(s) selected` });

		setStep(1, { status: "active", progress: 0 });
		const rabbitPlans = plan.tracks.filter((track) => track.mode === "rabbit");
		const prepared: PreparedTrack[] = [];
		let keptAttachments: KeptAttachment[] | null = null;

		// Pass 1 - extract every track we restyle. Fonts can only be decided once
		// all of the text is known.
		const extracted: ExtractedTrack[] = [];
		for (let i = 0; i < rabbitPlans.length; i++) {
			checkCancelled();
			const trackPlan = rabbitPlans[i]!;
			const identified = trackPlan.source === "target" ? targetId : sourceId!;
			const input = trackPlan.source === "target" ? plan.targetPath : plan.sourcePath!;
			setStep(1, { progress: Math.round((i / Math.max(1, rabbitPlans.length)) * 50), detail: `Extracting ${trackPlan.source} track ${trackPlan.trackId}` });
			extracted.push(await extractRabbitTrack(trackPlan, findTrack(identified, trackPlan), input, tempDir, job.settings, signal));
		}

		// Pass 2 - work out which attachments survive. A font still referenced by
		// a copied or partly-restyled track is kept and keeps its family name; the
		// rest are dropped, which frees their names for the faces we inject.
		const occupiedFontNames = new Set<string>();
		if (rabbitPlans.length > 0) {
			setStep(1, { progress: 55, detail: "Checking which fonts are still used" });
			const copied = await readCopiedAssText(plan, targetId, sourceId, tempDir, signal);
			checkCancelled();
			const dropUnusedFonts = job.settings.removeUnusedFonts && copied.complete;
			if (job.settings.removeUnusedFonts && !copied.complete) {
				Logger.warn("[repair] Could not read every copied subtitle track; keeping all attachments for safety.");
			}
			const usedFonts = usedFontsAfterRepair(extracted, copied.texts);

			const inputs = [{ path: plan.targetPath, prefix: "att_target" }];
			if (plan.sourcePath && plan.tracks.some((track) => track.source === "source")) inputs.push({ path: plan.sourcePath, prefix: "att_source" });

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
					for (const name of attachment.names) occupiedFontNames.add(name);
				}
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
			setStep(1, { progress: 60 + Math.round((i / Math.max(1, extracted.length)) * 40), detail: `Styling ${item.plan.source} track ${item.plan.trackId}` });
			prepared.push(await styleRabbitTrack(item, tempDir, job.settings, materializeFace));
		}
		setStep(1, { status: "done", progress: 100, detail: rabbitPlans.length ? `${rabbitPlans.length} track(s) processed` : "No subtitle conversion needed" });

		const metadataOnly = isMetadataOnlyRepair(plan, targetId);
		setStep(2, { status: "active", progress: 10, detail: metadataOnly ? "Creating safe metadata-edit copy" : "Copying streams without video encoding" });
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
			const args = buildRepairMkvmergeArgs({ outputPath: stagePath, plan, target: targetId, source: sourceId, prepared, keptAttachments });
			Logger.info(`[repair] Remuxing ${basename(plan.targetPath)} with ${plan.tracks.length} subtitle track(s)`);
			const merged = await run(args, { signal });
			checkCancelled();
			if (merged.code !== 0 && merged.code !== 1)
				throw new Error(`mkvmerge repair failed (exit ${merged.code}): ${(merged.stderr || merged.stdout).slice(-800)}`);
			if (merged.code === 1) Logger.warn(`[repair] mkvmerge completed with warnings: ${(merged.stderr || merged.stdout).slice(-500)}`);
		}

		setStep(2, { progress: 80, detail: "Verifying repaired MKV" });
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
		assertSubtitlePlanApplied(plan, outputSubs, targetId, sourceId);
		if (!durationsAreCompatible(targetId, verified)) throw new Error("Verification failed: repaired duration differs from the encoded target");

		const parsed = parsePath(plan.targetPath);
		const finalPath = plan.replaceTarget ? plan.targetPath : resolveUniqueOutputPath(parsed.dir, `${parsed.name}.repaired.mkv`);
		renameSync(stagePath, finalPath);
		setStep(2, { status: "done", progress: 100, detail: plan.replaceTarget ? "Target replaced after verification" : "Repaired copy created" });
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
