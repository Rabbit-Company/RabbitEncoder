export type AssLineKind = "dialogue" | "sign" | "song";

export interface ClassifiedAssLine {
	style: string;
	text: string;
	kind: AssLineKind;
}

interface AssStyle {
	name: string;
	fontname: string;
	fontsize: number;
	alignment: number;
	marginL: number;
	marginR: number;
	marginV: number;
	borderStyle: number;
}

interface AssEvent {
	style: string;
	text: string;
}

interface ParsedAss {
	styles: AssStyle[];
	events: AssEvent[];
	playResX: number;
	playResY: number;
}

const NUM = (v: string | undefined, d: number): number => {
	const n = parseFloat(v ?? "");
	return Number.isFinite(n) ? n : d;
};

/** Canonical font-name normaliser shared across the styling/font code. */
export function normalizeFontName(name: string): string {
	return name.trim().toLowerCase().replace(/^@/, "");
}

/** Style names the classifier considers dialogue (baseline + structurally similar). */
export function dialogueStyleNames(assText: string): Set<string> {
	const { styles, events, playResX, playResY } = parseAss(assText);
	const usage = new Map<string, number>();
	const profiles = new Map<string, StyleProfile>();
	for (const ev of events) {
		if (!lineHasRenderableContent(ev.text)) continue;
		usage.set(ev.style, (usage.get(ev.style) ?? 0) + 1);
		updateStyleProfile(profiles, ev);
	}
	const baseline = pickBaselineStyle(styles, usage, profiles, playResX, playResY);
	const out = new Set<string>();
	for (const s of styles) {
		if ((usage.get(s.name) ?? 0) === 0) continue;
		if (classifyStyle(s, baseline, profiles.get(s.name), playResX, playResY) === "dialogue") out.add(s.name);
	}
	return out;
}

/**
 * Dialogue styles which are safe to rewrite as a whole. ASS styles are shared:
 * changing one Style line also changes every sign/song event that references
 * it. Fail closed when a meaningful share of a dialogue-classified style uses
 * explicit typesetting, drawing, or karaoke. A few clip-based dialogue
 * transitions are allowed; production fansubs use those on ordinary dialogue.
 */
export function restylableDialogueStyleNames(assText: string): Set<string> {
	const dialogue = dialogueStyleNames(assText);
	if (dialogue.size === 0) return dialogue;

	const { events, playResX, playResY } = parseAss(assText);
	const profiles = new Map<string, StyleProfile>();
	for (const ev of events) {
		if (!dialogue.has(ev.style) || !lineHasRenderableContent(ev.text)) continue;
		updateStyleProfile(profiles, ev);
	}
	for (const style of dialogue) {
		const profile = profiles.get(style);
		if (!profile || profile.total === 0) continue;
		const fracKara = profile.karaokeTag / profile.total;
		const fracComplexSign = profile.nonPositionSignTag / profile.total;
		const fracSign = profile.signTag / profile.total;
		const fracPositioned = profile.positions.length / profile.total;
		if (fracKara >= 0.2 || fracComplexSign >= 0.2 || fracSign >= 0.3 || (fracPositioned >= 0.2 && positionsLookTypeset(profile, playResX, playResY))) {
			dialogue.delete(style);
		}
	}
	return dialogue;
}

/** Fonts actually referenced by an ASS file: styles used by ≥1 event, plus inline \fn overrides. */
export function extractUsedFonts(assText: string): Set<string> {
	const { styles, events } = parseAss(assText);
	const renderedEvents = events.filter((e) => lineHasRenderableContent(e.text));
	const usedStyles = new Set(renderedEvents.map((e) => e.style));
	const fonts = new Set<string>();
	for (const s of styles) {
		if (usedStyles.has(s.name) && s.fontname) fonts.add(normalizeFontName(s.fontname));
	}
	for (const ev of renderedEvents) {
		for (const m of ev.text.matchAll(/\\fn([^\\}]+)/g)) {
			const f = m[1]!.trim();
			if (f) fonts.add(normalizeFontName(f));
		}
	}
	return fonts;
}

