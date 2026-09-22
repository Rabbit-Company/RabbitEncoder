import { basename, extname } from "path";

/** Season/episode identity parsed out of a filename. */
export interface EpisodeKey {
	season: number;
	episode: number;
}

/** How a target was matched to its source, shown so the user can judge it. */
export type RepairPairMethod = "episode" | "order" | "none";

export interface RepairPairSuggestion {
	targetPath: string;
	targetName: string;
	sourcePath: string;
	sourceName: string;
	method: RepairPairMethod;
}

/** Bracketed tags ([Group], (2026)) hold years, resolutions and hashes, never episode numbers. */
const BRACKET_RE = /\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g;

const PATTERNS: { re: RegExp; season: (m: RegExpMatchArray) => number; episode: (m: RegExpMatchArray) => number }[] = [
	// S01E02, s1.e2, S01 E02
	{ re: /\bS(\d{1,3})[\s._-]*E(\d{1,4})\b/i, season: (m) => Number(m[1]), episode: (m) => Number(m[2]) },
	// 1x02
	{ re: /\b(\d{1,3})x(\d{1,4})\b/i, season: (m) => Number(m[1]), episode: (m) => Number(m[2]) },
	// E02, Ep02, Episode 2
	{ re: /\bE(?:p(?:isode)?)?[\s._-]*(\d{1,4})\b/i, season: () => 1, episode: (m) => Number(m[1]) },
	// "Show Name - 02" / "Show Name - 02v2", the usual fansub form
	{ re: /(?:^|[\s._])-[\s._]*(\d{1,4})(?:v\d+)?(?=$|[\s._-])/, season: () => 1, episode: (m) => Number(m[1]) },
];

/**
 * Read the season/episode a filename refers to. Bracketed tags are removed
 * first so a release group or a year cannot be read as an episode. Returns null
 * when nothing recognisable is present, which leaves the file to order-based
 * matching.
 */
export function parseEpisodeKey(name: string): EpisodeKey | null {
	const stem = basename(name, extname(name)).replace(BRACKET_RE, " ");
	for (const pattern of PATTERNS) {
		const match = stem.match(pattern.re);
		if (!match) continue;
		const season = pattern.season(match);
		const episode = pattern.episode(match);
		if (!Number.isFinite(season) || !Number.isFinite(episode)) continue;
		return { season, episode };
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
export function pairRepairFiles(targets: string[], sources: string[]): { pairs: RepairPairSuggestion[]; unmatchedSources: string[] } {
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

	const pairs = sortedTargets.map((target) => {
		const source = matched.get(target) ?? "";
		return {
			targetPath: target,
			targetName: basename(target),
			sourcePath: source,
			sourceName: source ? basename(source) : "",
			method: (source ? (orderMatched.has(target) ? "order" : "episode") : "none") as RepairPairMethod,
		};
	});

	return { pairs, unmatchedSources: sortedSources.filter((source) => !usedSources.has(source)) };
}
