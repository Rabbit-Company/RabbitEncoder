import { Logger } from "../core/logger";
import { parseAssEvents, splitAssText, joinAssText, buildTranslatedAss, type AssEventLine } from "../subtitles/ass-edit";
import { parseSrt, buildSrt } from "../subtitles/srt-edit";
import { resolveTranslateLang, normalizeTag, type TranslateLang } from "../translate/translate-languages";
import { translateBatchGeneric, type ContextRow, type GenericOptions, type TranslateItem } from "./generic";
import { createSemaphore, type Semaphore } from "../core/concurrency";
import { letterSignReplacementTexts, reconstructLetterSigns } from "../subtitles/letter-signs";

/**
 * True when a sign/song's visible text is a single character. Animated
 * typesetting is often split into one event per character ("S", "H", "O",
 * "P" as four events, sometimes duplicated per frame); a lone character
 * carries no translatable meaning, so those are kept verbatim. Applies only
 * to non-dialogue (sign/song) events.
 */
export function isSingleCharSign(visible: string): boolean {
	const t = visible.trim();
	// Count code points, not UTF-16 units, so surrogate-pair characters
	// (rare CJK, symbols) still count as one.
	return t === "" || [...t].length === 1;
}

/**
 * Split a timed line sequence into translation chunks of roughly `batchSize`,
 * nudging each boundary to the largest pause nearby so a chunk never cuts
 * mid-conversation.
 *
 * Algorithm (matches the agreed spec): window = round(batchSize * 0.2). At each
 * nominal boundary `n = i + batchSize`, consider split points b in
 * [n - window, n + window] and pick the one with the largest gap between the
 * previous line's end and the next line's start. The final short chunk takes
 * the remainder with no search.
 *
 * Returns half-open [start, end) index ranges covering [0, count).
 */
export function planChunks(startsMs: number[], endsMs: number[], batchSize: number): Array<[number, number]> {
	const n = startsMs.length;
	const chunks: Array<[number, number]> = [];
	if (n === 0) return chunks;

	const size = Math.max(1, Math.floor(batchSize));
	const window = Math.round(size * 0.2);

	let i = 0;
	while (i < n) {
		const nominalEnd = i + size; // exclusive
		if (nominalEnd >= n) {
			chunks.push([i, n]);
			break;
		}
		if (window <= 0) {
			chunks.push([i, nominalEnd]);
			i = nominalEnd;
			continue;
		}

		const lo = Math.max(i + 1, nominalEnd - window);
		const hi = Math.min(n, nominalEnd + window); // b may equal n (split at end)

		let bestB = nominalEnd;
		let bestGap = Number.NEGATIVE_INFINITY;
		for (let b = lo; b <= hi; b++) {
			if (b <= i) continue;
			// Gap that would be "opened" by cutting before line b.
			const gap = b >= n ? Number.POSITIVE_INFINITY : startsMs[b]! - endsMs[b - 1]!;
			if (gap > bestGap) {
				bestGap = gap;
				bestB = b;
			}
		}
		chunks.push([i, bestB]);
		i = bestB;
	}

	return chunks;
}

export interface TranslateContentOptions {
	format: "ass" | "srt";
	batchSize: number;
	/** Shared llm-request budget. If omitted, chunks run sequentially (limit 1). */
	sem?: Semaphore;
	/** When false, only dialogue-classified ASS lines are translated. */
	translateSignsSongs: boolean;
	/**
	 * ASS-only: predicate telling whether a style name is dialogue. Required when
	 * `translateSignsSongs` is false; ignored for SRT. Supply via ass-classifier's
	 * `dialogueStyleNames` in production.
	 */
	isDialogueStyle?: (style: string) => boolean;
	llm: GenericOptions;
	/**
	 * Lines from the end of the previous chunk, with their translations, sent
	 * with each chunk for continuity. Above 0, the chunks of one file run in order.
	 */
	contextLines?: number;
	/** Other-language dialogue from the same file, attached to matching lines as hints. */
	references?: ReferenceTrack[];
	/** Dialogue from other tracks with speaker names, in order of preference, used to name unnamed lines. */
	speakerDonors?: TimedLine[][];
	/** Reports cumulative translated-line progress. */
	onProgress?: (done: number, total: number) => void;
}