function parseAss(assText: string): ParsedAss {
	const styles: AssStyle[] = [];
	const events: AssEvent[] = [];
	let section = "";
	let styleKeys: string[] = [];
	let eventKeys: string[] = [];
	let playResX = 0;
	let playResY = 0;

	for (const rawLine of assText.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith(";") || line.startsWith("!:")) continue;

		if (line.startsWith("[") && line.endsWith("]")) {
			section = line.slice(1, -1).trim().toLowerCase();
			continue;
		}

		const lower = line.toLowerCase();
		if (section === "script info") {
			const mx = line.match(/^PlayResX\s*:\s*([0-9]+(?:\.[0-9]+)?)/i);
			if (mx) playResX = NUM(mx[1], 0);
			const my = line.match(/^PlayResY\s*:\s*([0-9]+(?:\.[0-9]+)?)/i);
			if (my) playResY = NUM(my[1], 0);
		}

		if (lower.startsWith("format:")) {
			const keys = line
				.substring(line.indexOf(":") + 1)
				.split(",")
				.map((k) => k.trim().toLowerCase());
			if (section === "v4+ styles" || section === "v4 styles") styleKeys = keys;
			else if (section === "events") eventKeys = keys;
			continue;
		}

		if ((section === "v4+ styles" || section === "v4 styles") && lower.startsWith("style:")) {
			if (styleKeys.length === 0) continue;
			const vals = line
				.substring(line.indexOf(":") + 1)
				.split(",")
				.map((v) => v.trim());
			if (vals.length < styleKeys.length) continue;
			const d: Record<string, string> = {};
			for (let i = 0; i < styleKeys.length; i++) d[styleKeys[i]!] = vals[i]!;
			styles.push({
				name: d.name ?? "",
				fontname: d.fontname ?? "",
				fontsize: NUM(d.fontsize, 40),
				alignment: Math.round(NUM(d.alignment, 2)),
				marginL: Math.round(NUM(d.marginl, 0)),
				marginR: Math.round(NUM(d.marginr, 0)),
				marginV: Math.round(NUM(d.marginv, 0)),
				borderStyle: Math.round(NUM(d.borderstyle, 1)),
			});
			continue;
		}

		if (section === "events" && lower.startsWith("dialogue:")) {
			if (eventKeys.length === 0) continue;
			const afterPrefix = line.substring(line.indexOf(":") + 1);
			// Text is the last field and may contain commas; keep them by splitting
			// into exactly eventKeys.length pieces.
			const parts: string[] = [];
			let remaining = afterPrefix;
			for (let i = 0; i < eventKeys.length - 1; i++) {
				const comma = remaining.indexOf(",");
				if (comma < 0) {
					parts.push(remaining);
					remaining = "";
					break;
				}
				parts.push(remaining.slice(0, comma));
				remaining = remaining.slice(comma + 1);
			}
			parts.push(remaining);
			if (parts.length < eventKeys.length) continue;
			const d: Record<string, string> = {};
			for (let i = 0; i < eventKeys.length; i++) d[eventKeys[i]!] = parts[i]!;
			events.push({
				style: (d.style ?? "").trim(),
				text: d.text ?? "",
			});
		}
	}

	return { styles, events, playResX, playResY };
}

const DIALOGUE_WORDS: ReadonlySet<string> = new Set([
	"default",
	"main",
	"alt",
	"top",
	"bottom",
	"italic",
	"italics",
	"italicstop",
	"flashback",
	"flashbackitalics",
	"flashbackitalic",
	"flashbacktop",
	"flashbackitalicstop",
	"narration",
	"narrator",
	"narrate",
	"thought",
	"thoughts",
	"thinking",
	"whisper",
	"whispers",
	"whispering",
	"offscreen",
	"os",
	"radio",
	"phone",
	"tv",
	"monitor",
	"overlap",
	"overlapping",
	"overlapped",
	"dialog",
	"dialogue",
	"subtitle",
	"subs",
]);

