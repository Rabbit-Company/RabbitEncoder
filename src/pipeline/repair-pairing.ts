import { basename, extname } from "path";

/** Season/episode identity parsed out of a filename. */
export interface EpisodeKey {
	season: number;
	episode: number;
}

/** How a target was matched to its source, shown so the user can judge it. */
export type RepairPairMethod = "episode" | "absolute" | "order" | "none";

export interface RepairPairSuggestion {
	targetPath: string;
	targetName: string;
	sourcePath: string;
	sourceName: string;
	method: RepairPairMethod;
	/** With method "absolute": the source's number less the target's episode. */
	offset?: number;
}

/** Bracketed tags ([Group], (2026)) hold years, resolutions and hashes, never episode numbers. */
const BRACKET_RE = /\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g;

const PATTERNS: { re: RegExp; season: ((m: RegExpMatchArray) => number) | null; episode: (m: RegExpMatchArray) => number }[] = [
	// S01E02, s1.e2, S01 E02
	{ re: /\bS(\d{1,3})[\s._-]*E(\d{1,4})\b/i, season: (m) => Number(m[1]), episode: (m) => Number(m[2]) },
	// 1x02
	{ re: /\b(\d{1,3})x(\d{1,4})\b/i, season: (m) => Number(m[1]), episode: (m) => Number(m[2]) },
	// E02, Ep02, Episode 2
	{ re: /\bE(?:p(?:isode)?)?[\s._-]*(\d{1,4})\b/i, season: null, episode: (m) => Number(m[1]) },
	// "Show Name - 02" / "Show Name - 02v2", the usual fansub form
	{ re: /(?:^|[\s._])-[\s._]*(\d{1,4})(?:v\d+)?(?=$|[\s._-])/, season: null, episode: (m) => Number(m[1]) },
];

/**
 * Read the season/episode a filename refers to. Bracketed tags are removed
 * first so a release group or a year cannot be read as an episode. Returns null
 * when nothing recognisable is present, which leaves the file to order-based
 * matching.
 */
export function parseEpisodeKey(name: string): EpisodeKey | null {
	const parsed = parseEpisodeName(name);
	return parsed && { season: parsed.season ?? 1, episode: parsed.episode };
}

/** The episode a filename names, with its season only when the name gives one, as fansub releases numbered across seasons do not. */
export function parseEpisodeName(name: string): { season?: number; episode: number } | null {
	const stem = basename(name, extname(name)).replace(BRACKET_RE, " ");
	for (const pattern of PATTERNS) {
		const match = stem.match(pattern.re);
		if (!match) continue;
		const episode = pattern.episode(match);
		const season = pattern.season?.(match);
		if (!Number.isFinite(episode) || (season !== undefined && !Number.isFinite(season))) continue;
		return season === undefined ? { episode } : { season, episode };
	}
	return null;
}

const keyOf = (key: EpisodeKey): string => `${key.season}:${key.episode}`;

/** Natural order, so "ep2" sorts before "ep10". */
function naturalSort(paths: string[]): string[] {
	return [...paths].sort((a, b) => basename(a).localeCompare(basename(b), undefined, { numeric: true, sensitivity: "base" }));
}

/**
 * Suggest a source for every encoded target.
 *
 * Season/episode numbers are matched first and only when both sides name that
 * episode exactly once — an ambiguous number is never guessed at. Whatever is
 * left over is aligned in natural filename order, but only when both sides have
 * the same number of leftovers, since a mismatched count means we cannot know
 * which file is missing. Anything still unmatched comes back with no source and
 * method "none", for the user to set or skip.
 */
