import { readdirSync, statSync } from "fs";
import { basename, extname, join } from "path";
import { mapPool } from "../core/concurrency";
import type {
	RepairCompression,
	RepairInspectionFile,
	RepairPlan,
	RepairSubtitleTrack,
	RepairSubtitleTrackPlan,
	SubtitleFormatPriority,
	SubtitleStreamInfo,
} from "../core/types";
import { preferredSourceRank, sceneGroup } from "../subsearch/naming";
import {
	buildSubtitleTrackName,
	detectSubtitleTrackType,
	extractGroupFromTitle,
	extractSourceTag,
	languageFromTitle,
	normalizeLanguageGroup,
	sanitizeLanguageTag,
	type SubtitleTrackType,
} from "../tracks/tracks";
import { resolveTranslateLang } from "../translate/translate-languages";
import { addedDefaults } from "../translate/translate-step";
import { orderTranslatedByPriority, planTrackOrder } from "./translate-only";
import { inspectRepairFile, sanitizeRepairPlan } from "./repair";
import { pairRepairFiles, type RepairPairMethod } from "./repair-pairing";

/** Kinds worth filling in from other releases. Commentary and storyboards are left alone. */
const RELEASE_KINDS: SubtitleTrackType[] = ["full", "honorifics", "sdh", "forced"];
const KIND_LABELS: Record<string, string> = { full: "", honorifics: "Honorifics", sdh: "SDH", forced: "Signs & Songs" };
const VARIANT_NAMES: Record<string, string> = {
	"es-419": "Spanish (Latin America)",
	"pt-BR": "Portuguese (Brazil)",
	"fr-CA": "French (Canada)",
};
/** Regions whose Spanish is the Latin American kind, which releases carry as its own track. */
const LATIN_AMERICA = new Set(["419", "MX", "AR", "CO", "CL", "PE", "VE", "EC", "GT", "CU", "BO", "DO", "HN", "PY", "SV", "NI", "CR", "PA", "UY", "PR"]);
const TRADITIONAL_CHINESE = new Set(["TW", "HK", "MO"]);

/**
 * One key per audience a subtitle language serves. "de", "ger" and "de-DE"
 * are one language, while releases carry Latin American and European
 * Spanish, Brazilian and European Portuguese, Canadian and French French,
 * and Simplified and Traditional Chinese as separate tracks, so those stay
 * apart. A bare "es", "pt" or "fr" is the European one. Null for a track of
 * no language.
 */
export function releaseLanguageKey(tag: string | undefined): string | null {
	const parts = (tag ?? "").trim().split(/[-_]/);
	const raw = parts[0]!.toLowerCase();
	if (!raw || ["und", "zxx", "mis", "mul"].includes(raw)) return null;
	const base = resolveTranslateLang(raw)?.code.split("-")[0]!.toLowerCase() ?? normalizeLanguageGroup(raw);
	const subtags = parts.slice(1);
	const script = subtags.find((s) => s.length === 4)?.toLowerCase();
	const region = subtags.find((s) => s.length === 2 || /^\d{3}$/.test(s))?.toUpperCase();
	if (base === "zh") return script === "hant" || (!script && region && TRADITIONAL_CHINESE.has(region)) ? "zh-Hant" : "zh-Hans";
	if (base === "es") return region && LATIN_AMERICA.has(region) ? "es-419" : "es";
	if (base === "pt") return region === "BR" ? "pt-BR" : "pt";
	if (base === "fr") return region === "CA" ? "fr-CA" : "fr";
	return base;
}

export function releaseLanguageName(key: string): string {
	return VARIANT_NAMES[key] ?? resolveTranslateLang(key)?.name ?? key;
}

type TrackTraits = Pick<RepairSubtitleTrack, "codec" | "title" | "isForced" | "isHearingImpaired" | "isCommentary">;

export function releaseTrackKind(track: TrackTraits): SubtitleTrackType {
	if (track.isCommentary) return "commentary";
	return detectSubtitleTrackType({ index: 0, codec: track.codec, title: track.title, isForced: track.isForced, isHearingImpaired: track.isHearingImpaired });
}

/** A group read from a name, unless the parser fell back to the whole name. */
function groupIn(name: string): string | null {
	const group = extractGroupFromTitle(name);
	return group && group !== name.trim() ? group : null;
}

/**
 * Who a track from a release comes from: the streaming source or group its
 * track name credits, else the one in the release's file name, such as CR in
 * "[Erai-raws] Show - 01 [1080p CR WEB-DL]".
 */