interface Unit {
	/** For ASS: event line number. For SRT: cue index. */
	key: number;
	startMs: number;
	endMs: number;
	/** Text handed to the model. */
	visible: string;
	/** ASS leading override block to re-prepend, or "". */
	lead: string;
	/** Speaking character (ASS Name/Actor), passed to generic models as context. */
	name?: string;
	/** Dialogue gets reference lines. Signs share timestamps with unrelated dialogue, so they never do. */
	dialogue: boolean;
}

export interface TimedLine {
	startMs: number;
	endMs: number;
	text: string;
	name?: string;
}

export interface ReferenceTrack {
	lang: TranslateLang;
	lines: TimedLine[];
}

/** Below this share of dialogue finding a reference line, the track is likely out of sync or a different cut. */
const MIN_REFERENCE_MATCH = 0.5;

function cleanReferenceText(text: string): string {
	return text
		.replace(/\{[^}]*\}/g, "")
		.replace(/\\[Nnh]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Reference text for each span, from the reference lines that overlap it by at
 * least half of either line's duration. That catches one line split into two
 * and two lines merged into one, while a line that only grazes a neighbour is
 * left out. Spans with no match get undefined.
 */
export function alignReferences(spans: Array<{ startMs: number; endMs: number }>, ref: TimedLine[]): Array<string | undefined> {
	const lines = ref
		.map((l) => ({ startMs: l.startMs, endMs: l.endMs, text: cleanReferenceText(l.text) }))
		.filter((l) => l.text)
		.sort((a, b) => a.startMs - b.startMs);
	return spans.map((span) => {
		const texts: string[] = [];
		for (const l of lines) {
			if (l.startMs >= span.endMs) break;
			if (sameMoment(span, l) && !texts.includes(l.text)) texts.push(l.text);
		}
		return texts.length ? texts.join(" ") : undefined;
	});
}

/** Overlap that counts as the same moment: at least half of either line. */
function sameMoment(a: { startMs: number; endMs: number }, b: { startMs: number; endMs: number }): boolean {
	const overlap = Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs);
	if (overlap <= 0) return false;
	return overlap * 2 >= Math.max(1, a.endMs - a.startMs) || overlap * 2 >= Math.max(1, b.endMs - b.startMs);
}

/**
 * Speaker for each span from donor lines at the same moment, or undefined when
 * no named line matches or two different speakers do.
 */
export function alignSpeakers(spans: Array<{ startMs: number; endMs: number }>, donor: TimedLine[]): Array<string | undefined> {
	const named = donor.filter((l) => l.name?.trim()).sort((a, b) => a.startMs - b.startMs);
	return spans.map((span) => {
		const names = new Set<string>();
		for (const l of named) {
			if (l.startMs >= span.endMs) break;
			if (sameMoment(span, l)) names.add(l.name!.trim());
		}
		return names.size === 1 ? [...names][0] : undefined;
	});
}

/**
 * Fill in missing speakers from the donors, first donor first. Lines that
 * already have a speaker keep it. Returns how many lines got a name.
 */
export function fillSpeakers(lines: Array<{ startMs: number; endMs: number; name?: string }>, donors: TimedLine[][]): number {
	let filled = 0;
	for (const donor of donors) {
		const missing = lines.filter((l) => !l.name?.trim());
		if (missing.length === 0) break;
		alignSpeakers(missing, donor).forEach((name, i) => {
			if (!name) return;
			missing[i]!.name = name;
			filled++;
		});
	}
	return filled;
}

/**
 * Reference texts per unit, keyed by language name. A reference track that
 * matches too little of the dialogue is dropped with a warning.
 */
