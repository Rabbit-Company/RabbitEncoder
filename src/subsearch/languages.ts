/**
 * Languages OpenSubtitles had for at least 12 of 14 sampled movies, series
 * and anime episodes, ordered by how many viewers read them. Hindi and
 * Filipino are left out, they had subtitles for few of the titles.
 */
export const POPULAR_SUBTITLE_LANGUAGES = [
	"eng",
	"spa",
	"pt-BR",
	"fre",
	"ger",
	"ara",
	"rus",
	"ita",
	"chi",
	"ind",
	"jpn",
	"tur",
	"kor",
	"vie",
	"pol",
	"per",
	"dut",
	"tha",
	"zh-Hant",
	"ben",
	"may",
	"ukr",
	"rum",
	"gre",
	"cze",
	"hun",
	"swe",
	"heb",
	"por",
	"dan",
] as const;

/** How many of the most used languages may be added on top of the target languages. */
export const EXTRA_LANGUAGE_CHOICES = [0, 10, 20, 30] as const;

/** Extra languages are downloaded only while more than this many downloads are left today. */
export const EXTRA_LANGUAGE_RESERVE = 20;
