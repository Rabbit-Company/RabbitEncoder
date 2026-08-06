export const LANG_ALIASES: Record<string, string> = {
	// Japanese
	ja: "jpn",
	jpn: "jpn",
	japanese: "jpn",

	// English
	en: "eng",
	eng: "eng",
	english: "eng",

	// Spanish
	es: "spa",
	spa: "spa",
	spanish: "spa",
	"es-ES": "spa",
	"es-MX": "spa",
	"es-AR": "spa",
	"es-CO": "spa",
	"es-419": "spa",

	// French
	fr: "fra",
	fra: "fra",
	fre: "fra",
	french: "fra",

	// German
	de: "deu",
	deu: "deu",
	ger: "deu",
	german: "deu",

	// Italian
	it: "ita",
	ita: "ita",
	italian: "ita",

	// Portuguese
	pt: "por",
	por: "por",
	portuguese: "por",
	"pt-BR": "por",
	"pt-PT": "por",
	"pt-AO": "por",

	// Russian
	ru: "rus",
	rus: "rus",
	russian: "rus",

	// Korean
	ko: "kor",
	kor: "kor",
	korean: "kor",

	// Chinese
	zh: "zho",
	zho: "zho",
	chi: "zho",
	chinese: "zho",
	"zh-Hans": "zho",
	"zh-Hant": "zho",
	"zh-CN": "zho",
	"zh-TW": "zho",
	"zh-SG": "zho",
	"zh-HK": "zho",

	// Dutch
	nl: "nld",
	nld: "nld",
	dut: "nld",
	dutch: "nld",

	// Arabic
	ar: "ara",
	ara: "ara",
	arabic: "ara",

	// Hindi
	hi: "hin",
	hin: "hin",
	hindi: "hin",

	// Turkish
	tr: "tur",
	tur: "tur",
	turkish: "tur",

	// Polish
	pl: "pol",
	pol: "pol",
	polish: "pol",

	// Swedish
	sv: "swe",
	swe: "swe",
	swedish: "swe",

	// Norwegian
	no: "nor",
	nor: "nor",
	norwegian: "nor",

	// Danish
	da: "dan",
	dan: "dan",
	danish: "dan",

	// Finnish
	fi: "fin",
	fin: "fin",
	finnish: "fin",

	// Czech
	cs: "ces",
	ces: "ces",
	cze: "ces",
	czech: "ces",

	// Ukrainian
	uk: "ukr",
	ukr: "ukr",
	ukrainian: "ukr",

	// Thai
	th: "tha",
	tha: "tha",
	thai: "tha",

	// Vietnamese
	vi: "vie",
	vie: "vie",
	vietnamese: "vie",

	// Indonesian
	id: "ind",
	ind: "ind",
	indonesian: "ind",

	// Greek
	el: "ell",
	ell: "ell",
	gre: "ell",
	greek: "ell",

	// Hebrew
	he: "heb",
	heb: "heb",
	hebrew: "heb",

	// Hungarian
	hu: "hun",
	hun: "hun",
	hungarian: "hun",

	// Romanian
	ro: "ron",
	ron: "ron",
	rum: "ron",
	romanian: "ron",
};

/**
 * Infer an optical-disc source tag from the video stream's codec and resolution.
 * Returns null when the stream doesn't match any known disc format.
 *
 *   VCD:  MPEG-1, 352x240 (NTSC) / 352x288 (PAL)
 *   SVCD: MPEG-2, ≤480 wide, SD height
 *   DVD:  MPEG-2, >480 wide (720/704), SD height
 */
export function inferSourceFromStream(codec: string, width: number, height: number): string | null {
	if (height > 576) return null;

	const c = codec.toLowerCase();
	if (c === "mpeg1video") return "VCD";
	if (c === "mpeg2video") {
		if (width <= 480) return "SVCD";
		return "DVD";
	}
	return null;
}

/**
 * Detect the source tag from a filename (Bluray, WEBDL, WEBRip, etc.).
 * REMUX files are tagged as Bluray after re-encoding.
 */
export function detectSourceTag(filename: string): string {
	const upper = filename.toUpperCase();

	if (/\bREMUX\b/.test(upper)) return "Bluray";

	const sources = ["WEBDL", "WEBRIP", "BLURAY", "HDTV", "DVD", "SDTV", "CAM"] as const;

	for (const source of sources) {
		if (new RegExp(`\\b${source}\\b`).test(upper)) {
			switch (source) {
				case "BLURAY":
					return "Bluray";
				case "WEBRIP":
					return "WEBRip";
				case "WEBDL":
					return "WEBDL";
				case "HDTV":
					return "HDTV";
				case "DVD":
					return "DVD";
				case "SDTV":
					return "SDTV";
				case "CAM":
					return "CAM";
			}
		}
	}

	return "Bluray";
}

/**
 * Extract release group from the end of a filename.
 * Pattern: `]-GroupName` at the end of the stem.
 */
export function detectReleaseGroup(filename: string): string | null {
	const match = filename.match(/\]-([A-Za-z0-9._&-]+)$/);
	return match?.[1] ?? null;
}

/**
 * Map resolution dimensions to a standard tag (2160p, 1080p, 720p, etc.).
 */
export function getResolutionTag(width: number, height: number): string {
	if (width >= 3200 || height >= 2100) return "2160p";
	if (width >= 1800 || height >= 1000) return "1080p";
	if (width >= 1200 || height >= 700) return "720p";
	if (width >= 1000 || height >= 560) return "576p";
	if (width > 0 && height > 0) return "480p";
	return "1080p";
}

/**
 * Strip scene/release metadata from a filename stem to get the base title.
 *
 * Removes metadata conservatively:
 *   - IMDb ID metadata wherever it appears (`[imdbid-tt0983213]`)
 *   - a trailing release group   (`...[x265]-Judas`  -> `...[x265]`)
 *   - trailing `[...]` / `(...)` tag blocks, peeled off one at a time
 *   - any leftover trailing separator dash / whitespace
 *
 * It deliberately does NOT cut from the first `[`. Anime-style names lead with
 * the group (`[SubsPlease] Show - 01 [hash]`); cutting from the first bracket
 * there wipes the entire title, so every episode collapses to the same base
 * name and later encodes overwrite earlier ones. The episode/sequence portion
 * must survive so distinct inputs keep distinct names.
 *
 * Never returns an empty string: if stripping would leave nothing, the trimmed
 * original stem is returned unchanged.
 */
export function extractBaseTitle(stem: string): string {
	let s = stem.trim();

	// Media managers commonly include this identity tag between the title and
	// the release tags. It describes the file, but is not part of its title.
	s = s.replace(/\s*\[imdbid-tt\d+\]\s*/gi, " ").trim();

	// Trailing release group: `]-Group` -> `]`
	s = s.replace(/(\])-[A-Za-z0-9._&-]+$/, "$1");

	// Trailing bracketed / parenthesised tag blocks, peeled one at a time.
	let prev: string;
	do {
		prev = s;
		s = s.replace(/\s*[\[(][^\[\]()]*[\])]\s*$/, "").trimEnd();
	} while (s !== prev);

	// Leftover trailing separator (the dash that used to precede the tags).
	s = s.replace(/\s*[-–—]\s*$/, "").trim();

	return s.length > 0 ? s : stem.trim();
}