function referencesForUnits(units: Unit[], references: ReferenceTrack[]): { refs: Array<Record<string, string> | undefined>; used: TranslateLang[] } {
	const refs: Array<Record<string, string> | undefined> = units.map(() => undefined);
	const used: TranslateLang[] = [];
	const dialogueIdx = units.flatMap((u, i) => (u.dialogue ? [i] : []));
	if (dialogueIdx.length === 0) return { refs, used };

	for (const track of references) {
		const aligned = alignReferences(
			dialogueIdx.map((i) => units[i]!),
			track.lines,
		);
		const matched = aligned.filter((t) => t !== undefined).length;
		const rate = matched / dialogueIdx.length;
		if (rate < MIN_REFERENCE_MATCH) {
			Logger.warn(
				`[translate] ${track.lang.name} reference matches only ${Math.round(rate * 100)}% of the dialogue by timing. It is probably out of sync, so it is not used.`,
			);
			continue;
		}
		Logger.info(`[translate] ${track.lang.name} reference matched ${matched}/${dialogueIdx.length} dialogue lines`);
		used.push(track.lang);
		aligned.forEach((text, k) => {
			if (text === undefined) return;
			const i = dialogueIdx[k]!;
			(refs[i] ??= {})[track.lang.name] = text;
		});
	}
	return { refs, used };
}

/**
 * Translate the contents of one subtitle file (ASS or SRT), returning the new
 * file contents. Structure, timing, styling, and non-translated lines are
 * preserved; only visible dialogue (and, if enabled, signs/songs) is replaced.
 */
export async function translateSubtitleContent(content: string, opts: TranslateContentOptions): Promise<string> {
	if (opts.format === "ass") return translateAss(content, opts);
	return translateSrt(content, opts);
}

/** Dialogue lines in order, with timing and speaker names where the format has them. Signs and songs are left out. */
export function dialogueLines(content: string, format: "ass" | "srt", isDialogueStyle: (style: string) => boolean): TimedLine[] {
	if (format === "srt") {
		return parseSrt(content).map((cue) => ({ startMs: cue.startMs, endMs: cue.endMs, text: cue.text.replace(/\r?\n/g, " ").trim() }));
	}
	return parseAssEvents(content)
		.events.filter((ev) => isDialogueStyle(ev.style))
		.sort((a, b) => a.startMs - b.startMs)
		.map((ev) => ({ startMs: ev.startMs, endMs: ev.endMs, name: ev.name || undefined, text: splitAssText(ev.rawText).visible }));
}

async function translateUnits(units: Unit[], opts: TranslateContentOptions): Promise<Map<number, string>> {
	const out = new Map<number, string>();
	if (units.length === 0) return out;

	const starts = units.map((u) => u.startMs);
	const ends = units.map((u) => u.endMs);
	const chunks = planChunks(starts, ends, opts.batchSize);

	const total = units.length;
	let done = 0;
	opts.onProgress?.(0, total);

	const sem = opts.sem ?? createSemaphore(1);
	const contextLines = Math.max(0, Math.floor(opts.contextLines ?? 0));
	if (opts.speakerDonors?.length) {
		const filled = fillSpeakers(
			units.filter((u) => u.dialogue),
			opts.speakerDonors,
		);
		if (filled) Logger.info(`[translate] Named the speaker of ${filled} line(s) from other subtitle tracks`);
	}
	const { refs, used } = referencesForUnits(units, opts.references ?? []);
	const baseLlm = used.length ? { ...opts.llm, references: used } : opts.llm;

	const runChunk = async ([lo, hi]: [number, number]) => {
		const slice = units.slice(lo, hi);
		const context: ContextRow[] = [];
		for (const u of units.slice(Math.max(0, lo - contextLines), lo)) {
			const translation = out.get(u.key);
			if (translation !== undefined) context.push({ name: u.name, text: u.visible, translation });
		}
		const llm = context.length ? { ...baseLlm, context } : baseLlm;
		const translated = await sem.run(() =>
			translateBatchGeneric(
				slice.map<TranslateItem>((u, k) => ({ text: u.visible, name: u.name, refs: refs[lo + k] })),
				llm,
			),
		);
		for (let k = 0; k < slice.length; k++) {
			out.set(slice[k]!.key, translated[k]!);
		}
		done += slice.length; // safe: runs synchronously between awaits
		opts.onProgress?.(done, total);
	};

	if (contextLines > 0) {
		for (const chunk of chunks) await runChunk(chunk);
	} else {
		await Promise.all(chunks.map(runChunk));
	}

	return out;
}