const SIGN_WORDS: ReadonlySet<string> = new Set([
	"sign",
	"signs",
	"typeset",
	"typesetting",
	"ts",
	"screen",
	"onscreen",
	"caption",
	"captions",
	"credit",
	"credits",
	"eyecatch",
	"note",
	"notes",
	"tlnote",
	"tlnotes",
	"title",
	"titles",
	"eptitle",
	"episodetitle",
	"titlecard",
	"logo",
	"preview",
	"chapter",
]);

const SONG_WORDS: ReadonlySet<string> = new Set([
	"op",
	"ed",
	"opening",
	"ending",
	"song",
	"songs",
	"karaoke",
	"kara",
	"lyric",
	"lyrics",
	"romaji",
	"romanji",
	"kanji",
	"insert",
	"insertsong",
]);

// If the entire name (with separators stripped) starts with one of these, it's
// dialogue. Catches run-together variants like "flashbackitalicstop".
const DIALOGUE_PREFIX_ANCHORS = ["flashback", "narrat", "thought", "whisper", "dialog"] as const;

// `sign_`, `sign-`, `sign `, `signs_` etc. - the canonical Aegisub typeset
// style-naming convention.
const SIGN_PREFIX_RE = /^sign[s_\- ]/i;

const CAMEL_SPLIT_RE = /[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+/g;

function tokenizeStyleName(name: string): string[] {
	if (!name) return [];
	const parts = name.trim().split(/[\s_\-]+/);
	const tokens: string[] = [];
	for (const p of parts) {
		if (!p) continue;
		const matches = p.match(CAMEL_SPLIT_RE);
		if (matches && matches.length > 0) tokens.push(...matches);
		else tokens.push(p);
	}
	return tokens.map((t) => t.toLowerCase()).filter((t) => t.length > 0);
}

type NameVerdict = { kind: AssLineKind | null; strength: "strong" | "weak" | null };

function classifyStyleName(name: string): NameVerdict {
	const raw = name.trim();
	if (!raw) return { kind: null, strength: null };

	const tokens = tokenizeStyleName(raw);
	if (tokens.length === 0) return { kind: null, strength: null };
	const first = tokens[0]!;
	const tokenSet = new Set(tokens);
	const concat = raw.toLowerCase().replace(/[\s_\-]+/g, "");

	// Songs first - OP/ED styles often carry positional words ("top") that
	// would otherwise look sign-ish.
	if (SONG_WORDS.has(first)) return { kind: "song", strength: "strong" };

	// Canonical `sign_*` prefix is authoritative.
	if (SIGN_PREFIX_RE.test(raw)) return { kind: "sign", strength: "strong" };
	if (SIGN_WORDS.has(first)) return { kind: "sign", strength: "strong" };

	// Dialogue by exact first-token match.
	if (DIALOGUE_WORDS.has(first)) return { kind: "dialogue", strength: "strong" };

	// Dialogue by concat-prefix anchor ("flashbackitalicstop").
	for (const anchor of DIALOGUE_PREFIX_ANCHORS) {
		if (concat.startsWith(anchor)) return { kind: "dialogue", strength: "strong" };
	}

	// Weaker - keyword appears somewhere but not as the head token.
	for (const t of tokenSet) {
		if (SONG_WORDS.has(t)) return { kind: "song", strength: "weak" };
	}
	for (const t of tokenSet) {
		if (SIGN_WORDS.has(t)) return { kind: "sign", strength: "weak" };
	}

	return { kind: null, strength: null };
}

// Strong typeset tags. Used in the per-style profile; we don't upgrade
// individual lines on these alone, because overlapping dialogue occasionally
// carries \pos.
const STRONG_SIGN_TAG_RE = /\\(?:pos|move|clip|iclip|p[1-9]|org)\b/i;

// Tags whose presence is strong typesetting evidence independently of where
// the event is positioned. `pos` is considered separately so a small number of
// intentionally positioned dialogue lines does not poison an otherwise normal
// dialogue style.
const NON_POSITION_SIGN_TAG_RE = /\\(?:move|clip|iclip|p[1-9]|org)\b/i;

// Karaoke tags - an extremely strong per-line signal.
const KARAOKE_TAG_RE = /\\k[fo]?\d+/i;

// Vector-drawing command in the body (after override removal).
const DRAWING_TEXT_RE = /\bm\s+-?\d+\s+-?\d+\s+l\s+-?\d+/i;

const OVERRIDE_BLOCK_RE = /\{[^}]*\}/g;