export function releaseCredit(title: string, fileName: string): string | null {
	// The CRC32 fansub releases end with would otherwise pass for a group.
	const stem = basename(fileName, extname(fileName)).replace(/[\[(][0-9A-F]{8}[\])]/gi, " ");
	return extractSourceTag(title) ?? groupIn(title) ?? extractSourceTag(stem) ?? groupIn(stem) ?? sceneGroup(stem);
}

/** Place in the preferred sources by the track name or the file name, whichever ranks better. */
export function releasePreferredRank(title: string, fileName: string, preferred: string[]): number {
	const stem = basename(fileName, extname(fileName));
	return Math.min(preferredSourceRank(title, "", "", preferred), preferredSourceRank(stem, "", "", preferred));
}

function isTextCodec(codecId: string): boolean {
	return /^S_TEXT\//i.test(codecId);
}

/** ASS keeps its styling, so it goes before SRT, and text before pictures unless pictures come first. */
function formatRank(track: Pick<RepairSubtitleTrack, "codecId">, priority: SubtitleFormatPriority): number {
	const id = track.codecId.toUpperCase();
	const text = id === "S_TEXT/ASS" || id === "S_TEXT/SSA" ? 0 : id === "S_TEXT/UTF8" ? 1 : isTextCodec(id) ? 2 : 3;
	return priority === "picture-first" ? (text === 3 ? 0 : text + 1) : text;
}

/**
 * What the user says a track is, for every track of this language tag and name
 * in the releases and the encodes. kind "ignore" leaves the track out, as if no
 * file had it. as replaces its language tag, such as "ar" with "ar-SA".
 */
export interface ReleaseTrackMapping {
	language: string;
	title: string;
	kind?: SubtitleTrackType | "ignore";
	as?: string;
}

export const releaseMappingId = (language: string, title: string): string => `${language}\n${title}`;

export interface ReleaseSubsOptions {
	/** Sources and groups to take first, such as ["CR", "NF"]. */
	preferredSources: string[];
	formatPriority: SubtitleFormatPriority;
	/** Name added tracks the way an encode names its tracks. */
	renameTracks: boolean;
	/** Languages to order the grid by, as in the subtitle language priority. */
	languagePriority?: string[];
	/** Replace a track the target has when a source offers the same language and kind from a source ranked higher. */
	replaceWorse?: boolean;
	/** Chosen by hand: a source track per key, or null to leave the key alone. */
	choices?: Record<string, { sourcePath: string; trackId: number } | null>;
	mappings?: ReleaseTrackMapping[];
}

export interface ReleaseCandidate {
	sourcePath: string;
	trackId: number;
	codec: string;
	codecId: string;
	/** The language tag the source gives the track, made specific by its title when the tag is bare. */
	language: string;
	title: string;
	credit: string | null;
	text: boolean;
	/** Rabbit can restyle it, so it gets the same styling as the encode's own tracks. */
	rabbit: boolean;
	isOriginal: boolean;
	preferredRank: number;
}

export interface ReleaseHave {
	trackId: number;
	title: string;
	language: string;
	preferredRank: number;
}

export type ReleaseCellAction = "keep" | "add" | "replace" | "skip" | "missing";

export interface ReleaseCell {
	key: string;
	language: string;
	kind: SubtitleTrackType;
	/** The target's own tracks of this language and kind. */
	have: ReleaseHave[];
	/** Source tracks of this language and kind, the best first. */
	candidates: ReleaseCandidate[];
	/**
	 * keep: the target has it. add: the chosen candidate is added. replace: it
	 * replaces the target's tracks. skip: left alone by choice. missing: no
	 * file has it.
	 */
	action: ReleaseCellAction;
	chosen?: ReleaseCandidate;
}

export interface ReleaseAddition extends ReleaseCandidate {
	key: string;
	kind: SubtitleTrackType;
	trackName: string;
	mode: "rabbit" | "copy";
	isDefault: boolean;
	isForced: boolean;
	isHearingImpaired: boolean;
}

/** A track the encode keeps whose type or language a mapping changed. */
export interface ReleaseRetag {
	trackId: number;
	title: string;
	language: string;
	kind: SubtitleTrackType;
	isForced: boolean;
	isHearingImpaired: boolean;
}

export interface ReleaseTargetPlan {
	targetPath: string;
	cells: ReleaseCell[];
	additions: ReleaseAddition[];
	/** Target tracks the additions replace. */
	removals: number[];
	retags: ReleaseRetag[];
}

