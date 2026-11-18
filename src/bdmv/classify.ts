import { MPLS_CLOCK, playlistTimeline, type Mpls, type PlaylistTimeline } from "./mpls";

export interface DiscPlaylist {
	/** Playlist number as written, "00002". */
	name: string;
	mpls: Mpls;
}

export type DiscItemKind = "episode" | "extra" | "movie";

/** How an episode's range was found, which says how much its boundaries can be trusted. */
export type SplitSource = "playlist" | "items" | "chapters";

export interface DiscItem {
	kind: DiscItemKind;
	playlist: string;
	/** Range on the playlist's timeline, in seconds. */
	start: number;
	end: number;
	split: SplitSource;
	/** Chapter starts of the whole playlist, for moving a boundary to another chapter. */
	chapters: number[];
	audio: string[];
	subtitles: string[];
	note?: string;
	/** Left unticked when false, such as another cut of a movie. */
	selected?: boolean;
}

/** Playlists shorter than this are logos, warnings, menu loops and blank filler. */
export const MIN_EXTRA_SECONDS = 30;
const COVERED = 0.9;
/** Extras shorter than this are mostly copyright warnings and logos, so they start unticked. */
const SHORT_EXTRA_SECONDS = 60;

const extraOf = (p: { timeline: PlaylistTimeline }, note?: string): Pick<DiscItem, "note" | "selected"> =>
	p.timeline.duration < SHORT_EXTRA_SECONDS ? { selected: false, note: "Under a minute, often a copyright warning or a logo." } : note ? { note } : {};

interface Segment {
	clip: string;
	from: number;
	to: number;
}

const segmentsOf = (mpls: Mpls): Segment[] => mpls.items.map((i) => ({ clip: i.clip, from: i.inTime, to: i.outTime }));
const ticks = (segments: Segment[]): number => segments.reduce((sum, s) => sum + Math.max(0, s.to - s.from), 0);

/** Seconds of different picture a playlist plays, counting a clip range played twice once. */
export function distinctSeconds(segments: Segment[]): number {
	const byClip = new Map<string, [number, number][]>();
	for (const s of segments) byClip.set(s.clip, [...(byClip.get(s.clip) ?? []), [s.from, s.to]]);
	let total = 0;
	for (const ranges of byClip.values()) {
		let end = -Infinity;
		for (const [from, to] of ranges.sort((a, b) => a[0] - b[0])) {
			if (to > end) total += to - Math.max(from, end);
			end = Math.max(end, to);
		}
	}
	return total / MPLS_CLOCK;
}

/** Share of `a` that `b` also plays. */
export function coveredShare(a: Segment[], b: Segment[]): number {
	const total = ticks(a);
	if (!total) return 1;
	let shared = 0;
	for (const s of a) {
		for (const t of b) {
			if (s.clip !== t.clip) continue;
			shared += Math.max(0, Math.min(s.to, t.to) - Math.max(s.from, t.from));
		}
	}
	return Math.min(1, shared / total);
}

function languages(mpls: Mpls, kind: "audio" | "subtitles"): string[] {
	const first = mpls.items.find((i) => i[kind].length) ?? mpls.items[0];
	return first ? first[kind].map((s) => s.language || "und") : [];
}

/**
 * Splits [lo, hi] into `count` ranges at the given points, as equal in length
 * as the points allow. Returns the inner boundaries.
 */
export function equalSplit(points: number[], lo: number, hi: number, count: number): number[] | null {
	const inner = [...new Set(points.filter((p) => p > lo + 1 && p < hi - 1))].sort((a, b) => a - b);
	const nodes = [lo, ...inner, hi];
	const n = nodes.length;
	if (count < 1 || count > n - 1) return null;
	const target = (hi - lo) / count;
	const cost = (a: number, b: number) => (nodes[b]! - nodes[a]! - target) ** 2;
	// best[k][j]: lowest cost of k ranges from lo to nodes[j].
	const best: number[][] = Array.from({ length: count + 1 }, () => new Array(n).fill(Infinity));
	const from: number[][] = Array.from({ length: count + 1 }, () => new Array(n).fill(-1));
	best[0]![0] = 0;
	for (let k = 1; k <= count; k++) {
		for (let j = k; j < n; j++) {
			for (let i = k - 1; i < j; i++) {
				const c = best[k - 1]![i]! + cost(i, j);
				if (c < best[k]![j]!) {
					best[k]![j] = c;
					from[k]![j] = i;
				}
			}
		}
	}
	if (!Number.isFinite(best[count]![n - 1]!)) return null;
	const cuts: number[] = [];
	for (let k = count, j = n - 1; k > 1; k--) {
		j = from[k]![j]!;
		cuts.unshift(nodes[j]!);
	}
	return cuts;
}

