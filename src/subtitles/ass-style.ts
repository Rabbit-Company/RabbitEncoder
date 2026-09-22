import pkg from "../../package.json";
import { restylableDialogueStyleNames } from "./ass-classifier";
import type { SubtitleStyle } from "../core/types";

export const ASS_SIGNATURE_KEY = "RabbitEncoder";
const TOOL_VERSION: string = pkg.version;

/**
 * Format a scaled number for an ASS field: round to at most 3 decimals and drop
 * trailing zeros so we emit "108" / "2.5" rather than "108.000" / "2.50".
 */
const tidy = (n: number): string => String(parseFloat(n.toFixed(3)));

/**
 * Column overwriters, resolved from the Format line (names are case-insensitive).
 * `sx` / `sy` are the PlayResX/1920 and PlayResY/1080 scale factors: the style
 * values live in 1080p space, so pixel-bearing fields are rescaled to the file's
 * own PlayRes. Width-axis fields use `sx`, height-axis fields use `sy`, and
 * unitless fields (colours, alignment, bold, font name) ignore both.
 */
const RESTYLE_COLUMNS: Record<string, (s: SubtitleStyle, sx: number, sy: number) => string> = {
	fontname: (s) => s.fontName,
	fontsize: (s, _sx, sy) => tidy(s.fontSize * sy),
	primarycolour: (s) => s.primaryColour,
	outlinecolour: (s) => s.outlineColour,
	backcolour: (s) => s.backColour,
	bold: (s) => (s.bold ? "-1" : "0"),
	outline: (s, _sx, sy) => tidy(s.outline * sy),
	shadow: (s, _sx, sy) => tidy(s.shadow * sy),
	marginl: (s, sx) => tidy(s.marginL * sx),
	marginr: (s, sx) => tidy(s.marginR * sx),
	marginv: (s, _sx, sy) => tidy(s.marginV * sy),
};

type AlignRow = "bottom" | "middle" | "top";

/**
 * Split an alignment into vertical row and horizontal column (0 = left,
 * 1 = centre, 2 = right). V4+ uses numpad 1-9; legacy V4 (SSA) uses 1-3
 * bottom, 5-7 top and 9-11 middle. Returns null for anything unrecognised.
 */
function splitAlignment(value: number, legacy: boolean): { row: AlignRow; col: number } | null {
	if (!Number.isInteger(value)) return null;
	if (legacy) {
		const base = [1, 5, 9].find((b) => value >= b && value <= b + 2);
		if (base === undefined) return null;
		return { row: base === 1 ? "bottom" : base === 5 ? "top" : "middle", col: value - base };
	}
	if (value < 1 || value > 9) return null;
	const rows: AlignRow[] = ["bottom", "middle", "top"];
	return { row: rows[Math.floor((value - 1) / 3)]!, col: (value - 1) % 3 };
}

function joinAlignment(row: AlignRow, col: number, legacy: boolean): number {
	if (legacy) return (row === "bottom" ? 1 : row === "top" ? 5 : 9) + col;
	return (row === "bottom" ? 0 : row === "middle" ? 3 : 6) + col + 1;
}

/**
 * Alignment for a restyled dialogue style. The style's own vertical row is kept
 * so top-placed dialogue (e.g. a `Top` style at \an8 used while something else
 * occupies the bottom) stays at the top; only the horizontal column follows the
 * configured style. Middle-row and unparseable alignments are left untouched,
 * since those are deliberate choices we can't safely second-guess.
 */
function restyledAlignment(original: string, configured: number, legacy: boolean): string {
	const orig = splitAlignment(Number(original.trim()), legacy);
	const want = splitAlignment(configured, false);
	if (!orig || !want || orig.row === "middle") return original.trim();
	return String(joinAlignment(orig.row, want.col, legacy));
}

/**
 * Insert or update the RabbitEncoder provenance line in [Script Info]. Stamped
 * into every ASS we write so downstream tooling (and re-runs) can tell a track
 * was built/restyled by RabbitEncoder and with which version.
 *
 * Idempotent: an existing line is replaced in place, so re-processing updates
 * the version instead of stacking duplicates. If the document has no Script
 * Info section, a minimal one is created at the top.
 */