/** Ignore empty/tag-only events: they render no glyphs and use no font. */
function lineHasRenderableContent(text: string): boolean {
	return (
		text
			.replace(OVERRIDE_BLOCK_RE, "")
			.replace(/\\[Nnh]/g, "")
			.trim().length > 0
	);
}

function lineHasKaraoke(text: string): boolean {
	return KARAOKE_TAG_RE.test(text);
}

function lineHasSignTags(text: string): boolean {
	if (STRONG_SIGN_TAG_RE.test(text)) return true;
	const stripped = text.replace(OVERRIDE_BLOCK_RE, "");
	return DRAWING_TEXT_RE.test(stripped);
}

function lineHasNonPositionSignTags(text: string): boolean {
	if (NON_POSITION_SIGN_TAG_RE.test(text)) return true;
	const stripped = text.replace(OVERRIDE_BLOCK_RE, "");
	return DRAWING_TEXT_RE.test(stripped);
}

interface AssPoint {
	x: number;
	y: number;
}

const ASS_COORD = "(-?(?:\\d+(?:\\.\\d*)?|\\.\\d+))";
const POS_RE = new RegExp(`\\\\pos\\(\\s*${ASS_COORD}\\s*,\\s*${ASS_COORD}\\s*\\)`, "i");
const MOVE_RE = new RegExp(`\\\\move\\(\\s*${ASS_COORD}\\s*,\\s*${ASS_COORD}\\s*,\\s*${ASS_COORD}\\s*,\\s*${ASS_COORD}`, "i");

/** Return the rendered destination of an explicit \pos/\move override. */
function linePosition(text: string): AssPoint | null {
	const pos = POS_RE.exec(text);
	if (pos) return { x: NUM(pos[1], 0), y: NUM(pos[2], 0) };
	const move = MOVE_RE.exec(text);
	if (move) return { x: NUM(move[3], 0), y: NUM(move[4], 0) };
	return null;
}

const COMMON_DIALOGUE_FONTS: ReadonlySet<string> = new Set([
	"arial",
	"arial unicode ms",
	"helvetica",
	"helvetica neue",
	"roboto",
	"open sans",
	"noto sans",
	"source sans pro",
	"source sans 3",
	"gandhi sans",
	"calibri",
	"ubuntu",
	"liberation sans",
	"dejavu sans",
	"verdana",
	"trebuchet ms",
	"tahoma",
	"gotham",
	"avenir",
	"segoe ui",
	"adobe arabic",
	"arial arabic",
	"scheherazade",
	"ms pgothic",
	"meiryo",
	"yu gothic",
	"source han sans",
	"times new roman",
	"georgia",
	"cambria",
]);

function normalizeFont(name: string): string {
	return name.trim().toLowerCase().replace(/^@/, "");
}