const worstDeviation = (bounds: number[], target: number): number => Math.max(...bounds.slice(1).map((b, i) => Math.abs(b - bounds[i]! - target) / target));

/**
 * Ranges of the episodes in a playlist that plays several. Play item starts
 * are tried first, since discs usually give each episode its own item. Chapters
 * are used when the items do not fit.
 */
export function splitEpisodes(mpls: Mpls, timeline: PlaylistTimeline, count: number): { bounds: number[]; split: SplitSource } {
	// Logos before the first episode and blank filler after the last are left out.
	// Short items between episodes, such as dub credits, stay with the episode they follow, and so does the
	// last one when every episode has one.
	const lengths = mpls.items.map((i) => (i.outTime - i.inTime) / MPLS_CLOCK);
	const long = (i: number) => (lengths[i] ?? 0) >= MIN_EXTRA_SECONDS;
	const first = lengths.findIndex((_, i) => long(i));
	const last = lengths.findLastIndex((_, i) => long(i));
	const longStarts = lengths.flatMap((_, i) => (long(i) ? [i] : []));
	const followed = longStarts.length >= 2 && longStarts.slice(0, -1).every((i) => !long(i + 1));
	const end = followed && last + 1 < lengths.length ? last + 2 : last + 1;
	const lo = first > 0 ? timeline.itemStarts[first]! : 0;
	const hi = last >= 0 && end < lengths.length ? timeline.itemStarts[end]! : timeline.duration;
	if (count <= 1) return { bounds: [lo, hi], split: "items" };

	const target = (hi - lo) / count;
	for (const points of [longStarts.map((i) => timeline.itemStarts[i]!), timeline.itemStarts]) {
		const byItems = equalSplit(points, lo, hi, count);
		if (byItems && worstDeviation([lo, ...byItems, hi], target) <= 0.15) return { bounds: [lo, ...byItems, hi], split: "items" };
	}
	const byChapters = equalSplit([...timeline.itemStarts, ...timeline.chapters], lo, hi, count);
	if (byChapters) return { bounds: [lo, ...byChapters, hi], split: "chapters" };
	const even = Array.from({ length: count + 1 }, (_, i) => lo + i * target);
	return { bounds: even, split: "chapters" };
}

interface ReadPlaylist extends DiscPlaylist {
	timeline: PlaylistTimeline;
	segments: Segment[];
	/** Share of steps from one play item to the next that go forward through the disc's files. */
	order: number;
	/** Other playlists that play the same clips. */
	twins: number;
	/** Whether a twin plays them in another order and is as much in order as this one. */
	ambiguous: boolean;
}

/**
 * How much a playlist plays its clips in the order of the disc's files. Some
 * studios add dozens of playlists that play the feature's clips shuffled, and
 * the real one is nearly always the one that goes forward.
 */
export function playOrder(mpls: Mpls): number {
	const items = mpls.items;
	if (items.length < 2) return 1;
	let forward = 0;
	for (let i = 1; i < items.length; i++) {
		const a = items[i - 1]!;
		const b = items[i]!;
		if (b.clip === a.clip ? b.inTime >= a.inTime : Number(b.clip) > Number(a.clip)) forward++;
	}
	return forward / (items.length - 1);
}

const sameOrder = (a: Segment[], b: Segment[]) =>
	a.length === b.length && a.every((s, i) => s.clip === b[i]!.clip && Math.abs(s.from - b[i]!.from) < MPLS_CLOCK);

/**
 * Playlists long enough to matter, with the same content under several
 * numbers kept once, such as one per audio choice in the menu. Of such twins
 * the one that plays the clips most in order is kept.
 */