export function stampSignature(assText: string, version: string = TOOL_VERSION): string {
	const sigLine = `${ASS_SIGNATURE_KEY}: ${version}`;
	const sigRe = new RegExp(`^${ASS_SIGNATURE_KEY}\\s*:`, "i");
	const out: string[] = [];
	let section = "";
	let scriptInfoIdx = -1;
	let replaced = false;
	for (const line of assText.split(/\r?\n/)) {
		const t = line.trim();
		if (/^\[.*\]$/.test(t)) {
			section = t.slice(1, -1).toLowerCase();
			out.push(line);
			if (section === "script info") scriptInfoIdx = out.length - 1;
			continue;
		}
		if (section === "script info" && sigRe.test(t)) {
			out.push(sigLine);
			replaced = true;
			continue;
		}
		out.push(line);
	}
	if (!replaced) {
		if (scriptInfoIdx >= 0) out.splice(scriptInfoIdx + 1, 0, sigLine);
		else out.unshift("[Script Info]", sigLine, "");
	}
	return out.join("\n");
}

/**
 * Derive px scale factors for an existing ASS file from its Script Info PlayRes,
 * relative to the 1080p space the configured style values are authored in
 * (scaleX = PlayResX/1920, scaleY = PlayResY/1080).
 *
 * - Both present  -> use each axis independently.
 * - One present   -> mirror the missing axis from the present one (assumes the
 *                    common 16:9-ish case; better than dropping a scale to 1).
 * - Neither       -> (1, 1): leave values untouched so behaviour matches the
 *                    pre-scaling code rather than guessing a PlayRes (and we must
 *                    NOT inject a PlayRes here, as that would move every existing
 *                    sign/song positioned in the file's original coordinate space).
 */
function playResScale(assText: string): { scaleX: number; scaleY: number } {
	let section = "";
	let x = 0;
	let y = 0;
	for (const raw of assText.split(/\r?\n/)) {
		const t = raw.trim();
		if (/^\[.*\]$/.test(t)) {
			section = t.slice(1, -1).toLowerCase();
			continue;
		}
		if (section !== "script info") continue;
		const mx = t.match(/^PlayResX\s*:\s*([0-9]+(?:\.[0-9]+)?)/i);
		if (mx) x = parseFloat(mx[1]!);
		const my = t.match(/^PlayResY\s*:\s*([0-9]+(?:\.[0-9]+)?)/i);
		if (my) y = parseFloat(my[1]!);
	}
	let scaleX = x > 0 ? x / 1920 : 0;
	let scaleY = y > 0 ? y / 1080 : 0;
	if (scaleX === 0 && scaleY === 0) return { scaleX: 1, scaleY: 1 };
	if (scaleX === 0) scaleX = scaleY;
	if (scaleY === 0) scaleY = scaleX;
	return { scaleX, scaleY };
}

/**
 * V4+ Style line for a given style name. Field order is the ASS standard:
 * Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour,
 * BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing,
 * Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV,
 * Encoding. ASS bold is -1 (true) / 0 (false).
 */
function buildStyleLine(name: string, s: SubtitleStyle): string {
	const bold = s.bold ? "-1" : "0";
	return (
		`Style: ${name},${s.fontName},${s.fontSize},${s.primaryColour},&H000000FF,` +
		`${s.outlineColour},${s.backColour},${bold},0,0,0,100,100,0,0,1,` +
		`${s.outline},${s.shadow},${s.alignment},${s.marginL},${s.marginR},${s.marginV},1`
	);
}

/**
 * Patch an ffmpeg-generated SRT→ASS file: pin PlayRes to 1920×1080 (so px
 * sizes hold "at 1080p" and libass rescales to the real frame), enable scaled
 * borders/shadows, and replace the Default style with the configured look.
 */