/**
 * True when a sign's visible text is random-letter ASCII noise (grain/static
 * noise-font typesetting). Structural checks apply per \N segment; the
 * statistical checks (case-flip rate, vowel ratio) are computed over all
 * segments combined — per-segment samples are too small to be reliable.
 * Non-ASCII scripts always return false (fails closed).
 */
export function isNoiseSign(visible: string, durationMs?: number): boolean {
	const segs = visible
		.split(/\\N/i)
		.map((s) => s.trim())
		.filter(Boolean);
	if (segs.length === 0) return false;

	const frameLength = durationMs !== undefined && durationMs <= 100;
	const minLen = frameLength ? 8 : 12;

	for (const seg of segs) {
		if (seg.length < minLen || !/^[A-Za-z]+$/.test(seg)) return false;
	}

	let flips = 0;
	let pairs = 0;
	for (const seg of segs) {
		for (let i = 1; i < seg.length; i++) {
			pairs++;
			if (seg[i - 1]! >= "a" !== seg[i]! >= "a") flips++;
		}
	}
	const flipRate = pairs > 0 ? flips / pairs : 0;
	const all = segs.join("");
	const vowelRatio = (all.match(/[aeiou]/gi)?.length ?? 0) / all.length;

	return flipRate >= (frameLength ? 0.2 : 0.3) && vowelRatio <= (frameLength ? 0.32 : 0.28);
}

/**
 * Find per-frame "churn" effect events (grain, static, glitch text): runs of
 * consecutive same-style non-dialogue events that are frame-length, temporally
 * contiguous, and all carry distinct text. Readable text can't change every
 * frame in any script, so this is language-agnostic. Returns lineNos to skip.
 */
export function findFrameChurnEvents(
	events: AssEventLine[],
	isDialogue: (style: string) => boolean,
	opts = { maxEventMs: 100, maxGapMs: 50, minRun: 5 },
): Set<number> {
	const skip = new Set<number>();
	const byGroup = new Map<string, AssEventLine[]>();

	for (const ev of events) {
		if (isDialogue(ev.style)) continue;
		if (ev.endMs - ev.startMs > opts.maxEventMs) continue;
		const key = `${ev.style}\u0000${ev.name}`;
		let arr = byGroup.get(key);
		if (!arr) byGroup.set(key, (arr = []));
		arr.push(ev);
	}

	for (const arr of byGroup.values()) {
		arr.sort((a, b) => a.startMs - b.startMs);
		let run: AssEventLine[] = [];
		const flush = () => {
			const texts = new Set(run.map((e) => splitAssText(e.rawText).visible));
			const uniqueRatio = texts.size / run.length;
			if (run.length >= opts.minRun && uniqueRatio >= 0.5) {
				for (const e of run) skip.add(e.lineNo);
			}
			run = [];
		};
		for (const ev of arr) {
			const prev = run[run.length - 1];
			if (prev && ev.startMs - prev.endMs > opts.maxGapMs) flush();
			run.push(ev);
		}
		flush();
	}
	return skip;
}

/**
 * Distance between two sign texts counting only letter↔letter substitutions
 * (scramble/typewriter noise). Null when lengths differ or any differing
 * position involves a digit, punctuation, or non-ASCII character - those are
 * real content changes ("Floor 1" vs "Floor 2" must never merge).
 */
export function scrambleDistance(a: string, b: string, max: number): number | null {
	if (a.length !== b.length) return null;
	let d = 0;
	for (let i = 0; i < a.length; i++) {
		if (a[i] === b[i]) continue;
		if (!/[a-z]/i.test(a[i]!) || !/[a-z]/i.test(b[i]!)) return null;
		if (++d > max) return null;
	}
	return d;
}

export interface SignEventInput {
	lineNo: number;
	startMs: number;
	endMs: number;
	visible: string;
	/** Cluster grouping key, typically `${style}\u0000${name}`. */
	group: string;
}

export interface SignCluster {
	/** Longest-duration member (ties → latest); its text is what gets translated. */
	representative: SignEventInput;
	members: SignEventInput[];
}