export function cellKey(language: string, kind: SubtitleTrackType): string {
	return `${language}:${kind}`;
}

type MappingIndex = Map<string, ReleaseTrackMapping>;

function indexMappings(mappings: ReleaseTrackMapping[] | undefined): MappingIndex {
	return new Map((mappings ?? []).map((m) => [releaseMappingId(m.language, m.title), m]));
}

interface TrackKey {
	key: string;
	language: string;
	kind: SubtitleTrackType;
	/** The language tag the track gets, the mapped one or the one read from its tag and title. */
	tag: string;
	/** A mapping changed the type Rabbit read from the track. */
	remapped: boolean;
}

function keyOf(track: TrackTraits & Pick<RepairSubtitleTrack, "language">, mappings: MappingIndex): TrackKey | null {
	const mapping = mappings.get(releaseMappingId(track.language, track.title));
	if (mapping?.kind === "ignore") return null;
	const tag = mapping?.as || languageFromTitle(track.language, track.title);
	const language = releaseLanguageKey(tag);
	const detected = releaseTrackKind(track);
	const kind = mapping?.kind ?? detected;
	if (!language || !RELEASE_KINDS.includes(kind)) return null;
	return { key: cellKey(language, kind), language, kind, tag, remapped: kind !== detected };
}

const KIND_ORDER: string[] = RELEASE_KINDS;