export function pairRepairFiles(
	targets: string[],
	sources: string[],
	options: { absoluteOffset?: number } = {},
): { pairs: RepairPairSuggestion[]; unmatchedSources: string[] } {
	const sortedTargets = naturalSort(targets);
	const sortedSources = naturalSort(sources);

	const sourcesByEpisode = new Map<string, string[]>();
	for (const source of sortedSources) {
		const key = parseEpisodeKey(source);
		if (!key) continue;
		const bucket = sourcesByEpisode.get(keyOf(key));
		if (bucket) bucket.push(source);
		else sourcesByEpisode.set(keyOf(key), [source]);
	}

	const targetsByEpisode = new Map<string, number>();
	for (const target of sortedTargets) {
		const key = parseEpisodeKey(target);
		if (!key) continue;
		targetsByEpisode.set(keyOf(key), (targetsByEpisode.get(keyOf(key)) ?? 0) + 1);
	}

	const matched = new Map<string, string>(); // target -> source
	const usedSources = new Set<string>();
	for (const target of sortedTargets) {
		const key = parseEpisodeKey(target);
		if (!key) continue;
		const id = keyOf(key);
		const candidates = sourcesByEpisode.get(id);
		if (!candidates || candidates.length !== 1 || targetsByEpisode.get(id) !== 1) continue;
		matched.set(target, candidates[0]!);
		usedSources.add(candidates[0]!);
	}

	// Releases numbered across seasons, "Show - 13" for S02E01: per season, the offset most leftovers agree on.
	const offsets = absoluteOffsets(
		sortedTargets.filter((target) => !matched.has(target)),
		sortedSources.filter((source) => !usedSources.has(source)),
		options.absoluteOffset,
	);
	const absoluteMatched = new Map<string, number>();
	for (const [target, { source, offset }] of offsets) {
		matched.set(target, source);
		usedSources.add(source);
		absoluteMatched.set(target, offset);
	}

	const leftoverTargets = sortedTargets.filter((target) => !matched.has(target));
	const leftoverSources = sortedSources.filter((source) => !usedSources.has(source));
	const alignable = leftoverTargets.length > 0 && leftoverTargets.length === leftoverSources.length;
	const orderMatched = new Set<string>();
	if (alignable) {
		leftoverTargets.forEach((target, index) => {
			const source = leftoverSources[index]!;
			matched.set(target, source);
			usedSources.add(source);
			orderMatched.add(target);
		});
	}

	const pairs = sortedTargets.map((target): RepairPairSuggestion => {
		const source = matched.get(target) ?? "";
		const offset = absoluteMatched.get(target);
		return {
			targetPath: target,
			targetName: basename(target),
			sourcePath: source,
			sourceName: source ? basename(source) : "",
			method: !source ? "none" : orderMatched.has(target) ? "order" : offset !== undefined ? "absolute" : "episode",
			...(offset !== undefined ? { offset } : {}),
		};
	});

	return { pairs, unmatchedSources: sortedSources.filter((source) => !usedSources.has(source)) };
}

/**
 * Targets that name a season matched to sources numbered without one, by the
 * offset most of a season's leftovers agree on. An offset needs two pairs that
 * agree, or the season's only leftover target, and no other offset as common,
 * so a stray number never decides it, unless the user gives it. Each number
 * must name one source only.
 */
function absoluteOffsets(targets: string[], sources: string[], given?: number): Map<string, { source: string; offset: number }> {
	const out = new Map<string, { source: string; offset: number }>();
	const sourceByNumber = new Map<number, string | null>();
	for (const source of sources) {
		const parsed = parseEpisodeName(source);
		if (!parsed || parsed.season !== undefined) continue;
		sourceByNumber.set(parsed.episode, sourceByNumber.has(parsed.episode) ? null : source);
	}
	const bySeason = new Map<number, Array<{ target: string; episode: number }>>();
	for (const target of targets) {
		const parsed = parseEpisodeName(target);
		if (!parsed || parsed.season === undefined) continue;
		bySeason.set(parsed.season, [...(bySeason.get(parsed.season) ?? []), { target, episode: parsed.episode }]);
	}
	for (const entries of bySeason.values()) {
		const votes = new Map<number, number>();
		for (const { episode } of entries)
			for (const [number, source] of sourceByNumber) if (source && number > episode) votes.set(number - episode, (votes.get(number - episode) ?? 0) + 1);
		const ranked = [...votes].sort((a, b) => b[1] - a[1]);
		const [best, second] = ranked;
		// An offset given by hand decides alone. Otherwise a tie, such as a folder of the whole series, is left to the user.
		const offset = given ?? (!best || (second && second[1] === best[1]) || (best[1] < 2 && entries.length > 1) ? undefined : best[0]);
		if (offset === undefined) continue;
		for (const { target, episode } of entries) {
			const source = sourceByNumber.get(episode + offset);
			if (!source || [...out.values()].some((m) => m.source === source)) continue;
			out.set(target, { source, offset });
		}
	}
	return out;
}