/**
 * Group sign events into clusters sharing one translation. Exact text repeats
 * merge unconditionally (preserves the old dedup semantics for animated
 * typesetting); scramble variants merge only within `windowMs` of the cluster
 * and within `maxSubs` letter substitutions of its first-seen text.
 */
export function clusterSignEvents(signs: SignEventInput[], opts = { maxSubs: 2, windowMs: 5000 }): SignCluster[] {
	interface Open {
		anchor: string;
		lastEndMs: number;
		members: SignEventInput[];
	}
	const byGroup = new Map<string, SignEventInput[]>();
	for (const s of signs) {
		let arr = byGroup.get(s.group);
		if (!arr) byGroup.set(s.group, (arr = []));
		arr.push(s);
	}

	const clusters: SignCluster[] = [];
	for (const arr of byGroup.values()) {
		arr.sort((x, y) => x.startMs - y.startMs || x.endMs - y.endMs);
		const open: Open[] = [];
		const exactByText = new Map<string, Open>();

		for (const ev of arr) {
			let hit = exactByText.get(ev.visible);
			if (!hit) {
				for (const c of open) {
					if (ev.startMs - c.lastEndMs > opts.windowMs) continue;
					if (scrambleDistance(ev.visible, c.anchor, opts.maxSubs) !== null) {
						hit = c;
						break;
					}
				}
			}
			if (hit) {
				hit.members.push(ev);
				hit.lastEndMs = Math.max(hit.lastEndMs, ev.endMs);
				if (!exactByText.has(ev.visible)) exactByText.set(ev.visible, hit);
			} else {
				const c: Open = { anchor: ev.visible, lastEndMs: ev.endMs, members: [ev] };
				open.push(c);
				exactByText.set(ev.visible, c);
			}
		}

		for (const c of open) {
			let rep = c.members[0]!;
			for (const m of c.members) {
				const dm = m.endMs - m.startMs;
				const dr = rep.endMs - rep.startMs;
				if (dm > dr || (dm === dr && m.startMs > rep.startMs)) rep = m;
			}
			clusters.push({ representative: rep, members: c.members });
		}
	}
	return clusters;
}