export function styleSrtAss(assText: string, style: SubtitleStyle): string {
	const lines = assText.split(/\r?\n/);
	const out: string[] = [];
	let section = "";
	let scriptInfoIdx = -1;
	let hasPlayResX = false;
	let hasPlayResY = false;
	let hasScaled = false;
	let replacedDefault = false;
	let stylesHeaderIdx = -1;
	let stylesFormatIdx = -1;

	for (const line of lines) {
		const t = line.trim();
		if (/^\[.*\]$/.test(t)) {
			section = t.slice(1, -1).toLowerCase();
			out.push(line);
			if (section === "script info") scriptInfoIdx = out.length - 1;
			if (section === "v4+ styles" || section === "v4 styles") stylesHeaderIdx = out.length - 1;
			continue;
		}
		if (section === "script info") {
			if (/^PlayResX\s*:/i.test(t)) {
				out.push("PlayResX: 1920");
				hasPlayResX = true;
				continue;
			}
			if (/^PlayResY\s*:/i.test(t)) {
				out.push("PlayResY: 1080");
				hasPlayResY = true;
				continue;
			}
			if (/^ScaledBorderAndShadow\s*:/i.test(t)) {
				out.push("ScaledBorderAndShadow: yes");
				hasScaled = true;
				continue;
			}
		}
		if (section === "v4+ styles" || section === "v4 styles") {
			if (/^Format\s*:/i.test(t)) {
				out.push(line);
				stylesFormatIdx = out.length - 1;
				continue;
			}
			if (/^Style\s*:/i.test(t)) {
				const name = t
					.slice(t.indexOf(":") + 1)
					.split(",")[0]
					?.trim();
				if (name && name.toLowerCase() === "default") {
					out.push(buildStyleLine("Default", style));
					replacedDefault = true;
					continue;
				}
			}
		}
		out.push(line);
	}

	// If ffmpeg named the style something other than Default, add a Default style.
	if (!replacedDefault) {
		const insertAt = stylesFormatIdx >= 0 ? stylesFormatIdx + 1 : stylesHeaderIdx >= 0 ? stylesHeaderIdx + 1 : -1;
		if (insertAt >= 0) out.splice(insertAt, 0, buildStyleLine("Default", style));
	}

	// Backfill missing Script Info keys.
	const inject: string[] = [];
	if (!hasPlayResX) inject.push("PlayResX: 1920");
	if (!hasPlayResY) inject.push("PlayResY: 1080");
	if (!hasScaled) inject.push("ScaledBorderAndShadow: yes");
	if (inject.length && scriptInfoIdx >= 0) out.splice(scriptInfoIdx + 1, 0, ...inject);

	return stampSignature(out.join("\n"));
}

/**
 * Restyle dialogue-classified styles in an existing ASS file. The font is always
 * replaced; appearance columns (colours, border, shadow, alignment, margins) are
 * replaced too when `restyleAppearance` is true. Sign/song styles are left alone.
 * Alignment keeps each style's vertical row (see `restyledAlignment`), so
 * top-placed dialogue is not pushed to the bottom.
 *
 * The configured style values are authored in 1080p px. Existing ASS files keep
 * their own PlayRes (often 4K), so the pixel-bearing fields are scaled to that
 * PlayRes before injection — otherwise a 1080p fontSize/outline/margin would
 * render at half size on a 2160p script. We rescale our injected values to the
 * file rather than rewriting PlayRes, which would displace existing signs/songs.
 *
 * Files with no dialogue style are returned untouched (and left unstamped, since
 * nothing was modified).
 */
export function restyleAssDialogueFont(assText: string, style: SubtitleStyle, restyleAppearance: boolean): string {
	const dialogue = restylableDialogueStyleNames(assText);
	if (dialogue.size === 0) return assText;

	const { scaleX, scaleY } = playResScale(assText);

	const lines = assText.split(/\r?\n/);
	let section = "";
	let cols: string[] = [];
	const out = lines.map((line) => {
		const t = line.trim();
		if (/^\[.*\]$/.test(t)) {
			section = t.slice(1, -1).toLowerCase();
			return line;
		}
		if (section !== "v4+ styles" && section !== "v4 styles") return line;
		if (/^Format\s*:/i.test(t)) {
			cols = t
				.slice(t.indexOf(":") + 1)
				.split(",")
				.map((k) => k.trim().toLowerCase());
			return line;
		}
		if (/^Style\s*:/i.test(line) && cols.length) {
			const cut = line.indexOf(":") + 1;
			const values = line.slice(cut).split(",");
			const nameIdx = cols.indexOf("name");
			const name = (values[nameIdx] ?? "").trim();
			if (!dialogue.has(name)) return line;

			const setColumn = (colName: string, compute: (current: string) => string): void => {
				const idx = cols.indexOf(colName);
				if (idx < 0 || idx >= values.length) return;
				const lead = values[idx]!.match(/^\s*/)?.[0] ?? "";
				values[idx] = lead + compute(values[idx]!);
			};
			for (const [colName, getter] of Object.entries(RESTYLE_COLUMNS)) {
				if (colName !== "fontname" && !restyleAppearance) continue; // font always; rest only if asked
				setColumn(colName, () => getter(style, scaleX, scaleY));
			}
			if (restyleAppearance) {
				setColumn("alignment", (current) => restyledAlignment(current, style.alignment, section === "v4 styles"));
			}
			return line.slice(0, cut) + values.join(",");
		}
		return line;
	});
	return stampSignature(out.join("\n"));
}