function orderCells<T extends { language: string; kind: string }>(cells: T[], priority: string[]): T[] {
	const languages = orderTranslatedByPriority(
		[...new Set(cells.map((c) => c.language))].map((language) => ({ language })),
		priority,
	).map((l) => l.language);
	return [...cells].sort((a, b) => languages.indexOf(a.language) - languages.indexOf(b.language) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}

/**
 * Which subtitle languages and kinds one target lacks that other releases of
 * it have, and the source track to take for each: the best ranked by the
 * preferred sources, then format.
 */
export function planReleaseSubtitles(target: RepairInspectionFile, sources: RepairInspectionFile[], options: ReleaseSubsOptions): ReleaseTargetPlan {
	const mappings = indexMappings(options.mappings);
	const cells = new Map<string, ReleaseCell>();
	const remapped = new Set<string>();
	const cellFor = (k: TrackKey) => {
		let cell = cells.get(k.key);
		if (!cell) cells.set(k.key, (cell = { key: k.key, language: k.language, kind: k.kind, have: [], candidates: [], action: "missing" }));
		return cell;
	};
	const targetKeys = new Map<number, TrackKey>();
	for (const track of target.subtitles) {
		const k = keyOf(track, mappings);
		if (!k) continue;
		targetKeys.set(track.id, k);
		cellFor(k).have.push({
			trackId: track.id,
			title: track.title,
			language: k.tag,
			preferredRank: releasePreferredRank(track.title, target.filename, options.preferredSources),
		});
	}
	sources.forEach((source) => {
		for (const track of source.subtitles) {
			const k = keyOf(track, mappings);
			if (!k) continue;
			if (k.remapped) remapped.add(`${source.path}\n${track.id}`);
			cellFor(k).candidates.push({
				sourcePath: source.path,
				trackId: track.id,
				codec: track.codec,
				codecId: track.codecId,
				language: k.tag,
				title: track.title,
				credit: releaseCredit(track.title, source.filename),
				text: isTextCodec(track.codecId),
				rabbit: track.canRabbitProcess,
				isOriginal: track.isOriginal,
				preferredRank: releasePreferredRank(track.title, source.filename, options.preferredSources),
			});
		}
	});

	const sourceOrder = new Map(sources.map((s, i) => [s.path, i]));
	const format = (c: ReleaseCandidate) => formatRank(c, options.formatPriority);
	for (const cell of cells.values()) {
		cell.candidates.sort(
			(a, b) =>
				a.preferredRank - b.preferredRank || format(a) - format(b) || sourceOrder.get(a.sourcePath)! - sourceOrder.get(b.sourcePath)! || a.trackId - b.trackId,
		);
		const choice = options.choices?.[cell.key];
		const picked =
			choice === null
				? undefined
				: choice
					? cell.candidates.find((c) => c.sourcePath === choice.sourcePath && c.trackId === choice.trackId)
					: cell.candidates[0];
		const bestHave = Math.min(...cell.have.map((h) => h.preferredRank));
		if (!cell.have.length) cell.action = picked ? "add" : choice === null && cell.candidates.length ? "skip" : "missing";
		else if (picked && (choice || (options.replaceWorse && picked.preferredRank < bestHave))) cell.action = "replace";
		else cell.action = "keep";
		if (cell.action === "add" || cell.action === "replace") cell.chosen = picked;
	}

	const ordered = orderCells([...cells.values()], options.languagePriority ?? []);
	const removals = ordered.filter((c) => c.action === "replace").flatMap((c) => c.have.map((h) => h.trackId));
	const chosen = ordered.filter((c) => c.chosen);
	const removed = new Set(removals);
	const kept: SubtitleStreamInfo[] = target.subtitles
		.filter((t) => !removed.has(t.id))
		.map((t) => ({
			index: t.id,
			codec: t.codec,
			language: t.language,
			title: t.title,
			isForced: t.isForced,
			isHearingImpaired: t.isHearingImpaired,
			isDefault: t.isDefault,
		}));
	const defaults = addedDefaults(
		kept,
		chosen.map((c) => ({ language: c.chosen!.language, trackType: c.kind })),
	);
	const additions = chosen.map((cell, i): ReleaseAddition => {
		const c = cell.chosen!;
		// A track given another type by hand is renamed, so its name does not contradict it.
		const rename = options.renameTracks || !c.title || remapped.has(`${c.sourcePath}\n${c.trackId}`);
		const trackName = rename ? buildSubtitleTrackName(cell.kind, c.title, c.credit ?? undefined) : c.title;
		return {
			...c,
			language: sanitizeLanguageTag(c.language, `${basename(c.sourcePath)} track ${c.trackId}`),
			key: cell.key,
			kind: cell.kind,
			trackName,
			mode: c.rabbit ? "rabbit" : "copy",
			isDefault: defaults.has(i),
			isForced: cell.kind === "forced",
			isHearingImpaired: cell.kind === "sdh",
		};
	});
	const retags = target.subtitles.flatMap((track): ReleaseRetag[] => {
		const k = targetKeys.get(track.id);
		if (!k || removed.has(track.id) || (!k.remapped && k.tag === languageFromTitle(track.language, track.title))) return [];
		const credit = releaseCredit(track.title, target.filename) ?? undefined;
		return [
			{
				trackId: track.id,
				title: k.remapped ? buildSubtitleTrackName(k.kind, track.title, credit) : track.title,
				language: sanitizeLanguageTag(k.tag, `${target.filename} track ${track.id}`),
				kind: k.kind,
				isForced: k.remapped ? k.kind === "forced" : track.isForced,
				isHearingImpaired: k.remapped ? k.kind === "sdh" : track.isHearingImpaired,
			},
		];
	});
	return { targetPath: target.path, cells: ordered, additions, removals, retags };
}

export interface ReleaseColumn {
	key: string;
	language: string;
	kind: SubtitleTrackType;
	label: string;
}

export interface ReleaseRow extends ReleaseTargetPlan {
	targetName: string;
	sources: Array<{ path: string; name: string; method: RepairPairMethod | "manual"; offset?: number }>;
}

/** Releases chosen by hand for one target, in place of the ones pairing found. An empty list leaves it without one. */
export interface ReleaseOverride {
	targetPath: string;
	sourcePaths: string[];
}

export interface ReleaseGrid {
	columns: ReleaseColumn[];
	rows: ReleaseRow[];
}

/** One column per language and kind any file has, with every row holding a cell for each. */
export function releaseGrid(rows: ReleaseRow[], languagePriority: string[] = []): ReleaseGrid {
	const seen = new Map<string, { key: string; language: string; kind: SubtitleTrackType }>();
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

export interface ReleaseFolder {
	path: string;
	/** What a release numbered across seasons adds to an episode, such as 12 when S02E01 is "- 13". */
	offset?: number;
}

/** A subtitle track by language tag and name, as the mapping table lists it. */
export interface ReleaseTrackSummary {
	language: string;
	title: string;
	codec: string;
	/** The type and language key Rabbit reads from the track without a mapping. */
	kind: SubtitleTrackType;
	languageKey: string | null;
	releases: number;
	encodes: number;
}

export interface ReleaseScan extends ReleaseGrid {
	unmatchedSources: string[];
	tracks: ReleaseTrackSummary[];
}

/** Every distinct track of the encodes and their releases, with how many files have it. */
export function releaseTrackSummaries(
	targets: RepairInspectionFile[],
	sources: RepairInspectionFile[],
	languagePriority: string[] = [],
): ReleaseTrackSummary[] {
	const found = new Map<string, ReleaseTrackSummary>();
	const note = (file: RepairInspectionFile, side: "releases" | "encodes") => {
		for (const track of file.subtitles) {
			const id = releaseMappingId(track.language, track.title);
			let summary = found.get(id);
			if (!summary)
				found.set(
					id,
					(summary = {
						language: track.language,
						title: track.title,
						codec: track.codec,
						kind: releaseTrackKind(track),
						languageKey: releaseLanguageKey(languageFromTitle(track.language, track.title)),
						releases: 0,
						encodes: 0,
					}),
				);
			summary[side]++;
		}
	};
	for (const file of targets) note(file, "encodes");
	for (const file of sources) note(file, "releases");
	const languages = orderTranslatedByPriority(
		[...new Set([...found.values()].map((t) => t.languageKey ?? "und"))].map((language) => ({ language })),
		languagePriority,
	).map((l) => l.language);
	return [...found.values()].sort(
		(a, b) =>
			languages.indexOf(a.languageKey ?? "und") - languages.indexOf(b.languageKey ?? "und") ||
			KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
			b.releases + b.encodes - (a.releases + a.encodes) ||
			a.title.localeCompare(b.title),
	);
}

/** The MKVs of a folder in natural order, so episode 2 comes before episode 10. */
export function mkvFilesIn(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".mkv")
		.map((entry) => entry.name)
		.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))
		.map((name) => join(dir, name));
}