async function translateAss(content: string, opts: TranslateContentOptions): Promise<string> {
	const { events } = parseAssEvents(content);

	const dialogueOnly = !opts.translateSignsSongs;
	const isDialogue = opts.isDialogueStyle ?? (() => true);
	const READABLE_MS = 500;

	const units: Unit[] = [];
	const leadByKey = new Map<number, string>();
	const evByLineNo = new Map<number, AssEventLine>();
	const signInputs: SignEventInput[] = [];
	let skippedSigns = 0;

	const { signs: letterSigns, consumed: letterConsumed } = reconstructLetterSigns(events, isDialogue);
	const letterSignByRep = new Map(letterSigns.map((s) => [s.representativeLineNo, s]));

	for (const ev of events) {
		if (letterConsumed.has(ev.lineNo)) {
			const sign = letterSignByRep.get(ev.lineNo);
			if (!sign) continue;
			leadByKey.set(ev.lineNo, sign.replacementLead);
			evByLineNo.set(ev.lineNo, ev);
			signInputs.push({ lineNo: ev.lineNo, startMs: sign.startMs, endMs: sign.endMs, visible: sign.text, group: `${ev.style}\u0000${ev.name}\u0000letters` });
			continue;
		}

		const dialogue = isDialogue(ev.style);
		if (dialogueOnly && !dialogue) continue;
		const parts = splitAssText(ev.rawText);
		if (!parts.translatable) continue;

		if (!dialogue && (isSingleCharSign(parts.visible) || isNoiseSign(parts.visible, ev.endMs - ev.startMs))) {
			skippedSigns++;
			continue;
		}

		leadByKey.set(ev.lineNo, parts.lead);

		if (dialogue) {
			units.push({
				key: ev.lineNo,
				startMs: ev.startMs,
				endMs: ev.endMs,
				visible: parts.visible,
				lead: parts.lead,
				name: ev.name || undefined,
				dialogue: true,
			});
		} else {
			evByLineNo.set(ev.lineNo, ev);
			signInputs.push({ lineNo: ev.lineNo, startMs: ev.startMs, endMs: ev.endMs, visible: parts.visible, group: `${ev.style}\u0000${ev.name}` });
		}
	}

	// Exact repeats and scramble variants collapse into clusters, each
	// translated once from its most readable (longest-held) member.
	const clusters = clusterSignEvents(signInputs);

	// Clusters with no readably-held member are flicker: per-frame text nobody
	// can read (e.g. non-ASCII grain isNoiseSign can't see). Those go to the
	// language-agnostic churn detector; everything flagged stays verbatim.
	const keptClusters: SignCluster[] = [];
	const flickerEvents: AssEventLine[] = [];
	const flickerClusters: SignCluster[] = [];
	for (const c of clusters) {
		if (c.members.some((m) => m.endMs - m.startMs >= READABLE_MS)) {
			keptClusters.push(c);
		} else {
			flickerClusters.push(c);
			for (const m of c.members) flickerEvents.push(evByLineNo.get(m.lineNo)!);
		}
	}
	const churn = findFrameChurnEvents(flickerEvents, isDialogue);
	for (const c of flickerClusters) {
		if (c.members.every((m) => churn.has(m.lineNo))) skippedSigns += c.members.length;
		else keptClusters.push(c); // short but legit sign (e.g. a lone 300ms stamp)
	}

	for (const c of keptClusters) {
		const rep = c.representative;
		units.push({
			key: rep.lineNo,
			startMs: rep.startMs,
			endMs: rep.endMs,
			visible: rep.visible,
			lead: leadByKey.get(rep.lineNo) ?? "",
			name: evByLineNo.get(rep.lineNo)?.name || undefined,
			dialogue: false,
		});
	}
	units.sort((a, b) => a.startMs - b.startMs); // planChunks expects chronological order

	if (skippedSigns > 0 || signInputs.length > keptClusters.length) {
		Logger.info(`[translate] Skipped ${skippedSigns} noise/churn sign event(s); ${keptClusters.length} sign cluster(s) translated once each`);
	}

	if (units.length === 0) {
		Logger.info("[translate] ASS source has no translatable lines. Emitting a copy.");
		return content;
	}

	const translatedVisible = await translateUnits(units, opts);

	const newTextByLineNo = new Map<number, string>();
	for (const [key, visible] of translatedVisible) {
		newTextByLineNo.set(key, joinAssText(leadByKey.get(key) ?? "", visible));
	}
	for (const c of keptClusters) {
		const t = translatedVisible.get(c.representative.lineNo);
		if (t === undefined) continue;
		for (const m of c.members) {
			const sign = letterSignByRep.get(m.lineNo);
			if (sign) {
				for (const [lineNo, text] of letterSignReplacementTexts(sign, t)) {
					newTextByLineNo.set(lineNo, text);
				}
			} else {
				newTextByLineNo.set(m.lineNo, joinAssText(leadByKey.get(m.lineNo) ?? "", t));
			}
		}
	}

	return buildTranslatedAss(content, newTextByLineNo, events);
}

async function translateSrt(content: string, opts: TranslateContentOptions): Promise<string> {
	const cues = parseSrt(content);

	const units: Unit[] = [];
	cues.forEach((cue, i) => {
		// Flatten internal breaks so each cue is a single batch line; players
		// re-wrap. (ASS preserves layout; SRT trades wrapping for reliable
		// batch alignment.)
		const visible = cue.text.replace(/\r?\n/g, " ").trim();
		if (visible === "") return;
		units.push({ key: i, startMs: cue.startMs, endMs: cue.endMs, visible, lead: "", dialogue: true });
	});

	if (units.length === 0) return content;

	const translated = await translateUnits(units, opts);
	for (const [i, text] of translated) {
		cues[i]!.text = text;
	}

	return buildSrt(cues);
}

// Target-language planning

export interface KeptSubDescriptor {
	index: number;
	codec: string;
	/** Effective language tag (honorifics already mapped to its base, e.g. "en-JP"). */
	language: string;
	/** full | honorifics | forced | sdh | commentary | storyboard */
	trackType: string;
}