export function uniquePlaylists(playlists: DiscPlaylist[]): ReadPlaylist[] {
	const read = playlists
		.map((p) => ({ ...p, timeline: playlistTimeline(p.mpls), segments: segmentsOf(p.mpls), order: playOrder(p.mpls), twins: 0, ambiguous: false }))
		// A menu background looped hundreds of times plays the same few seconds over and over.
		.filter((p) => p.timeline.duration >= MIN_EXTRA_SECONDS && distinctSeconds(p.segments) >= p.timeline.duration * 0.5)
		.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
	const unique: ReadPlaylist[] = [];
	for (const p of read) {
		// Twins play the same clips for as long. A cut with a scene added plays most of them too, but runs longer.
		const sameLength = (u: { timeline: PlaylistTimeline }) => Math.abs(u.timeline.duration - p.timeline.duration) <= Math.max(2, p.timeline.duration * 0.005);
		const at = unique.findIndex((u) => sameLength(u) && coveredShare(p.segments, u.segments) >= COVERED && coveredShare(u.segments, p.segments) >= COVERED);
		if (at < 0) {
			unique.push(p);
			continue;
		}
		const kept = unique[at]!;
		const twins = kept.twins + 1;
		if (p.order > kept.order) unique[at] = { ...p, twins, ambiguous: false };
		else unique[at] = { ...kept, twins, ambiguous: kept.ambiguous || (p.order === kept.order && !sameOrder(p.segments, kept.segments)) };
	}
	return unique;
}

const base = (p: ReadPlaylist) => ({
	playlist: p.name,
	chapters: p.timeline.chapters,
	audio: languages(p.mpls, "audio"),
	subtitles: languages(p.mpls, "subtitles"),
});

function shuffleNote(p: ReadPlaylist): string | undefined {
	if (p.ambiguous)
		return `${p.twins + 1} playlists play these clips in different orders, and Rabbit could not tell which is right. Check this one plays in order.`;
	if (p.twins >= 2 && p.order < 1) return `${p.twins + 1} playlists play these clips in different orders. This one is the most in order.`;
	if (p.twins >= 2) return `Chosen from ${p.twins + 1} playlists that play these clips, as the one that plays them in order.`;
	return undefined;
}

export interface ClassifyOptions {
	/** Expected episode length in seconds. */
	runtime: number;
	/** Episodes on this disc, when the count guessed from the runtime is wrong. */
	episodes?: number;
}

/**
 * Sorts a disc's playlists into episodes and extras. The longest playlist that
 * holds several episodes is split. Without one, each playlist of episode
 * length is an episode. Whatever else is long enough and not already played
 * by an episode is an extra.
 */
export function classifyDisc(playlists: DiscPlaylist[], options: ClassifyOptions): DiscItem[] {
	const runtime = Math.max(60, options.runtime);
	const unique = uniquePlaylists(playlists);
	const items: DiscItem[] = [];

	const longest = [...unique].sort((a, b) => b.timeline.duration - a.timeline.duration)[0];
	type Read = (typeof unique)[number];
	// A count given for the disc settles it. Otherwise the runtime says whether the longest playlist holds several episodes.
	const holdsSeveral = (p: Read) =>
		options.episodes !== undefined ? options.episodes >= 2 : p.timeline.duration >= runtime * 1.6 && Math.round(p.timeline.duration / runtime) >= 2;
	const main = longest && holdsSeveral(longest) ? longest : undefined;
	const taken: Segment[][] = [];

	if (main) {
		const count = options.episodes ?? Math.max(2, Math.round(main.timeline.duration / runtime));
		const { bounds, split } = splitEpisodes(main.mpls, main.timeline, count);
		for (let i = 0; i < bounds.length - 1; i++) {
			items.push({
				kind: "episode",
				...base(main),
				start: bounds[i]!,
				end: bounds[i + 1]!,
				split,
				...(split === "chapters" ? { note: "Split at chapters. Check where each episode starts." } : {}),
			});
		}
		taken.push(main.segments);
	} else {
		const episodeLength = (d: number) => d >= runtime * 0.6 && d <= runtime * 1.6;
		const episodes = unique.filter((p) => episodeLength(p.timeline.duration)).slice(0, options.episodes ?? Infinity);
		for (const p of episodes) {
			items.push({ kind: "episode", ...base(p), start: 0, end: p.timeline.duration, split: "playlist" });
			taken.push(p.segments);
		}
	}

	for (const p of unique) {
		if (p === main || taken.some((t) => t === p.segments)) continue;
		if (taken.some((t) => coveredShare(p.segments, t) >= COVERED)) continue;
		// A playlist that plays the episodes with something added, such as a Play All with the credits.
		if (taken.length && taken.every((t) => coveredShare(t, p.segments) >= COVERED)) continue;
		const long = p.timeline.duration >= runtime * 0.6;
		items.push({
			kind: "extra",
			...base(p),
			start: 0,
			end: p.timeline.duration,
			split: "playlist",
			...extraOf(p, long ? "Episode length. It may be a special." : undefined),
		});
	}
	return items;
}