export type ReleaseSource = ReleaseRow["sources"][number];

/** The MKVs of a release folder, or the release itself when it is one file. */
export function releaseFilesIn(path: string): string[] {
	return statSync(path).isFile() ? [path] : mkvFilesIn(path);
}

/**
 * Every target's episode in each release folder or file, and the release files
 * that matched no target. A target with an override takes the releases chosen
 * for it instead.
 */
export function pairReleaseFolders(
	targets: string[],
	folders: Array<string | ReleaseFolder>,
	overrides: ReleaseOverride[] = [],
): { pairedSources: Map<string, ReleaseSource[]>; unmatchedSources: string[] } {
	const { pairedSources, unmatchedSources } = pairReleaseFoldersAuto(targets, folders);
	const chosen = new Set<string>();
	for (const override of overrides) {
		if (!pairedSources.has(override.targetPath)) continue;
		const paths = [...new Set(override.sourcePaths)].filter((path) => path !== override.targetPath);
		pairedSources.set(
			override.targetPath,
			paths.map((path) => ({ path, name: basename(path), method: "manual" as const })),
		);
		for (const path of paths) chosen.add(path);
	}
	return { pairedSources, unmatchedSources: unmatchedSources.filter((path) => !chosen.has(path)) };
}

function pairReleaseFoldersAuto(
	targets: string[],
	folders: Array<string | ReleaseFolder>,
): { pairedSources: Map<string, ReleaseSource[]>; unmatchedSources: string[] } {
	const pairedSources = new Map<string, ReleaseSource[]>(targets.map((t) => [t, []]));
	const unmatchedSources: string[] = [];
	for (const folder of folders.map((f) => (typeof f === "string" ? { path: f } : f))) {
		const { pairs, unmatchedSources: unmatched } = pairRepairFiles(
			targets,
			releaseFilesIn(folder.path).filter((path) => !targets.includes(path)),
			{ absoluteOffset: folder.offset },
		);
		unmatchedSources.push(...unmatched);
		for (const pair of pairs) {
			if (!pair.sourcePath) continue;
			pairedSources
				.get(pair.targetPath)!
				.push({ path: pair.sourcePath, name: pair.sourceName, method: pair.method, ...(pair.offset !== undefined ? { offset: pair.offset } : {}) });
		}
	}
	return { pairedSources, unmatchedSources };
}

/**
 * Pairs every target with its episode in each source folder, reads the
 * subtitle tracks of all of them and plans what each target lacks. Only
 * track lists are read, so it stays quick on whole seasons.
 */