function pickBaselineStyle(
	styles: AssStyle[],
	usage: Map<string, number>,
	profiles: Map<string, StyleProfile>,
	playResX: number,
	playResY: number,
): AssStyle | null {
	if (styles.length === 0) return null;

	const candidates = styles.filter((s) => {
		if ((usage.get(s.name) ?? 0) <= 0) return false;
		if (s.alignment !== 2 && s.alignment !== 8) return false;
		if (s.borderStyle !== 1 && s.borderStyle !== 3) return false;
		const { kind } = classifyStyleName(s.name);
		if (kind === "sign" || kind === "song") return false;
		return strongProfileVerdict(profiles.get(s.name), playResX, playResY) === null;
	});

	if (candidates.length > 0) {
		const mostUsed = candidates.reduce((best, s) => ((usage.get(s.name) ?? 0) > (usage.get(best.name) ?? 0) ? s : best));
		const mostUsedCount = usage.get(mostUsed.name) ?? 0;

		// Aegisub files sometimes retain an almost-unused `Default` style while
		// the real dialogue lives in a release-specific style such as
		// `GJM_Main_1080p`. Prefer the conventional exact names only when their
		// usage is substantial enough to be representative.
		for (const preferred of ["main", "default"]) {
			const hit = candidates.find((s) => s.name.trim().toLowerCase() === preferred);
			const hitCount = hit ? (usage.get(hit.name) ?? 0) : 0;
			if (hit && hitCount >= 5 && hitCount >= mostUsedCount * 0.25) return hit;
		}

		return mostUsed;
	}

	const used = styles.filter((s) => (usage.get(s.name) ?? 0) > 0);
	if (used.length === 0) return null;
	return used.reduce((best, s) => ((usage.get(s.name) ?? 0) > (usage.get(best.name) ?? 0) ? s : best));
}

function marginClose(a: number, b: number, floor: number): boolean {
	return Math.abs(a - b) <= Math.max(floor, Math.abs(b) * 0.5);
}

function structurallySimilar(style: AssStyle, baseline: AssStyle, strict: boolean): boolean {
	if (style.alignment !== 2 && style.alignment !== 8 && style.alignment !== 4 && style.alignment !== 5 && style.alignment !== 6) return false;
	if (style.borderStyle !== 1 && style.borderStyle !== 3) return false;

	const bf = normalizeFont(baseline.fontname);
	const sf = normalizeFont(style.fontname);
	const sameFont = bf !== "" && bf === sf;
	if (strict && !sameFont) return false;
	if (!sameFont && !(COMMON_DIALOGUE_FONTS.has(bf) && COMMON_DIALOGUE_FONTS.has(sf))) return false;

	if (baseline.fontsize > 0) {
		const ratio = style.fontsize / baseline.fontsize;
		if (ratio < 0.6 || ratio > 1.4) return false;
	}

	if (!marginClose(style.marginL, baseline.marginL, 60)) return false;
	if (!marginClose(style.marginR, baseline.marginR, 60)) return false;
	if (!marginClose(style.marginV, baseline.marginV, 80)) return false;

	// Dialogue is usually left/right symmetric.
	if (Math.abs(style.marginL - style.marginR) > 100) return false;

	return true;
}

interface StyleProfile {
	total: number;
	signTag: number;
	nonPositionSignTag: number;
	karaokeTag: number;
	positions: AssPoint[];
}

function updateStyleProfile(profiles: Map<string, StyleProfile>, ev: AssEvent): void {
	let p = profiles.get(ev.style);
	if (!p) {
		p = { total: 0, signTag: 0, nonPositionSignTag: 0, karaokeTag: 0, positions: [] };
		profiles.set(ev.style, p);
	}
	p.total++;
	if (lineHasSignTags(ev.text)) p.signTag++;
	if (lineHasNonPositionSignTags(ev.text)) p.nonPositionSignTag++;
	if (lineHasKaraoke(ev.text)) p.karaokeTag++;
	const position = linePosition(ev.text);
	if (position) p.positions.push(position);
}

function positionsLookTypeset(profile: StyleProfile, playResX: number, playResY: number): boolean {
	if (profile.positions.length < 2 || playResX <= 0 || playResY <= 0) return false;

	const xs = profile.positions.map((p) => p.x / playResX);
	const ys = profile.positions.map((p) => p.y / playResY);
	const xSpread = Math.max(...xs) - Math.min(...xs);
	const ySpread = Math.max(...ys) - Math.min(...ys);
	const outsideDialogueBands = xs.filter((x, i) => {
		const y = ys[i]!;
		const horizontallyCentred = x >= 0.2 && x <= 0.8;
		const inTopOrBottomBand = y <= 0.22 || y >= 0.78;
		return !horizontallyCentred || !inTopOrBottomBand;
	}).length;

	return xSpread >= 0.25 || ySpread >= 0.2 || outsideDialogueBands / profile.positions.length >= 0.5;
}

