import { normalizeFontName } from "./ass-classifier";

export type FaceStyle = "regular" | "bold" | "italic" | "bold italic";

export interface FaceUsage {
	/** The styles text of the family is drawn in. */
	styles: Set<FaceStyle>;
	/** The code points drawn in the family, in any style. */
	codepoints: Set<number>;
}

interface StyleFont {
	font: string;
	bold: boolean;
	italic: boolean;
}

export function faceStyle(bold: boolean, italic: boolean): FaceStyle {
	return bold && italic ? "bold italic" : bold ? "bold" : italic ? "italic" : "regular";
}

/** libass reads -1 and 1 as bold, 0 as regular and anything larger as a weight. */
function isBold(value: number): boolean {
	return value === -1 || value === 1 || value >= 600;
}

function readStyles(lines: string[]): Map<string, StyleFont> {
	const styles = new Map<string, StyleFont>();
	let section = "";
	let format: string[] = [];
	for (const raw of lines) {
		const line = raw.trim();
		if (line.startsWith("[") && line.endsWith("]")) {
			section = line.slice(1, -1).trim().toLowerCase();
			continue;
		}
		if (section !== "v4+ styles" && section !== "v4 styles") continue;
		const colon = line.indexOf(":");
		if (colon < 0) continue;
		const key = line.slice(0, colon).trim().toLowerCase();
		const values = line
			.slice(colon + 1)
			.split(",")
			.map((v) => v.trim());
		if (key === "format") format = values.map((v) => v.toLowerCase());
		else if (key === "style" && format.length) {
			const d: Record<string, string> = {};
			format.forEach((k, i) => (d[k] = values[i] ?? ""));
			styles.set(d.name ?? "", { font: d.fontname ?? "", bold: isBold(Number(d.bold) || 0), italic: (Number(d.italic) || 0) !== 0 });
		}
	}
	return styles;
}

/**
 * Which faces the ASS documents draw text in, by family: the bold and italic
 * styles each family needs and the characters it draws. Follows style fonts,
 * inline \fn, \b, \i and \r overrides, and leaves drawings out. This is what a
 * family needs attached for every line to show in a real face, not a faked one.
 */
export function faceUsage(texts: readonly string[]): Map<string, FaceUsage> {
	const usage = new Map<string, FaceUsage>();
	const use = (font: string, bold: boolean, italic: boolean, text: string) => {
		const family = normalizeFontName(font);
		if (!family) return;
		let drawn = false;
		const codepoints: number[] = [];
		for (const ch of text) {
			const cp = ch.codePointAt(0)!;
			if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) continue;
			codepoints.push(cp);
			if (!/\s/u.test(ch)) drawn = true;
		}
		if (!drawn) return;
		let entry = usage.get(family);
		if (!entry) usage.set(family, (entry = { styles: new Set(), codepoints: new Set() }));
		entry.styles.add(faceStyle(bold, italic));
		for (const cp of codepoints) entry.codepoints.add(cp);
	};

	for (const doc of texts) {
		const lines = doc.split(/\r?\n/);
		const styles = readStyles(lines);
		let section = "";
		let format: string[] = [];
		for (const raw of lines) {
			const line = raw.trim();
			if (line.startsWith("[") && line.endsWith("]")) {
				section = line.slice(1, -1).trim().toLowerCase();
				continue;
			}
			if (section !== "events") continue;
			const colon = line.indexOf(":");
			if (colon < 0) continue;
			const key = line.slice(0, colon).trim().toLowerCase();
			if (key === "format") {
				format = line
					.slice(colon + 1)
					.split(",")
					.map((v) => v.trim().toLowerCase());
				continue;
			}
			if (key !== "dialogue" || !format.length) continue;
			const fields = line.slice(colon + 1).split(",");
			const textAt = format.indexOf("text");
			const styleAt = format.indexOf("style");
			if (textAt < 0 || fields.length < format.length) continue;
			const text = fields.slice(textAt).join(",");
			const styleName = (fields[styleAt] ?? "").trim().replace(/^\*/, "");
			const base = styles.get(styleName) ?? styles.get("Default");
			if (!base) continue;

			let { font, bold, italic } = base;
			let drawing = false;
			for (const m of text.matchAll(/\{([^}]*)\}|([^{]+)/g)) {
				if (m[1] !== undefined) {
					for (const tag of m[1].split("\\").slice(1)) {
						const t = tag.trim();
						let v: RegExpMatchArray | null;
						if ((v = t.match(/^fn(.*)$/))) font = v[1]!.trim() || base.font;
						else if ((v = t.match(/^b(\d*)$/))) bold = v[1] ? isBold(Number(v[1])) : base.bold;
						else if ((v = t.match(/^i(\d*)$/))) italic = v[1] ? Number(v[1]) !== 0 : base.italic;
						else if ((v = t.match(/^p(\d+)$/))) drawing = Number(v[1]) > 0;
						else if ((v = t.match(/^r(.*)$/))) {
							const reset = styles.get(v[1]!.trim()) ?? base;
							({ font, bold, italic } = reset);
						}
					}
				} else if (!drawing) {
					use(font, bold, italic, m[2]!.replace(/\\[Nn]/g, " ").replace(/\\h/g, " "));
				}
			}
		}
	}
	return usage;
}