export async function scanReleaseSubtitles(input: {
	targets: string[];
	/** Release folders, each with the offset its numbering across seasons has when given by hand. */
	sourceDirs: Array<string | ReleaseFolder>;
	overrides?: ReleaseOverride[];
	options: ReleaseSubsOptions;
	signal?: AbortSignal;
}): Promise<ReleaseScan> {
	const { targets, options, signal } = input;
	const { pairedSources, unmatchedSources } = pairReleaseFolders(targets, input.sourceDirs, input.overrides);
	const files = [...new Set([...targets, ...[...pairedSources.values()].flat().map((s) => s.path)])];
	const inspected = new Map<string, RepairInspectionFile>();
	await mapPool(files, 4, async (path) => {
		inspected.set(path, await inspectRepairFile(path, signal));
	});
	const rows = targets.map((targetPath): ReleaseRow => {
		const sources = pairedSources.get(targetPath)!;
		const plan = planReleaseSubtitles(
			inspected.get(targetPath)!,
			sources.map((s) => inspected.get(s.path)!),
			options,
		);
		return { ...plan, targetName: basename(targetPath), sources };
	});
	const sourcePaths = new Set([...pairedSources.values()].flat().map((s) => s.path));
	const tracks = releaseTrackSummaries(
		targets.map((path) => inspected.get(path)!),
		[...sourcePaths].map((path) => inspected.get(path)!),
		options.languagePriority,
	);
	return { ...releaseGrid(rows, options.languagePriority), unmatchedSources, tracks };
}

/**
 * The Repair plan that carries out one target's plan: its own tracks stay
 * where they are, minus the ones replaced, and every addition comes from its
 * release, retimed to the target by audio. Added tracks go where an encode
 * would put them, by language priority, kind and format. Null when there is
 * nothing to change.
 */
export function buildReleaseRepairPlan(
	target: RepairInspectionFile,
	plan: Pick<ReleaseTargetPlan, "additions" | "removals"> & Partial<Pick<ReleaseTargetPlan, "retags">>,
	options: { replaceTarget: boolean; languagePriority: string[]; formatPriority: SubtitleFormatPriority; compression: RepairCompression },
): RepairPlan | null {
	const retags = new Map((plan.retags ?? []).map((r) => [r.trackId, r]));
	if (!plan.additions.length && !plan.removals.length && !retags.size) return null;
	const removed = new Set(plan.removals);
	const kept = target.subtitles.filter((t) => !removed.has(t.id));
	const sourcePaths = [...new Set(plan.additions.map((a) => a.sourcePath))];

	const keptTracks = kept.map((t): RepairSubtitleTrackPlan => ({
		source: "target",
		trackId: t.id,
		mode: "copy",
		order: 0,
		title: retags.get(t.id)?.title ?? t.title,
		language: retags.get(t.id)?.language ?? t.language,
		compression: "preserve",
		isDefault: t.isDefault,
		isForced: retags.get(t.id)?.isForced ?? t.isForced,
		isEnabled: t.isEnabled,
		isHearingImpaired: retags.get(t.id)?.isHearingImpaired ?? t.isHearingImpaired,
		isOriginal: t.isOriginal,
		isCommentary: t.isCommentary,
	}));
	const addedTracks = plan.additions.map((a): RepairSubtitleTrackPlan => {
		const sourceIndex = sourcePaths.indexOf(a.sourcePath);
		return {
			source: "source",
			trackId: a.trackId,
			mode: a.mode,
			order: 0,
			title: a.trackName,
			language: a.language,
			compression: options.compression,
			isDefault: a.isDefault,
			isForced: a.isForced,
			isEnabled: true,
			isHearingImpaired: a.isHearingImpaired,
			isOriginal: a.isOriginal,
			isCommentary: false,
			...(sourceIndex ? { sourceIndex } : {}),
		};
	});

	// planTrackOrder places added tracks among existing ones, as "0:<id>" and "<n>:0" for the n-th addition.
	const order = planTrackOrder(
		kept.map((t) => ({
			id: t.id,
			type: "subtitles",
			language: retags.get(t.id)?.language ?? t.language,
			kind: retags.get(t.id)?.kind ?? releaseTrackKind(t),
			text: isTextCodec(t.codecId),
		})),
		plan.additions.map((a) => ({ language: a.language, kind: a.kind, text: a.text })),
		options.languagePriority,
		options.formatPriority,
	).split(",");
	const tracks = order.map((ref, position) => {
		const [file, id] = ref.split(":").map(Number) as [number, number];
		const track = file === 0 ? keptTracks.find((t) => t.trackId === id)! : addedTracks[file - 1]!;
		return { ...track, order: position };
	});

	return sanitizeRepairPlan({
		targetPath: target.path,
		sourcePath: sourcePaths[0],
		alignSource: sourcePaths.length > 0,
		extraSources: sourcePaths.slice(1).map((path) => ({ path, alignSource: true })),
		replaceTarget: options.replaceTarget,
		tracks,
	});
}