export interface TranslationProduction {
	/** Source track to translate from. */
	sourceIndex: number;
	sourceCodec: string;
	source: TranslateLang;
	/** Output MKV language tag (as requested by the user, normalized). */
	targetTag: string;
	target: TranslateLang;
	/** Mirror the source's dialogue role. */
	trackType: "full" | "honorifics";
}

export interface TranslationPlan {
	productions: TranslationProduction[];
	/** Human-readable reasons for anything skipped (for logging). */
	skipped: string[];
}

const TEXT_CODECS = new Set(["subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text", "subviewer", "microdvd"]);

/** Canonical language key for "does a full track in this language already exist". */
function langKey(tag: string | undefined, resolve: (t: string | undefined) => TranslateLang | null): string {
	const t = resolve(tag);
	if (t) return t.code;
	return normalizeTag(tag).split(/[-_]/)[0] || "und";
}

export interface PlanTargetOptions {
	/** Force this stream index as the translation source instead of auto-selecting. */
	forceSourceIndex?: number;
}

/**
 * Decide which target languages to produce and from which source track.
 *
 * Rules:
 *  - Source = `forceSourceIndex` when given (any text-based track), otherwise
 *    the first text-based `full` or `honorifics` track.
 *  - A target language is skipped if a `full` or `honorifics` track already
 *    exists for it (either counts), or if it equals the source language.
 *  - Untranslatable languages (outside the model's set) are skipped with a note.
 *  - The produced track mirrors the source role: honorifics source →
 *    honorifics output; any other source type → full output.
 */
export function planTargetLanguages(tracks: KeptSubDescriptor[], targetTags: string[], options: PlanTargetOptions = {}): TranslationPlan {
	const skipped: string[] = [];
	const productions: TranslationProduction[] = [];

	const resolve: (t: string | undefined) => TranslateLang | null = resolveTranslateLang;

	// Languages already covered by a dialogue-bearing full/honorifics track.
	const existing = new Set<string>();
	for (const track of tracks) {
		if (track.trackType === "full" || track.trackType === "honorifics") {
			existing.add(langKey(track.language, resolve));
		}
	}

	// Source selection: explicit override first (safety-net fallback to auto),
	// then the first eligible dialogue-bearing text track.
	let source: KeptSubDescriptor | undefined;
	if (options.forceSourceIndex != null) {
		const forced = tracks.find((t) => t.index === options.forceSourceIndex);
		if (!forced) {
			skipped.push(`Forced source track ${options.forceSourceIndex} not found. Falling back to auto selection.`);
		} else if (!TEXT_CODECS.has(forced.codec.toLowerCase())) {
			skipped.push(`Forced source track ${options.forceSourceIndex} is not text-based (${forced.codec}). Falling back to auto selection.`);
		} else {
			source = forced;
		}
	}
	source ??= tracks.find((track) => (track.trackType === "full" || track.trackType === "honorifics") && TEXT_CODECS.has(track.codec.toLowerCase()));

	if (!source) {
		skipped.push("no text-based full or honorifics subtitle track available to translate from");
		return { productions, skipped };
	}

	const sourceLang = resolve(source.language);

	if (!sourceLang) {
		skipped.push(`source track language "${source.language}" could not be resolved to a translatable language`);
		return { productions, skipped };
	}

	// A forced SDH/forced/commentary source still produces a regular full track.
	const outputType: "full" | "honorifics" = source.trackType === "honorifics" ? "honorifics" : "full";

	const sourceKey = langKey(source.language, resolve);
	const seen = new Set<string>();

	for (const rawTag of targetTags) {
		const tag = rawTag.trim();
		if (!tag) continue;

		const target = resolve(tag);

		if (!target) {
			skipped.push(`${tag}: not a language the resolver recognizes`);
			continue;
		}

		const key = target.code;

		if (key === sourceKey) continue;

		if (existing.has(key)) {
			skipped.push(`${tag}: a full/honorifics track already exists`);
			continue;
		}

		if (seen.has(key)) continue;
		seen.add(key);

		productions.push({
			sourceIndex: source.index,
			sourceCodec: source.codec,
			source: sourceLang,
			targetTag: normalizeTag(tag),
			target,
			trackType: outputType,
		});
	}

	return { productions, skipped };
}