function strongProfileVerdict(profile: StyleProfile | undefined, playResX: number, playResY: number): AssLineKind | null {
	if (!profile || profile.total === 0) return null;
	const fracKara = profile.karaokeTag / profile.total;
	const fracComplexSign = profile.nonPositionSignTag / profile.total;
	const fracSign = profile.signTag / profile.total;
	const fracPositioned = profile.positions.length / profile.total;

	// These checks intentionally run before style-name and baseline acceptance:
	// a sign-only script often calls its only style `Default`.
	if (fracKara >= 0.8) return "song";
	if (fracComplexSign >= 0.5) return "sign";
	if (fracSign >= 0.8) return "sign";
	if (fracPositioned >= 0.5 && positionsLookTypeset(profile, playResX, playResY)) return "sign";
	return null;
}

function classifyStyle(style: AssStyle, baseline: AssStyle | null, profile: StyleProfile | undefined, playResX: number, playResY: number): AssLineKind {
	const { kind, strength } = classifyStyleName(style.name);
	if (kind === "song") return "song";
	const strongProfile = strongProfileVerdict(profile, playResX, playResY);
	if (strongProfile !== null) return strongProfile;

	if (kind === "sign") {
		if (strength === "weak" && baseline !== null && structurallySimilar(style, baseline, true)) {
			return "dialogue";
		}
		return "sign";
	}

	if (kind === "dialogue") return "dialogue";

	// Structural fallback.
	if (baseline !== null && style.name !== baseline.name && structurallySimilar(style, baseline, true)) {
		return "dialogue";
	}
	if (baseline !== null && style.name === baseline.name) return "dialogue";

	// Line-tag profile fallback.
	if (profile && profile.total > 0) {
		const fracKara = profile.karaokeTag / profile.total;
		const fracSign = profile.signTag / profile.total;
		if (fracKara >= 0.3) return "song";
		if (fracSign >= 0.5) return "sign";
	}

	// Structural sign indicators.
	if (style.alignment !== 2 && style.alignment !== 8) return "sign";
	if (Math.abs(style.marginL - style.marginR) > 100) return "sign";

	// Last-resort font match.
	if (baseline !== null && normalizeFont(baseline.fontname) === normalizeFont(style.fontname)) {
		return "dialogue";
	}

	return "sign";
}

export function classifyAssLines(assText: string): ClassifiedAssLine[] {
	const { styles, events, playResX, playResY } = parseAss(assText);

	const usage = new Map<string, number>();
	const profiles = new Map<string, StyleProfile>();
	for (const ev of events) {
		if (!lineHasRenderableContent(ev.text)) continue;
		usage.set(ev.style, (usage.get(ev.style) ?? 0) + 1);
		updateStyleProfile(profiles, ev);
	}

	const baseline = pickBaselineStyle(styles, usage, profiles, playResX, playResY);

	const styleKinds = new Map<string, AssLineKind>();
	for (const s of styles) {
		styleKinds.set(s.name, classifyStyle(s, baseline, profiles.get(s.name), playResX, playResY));
	}

	const result: ClassifiedAssLine[] = [];
	for (const ev of events) {
		if (!lineHasRenderableContent(ev.text)) continue;
		let kind = styleKinds.get(ev.style);
		if (kind === undefined) {
			// Event references an undeclared style - fall back to name-only.
			const { kind: nk } = classifyStyleName(ev.style);
			kind = nk ?? "sign";
		}
		// Per-line karaoke upgrade.
		if (lineHasKaraoke(ev.text)) kind = "song";
		result.push({ style: ev.style, text: ev.text, kind });
	}

	return result;
}