export interface MovieClassifyOptions {
	/** The movie's runtime in seconds, when known. */
	runtime?: number;
}

/** Shortest playlist taken for a feature when the runtime is unknown. */
const MIN_FEATURE_SECONDS = 45 * 60;

/**
 * Sorts a movie disc's playlists into the feature, other cuts of it and
 * extras. The feature is the playlist closest to the runtime, or the longest.
 * Other feature-length playlists are offered unticked, since they are most
 * often another cut or a 3D or other language version.
 */
export function classifyMovieDisc(playlists: DiscPlaylist[], options: MovieClassifyOptions = {}): DiscItem[] {
	const unique = uniquePlaylists(playlists);
	const runtime = options.runtime && options.runtime > 0 ? options.runtime : undefined;
	const minimum = runtime ? Math.min(runtime * 0.75, MIN_FEATURE_SECONDS) : MIN_FEATURE_SECONDS;
	const distance = (p: ReadPlaylist) => (runtime ? Math.abs(p.timeline.duration - runtime) : -p.timeline.duration);
	const features = unique.filter((p) => p.timeline.duration >= minimum).sort((a, b) => distance(a) - distance(b) || b.order - a.order);
	const items: DiscItem[] = [];
	const [main, ...others] = features;
	const minutes = (s: number) => Math.round(Math.abs(s) / 60);
	if (main) {
		const note = shuffleNote(main);
		items.push({ kind: "movie", ...base(main), start: 0, end: main.timeline.duration, split: "playlist", ...(note ? { note } : {}) });
		for (const p of others) {
			const diff = p.timeline.duration - main.timeline.duration;
			const related = coveredShare(p.segments, main.segments) >= 0.6 || coveredShare(main.segments, p.segments) >= 0.6;
			const length = Math.abs(diff) < 60 ? "about as long" : `${minutes(diff)} min ${diff > 0 ? "longer" : "shorter"}`;
			items.push({
				kind: "movie",
				...base(p),
				start: 0,
				end: p.timeline.duration,
				split: "playlist",
				selected: false,
				note: related
					? `Another cut, ${length}. Tick it and name its edition to keep both.`
					: `Another feature-length playlist, ${length}. It may be another version or a bonus film.`,
			});
		}
	}
	const taken = features.map((p) => p.segments);
	for (const p of unique) {
		if (features.includes(p) || taken.some((t) => coveredShare(p.segments, t) >= COVERED)) continue;
		items.push({ kind: "extra", ...base(p), start: 0, end: p.timeline.duration, split: "playlist", ...extraOf(p) });
	}
	return items;
}

/**
 * Whether the playlists alone settle it. Nothing longer than an hour is a
 * series. Episodes in playlists of their own or in play items lean to a
 * series, but a film can be split into play items of episode length too, so
 * the lookups have the last word whenever there is a long playlist.
 */
export function discShape(discs: DiscPlaylist[][]): "series" | "series-like" | "unclear" {
	const longest = Math.max(0, ...discs.flatMap((playlists) => uniquePlaylists(playlists).map((p) => p.timeline.duration)));
	if (longest < 60 * 60) return "series";
	const items = discs.flatMap((playlists) => classifyDisc(playlists, { runtime: 24 * 60 }));
	const episodes = items.filter((i) => i.kind === "episode");
	return episodes.length >= 2 && episodes.some((i) => i.split !== "chapters") ? "series-like" : "unclear";
}
