/** A language a picker offers. */
export interface LanguageEntry {
	name: string;
	/** BCP 47 tag, written to MKV language fields. */
	tag: string;
	/** ISO 639-2/B code, the legacy MKV code ffprobe reports, written to track filters and priorities. Variants use their tag. */
	code3: string;
	/** Every code this entry is known by, lowercased. */
	aliases: string[];
	/** A regional or script variant such as pt-BR. */
	variant: boolean;
	common: boolean;
}

// ISO 639-1, ISO 639-2/B, ISO 639-2/T when it differs, English name.
const ISO_639 = `aa aar - Afar
ab abk - Abkhazian
ae ave - Avestan
af afr - Afrikaans
ak aka - Akan
am amh - Amharic
an arg - Aragonese
ar ara - Arabic
as asm - Assamese
av ava - Avaric
ay aym - Aymara
az aze - Azerbaijani
ba bak - Bashkir
be bel - Belarusian
bg bul - Bulgarian
bi bis - Bislama
bm bam - Bambara
bn ben - Bengali
bo tib bod Tibetan
br bre - Breton
bs bos - Bosnian
ca cat - Catalan
ce che - Chechen
ch cha - Chamorro
co cos - Corsican
cr cre - Cree
cs cze ces Czech
cu chu - Church Slavic
cv chv - Chuvash
cy wel cym Welsh
da dan - Danish
de ger deu German
dv div - Divehi
dz dzo - Dzongkha
ee ewe - Ewe
el gre ell Greek
en eng - English
eo epo - Esperanto
es spa - Spanish
et est - Estonian
eu baq eus Basque
fa per fas Persian
ff ful - Fulah
fi fin - Finnish
fj fij - Fijian
fo fao - Faroese
fr fre fra French
fy fry - Western Frisian
ga gle - Irish
gd gla - Scottish Gaelic
gl glg - Galician
gn grn - Guarani
gu guj - Gujarati
gv glv - Manx
ha hau - Hausa
he heb - Hebrew
hi hin - Hindi
ho hmo - Hiri Motu
hr hrv - Croatian
ht hat - Haitian Creole
hu hun - Hungarian
hy arm hye Armenian
hz her - Herero
ia ina - Interlingua
id ind - Indonesian
ie ile - Interlingue
ig ibo - Igbo
ii iii - Sichuan Yi
ik ipk - Inupiaq
io ido - Ido
is ice isl Icelandic
it ita - Italian
iu iku - Inuktitut
ja jpn - Japanese
jv jav - Javanese
ka geo kat Georgian
kg kon - Kongo
ki kik - Kikuyu
kj kua - Kuanyama
kk kaz - Kazakh
kl kal - Kalaallisut
km khm - Khmer
kn kan - Kannada
ko kor - Korean
kr kau - Kanuri
ks kas - Kashmiri
ku kur - Kurdish
kv kom - Komi
kw cor - Cornish
ky kir - Kyrgyz
la lat - Latin
lb ltz - Luxembourgish
lg lug - Ganda
li lim - Limburgish
ln lin - Lingala
lo lao - Lao
lt lit - Lithuanian
lu lub - Luba-Katanga
lv lav - Latvian
mg mlg - Malagasy
mh mah - Marshallese
mi mao mri Maori
mk mac mkd Macedonian
ml mal - Malayalam
mn mon - Mongolian
mr mar - Marathi
ms may msa Malay
mt mlt - Maltese
my bur mya Burmese
na nau - Nauru
nb nob - Norwegian Bokmål
nd nde - North Ndebele
ne nep - Nepali
ng ndo - Ndonga
nl dut nld Dutch
nn nno - Norwegian Nynorsk
no nor - Norwegian
nr nbl - South Ndebele
nv nav - Navajo
ny nya - Chichewa
oc oci - Occitan
oj oji - Ojibwa
om orm - Oromo
or ori - Odia
os oss - Ossetian
pa pan - Punjabi
pi pli - Pali
pl pol - Polish
ps pus - Pashto
pt por - Portuguese
qu que - Quechua
rm roh - Romansh
rn run - Rundi
ro rum ron Romanian
ru rus - Russian
rw kin - Kinyarwanda
sa san - Sanskrit
sc srd - Sardinian
sd snd - Sindhi
se sme - Northern Sami
sg sag - Sango
si sin - Sinhala
sk slo slk Slovak
sl slv - Slovenian
sm smo - Samoan
sn sna - Shona
so som - Somali
sq alb sqi Albanian
sr srp - Serbian
ss ssw - Swati
st sot - Southern Sotho
su sun - Sundanese
sv swe - Swedish
sw swa - Swahili
ta tam - Tamil
te tel - Telugu
tg tgk - Tajik
th tha - Thai
ti tir - Tigrinya
tk tuk - Turkmen
tl tgl - Tagalog
tn tsn - Tswana
to ton - Tonga
tr tur - Turkish
ts tso - Tsonga
tt tat - Tatar
tw twi - Twi
ty tah - Tahitian
ug uig - Uyghur
uk ukr - Ukrainian
ur urd - Urdu
uz uzb - Uzbek
ve ven - Venda
vi vie - Vietnamese
vo vol - Volapük
wa wln - Walloon
wo wol - Wolof
xh xho - Xhosa
yi yid - Yiddish
yo yor - Yoruba
za zha - Zhuang
zh chi zho Chinese
zu zul - Zulu
- fil - Filipino
- yue - Cantonese
- mul - Multiple languages
- zxx - No linguistic content
- und - Undetermined`;

// Tag, English name. Each follows its base language in the list.
const VARIANTS = `ar-SA Arabic (Saudi Arabia)
ar-EG Arabic (Egypt)
ar-AE Arabic (United Arab Emirates)
de-DE German (Germany)
de-AT German (Austria)
de-CH German (Switzerland)
en-US English (United States)
en-GB English (United Kingdom)
en-AU English (Australia)
en-CA English (Canada)
en-JP English (with honorifics)
es-419 Spanish (Latin America)
es-ES Spanish (Spain)
es-MX Spanish (Mexico)
fr-FR French (France)
fr-CA French (Canada)
fr-BE French (Belgium)
it-IT Italian (Italy)
ja-JP Japanese (Japan)
ko-KR Korean (South Korea)
nl-BE Dutch (Belgium)
pt-BR Portuguese (Brazil)
pt-PT Portuguese (Portugal)
ru-RU Russian (Russia)
sr-Latn Serbian (Latin)
sr-Cyrl Serbian (Cyrillic)
zh-Hans Chinese (Simplified)
zh-Hant Chinese (Traditional)
zh-CN Chinese (China)
zh-TW Chinese (Taiwan)
zh-HK Chinese (Hong Kong)`;

const COMMON = new Set(["en", "ja", "zh", "ko", "es", "fr", "de", "it", "pt", "ru", "ar", "zh-Hans", "zh-Hant", "pt-BR", "es-419"]);

function buildCatalog(): LanguageEntry[] {
	const bases = ISO_639.split("\n").map((line): LanguageEntry => {
		const [a2, b, t, ...name] = line.split(" ") as [string, string, string, ...string[]];
		const tag = a2 === "-" ? b : a2;
		return {
			name: name.join(" "),
			tag,
			code3: b,
			aliases: [tag, b, ...(t === "-" ? [] : [t])].map((code) => code.toLowerCase()),
			variant: false,
			common: COMMON.has(tag),
		};
	});
	const out: LanguageEntry[] = [];
	const variants = VARIANTS.split("\n").map((line) => {
		const [tag, ...name] = line.split(" ") as [string, ...string[]];
		return { name: name.join(" "), tag, code3: tag, aliases: [tag.toLowerCase()], variant: true, common: COMMON.has(tag) };
	});
	for (const base of [...bases].sort((a, b) => a.name.localeCompare(b.name))) {
		out.push(base);
		out.push(...variants.filter((variant) => variant.tag.split("-")[0] === base.tag));
	}
	return out;
}

export const LANGUAGES: readonly LanguageEntry[] = buildCatalog();

const byAlias = new Map<string, LanguageEntry>();
for (const entry of LANGUAGES) for (const alias of entry.aliases) if (!byAlias.has(alias)) byAlias.set(alias, entry);

const displayNames = (() => {
	try {
		return new Intl.DisplayNames(["en"], { type: "language" });
	} catch {
		return null;
	}
})();

/** Subtags in their usual casing: Latn for scripts, SA for regions. */
function canonicalTag(base: string, subtags: string[]): string {
	return [
		base,
		...subtags.map((s) => (s.length === 4 ? s[0]!.toUpperCase() + s.slice(1).toLowerCase() : s.length === 2 ? s.toUpperCase() : s.toLowerCase())),
	].join("-");
}

/**
 * A region or script variant the list does not name, such as ar-MA, read
 * from its tag when its base language is known.
 */
function variantOf(code: string): LanguageEntry | undefined {
	const [first, ...subtags] = code.trim().split(/[-_]/);
	const base = first ? byAlias.get(first.toLowerCase()) : undefined;
	if (!base || base.variant || !subtags.length || !isLanguageCode(code.trim())) return undefined;
	const tag = canonicalTag(base.tag, subtags);
	const known = byAlias.get(tag.toLowerCase());
	if (known) return known;
	let name: string | undefined;
	try {
		name = displayNames?.of(tag);
	} catch {}
	const entry: LanguageEntry = {
		name: name && name !== tag ? name : `${base.name} (${subtags.join("-")})`,
		tag,
		code3: tag,
		aliases: [tag.toLowerCase()],
		variant: true,
		common: false,
	};
	byAlias.set(code.trim().toLowerCase(), entry);
	byAlias.set(tag.toLowerCase(), entry);
	return entry;
}

/** The entry a code stands for, in any of its forms and any casing. */
export function findLanguage(code: string): LanguageEntry | undefined {
	return byAlias.get(code.trim().toLowerCase()) ?? variantOf(code);
}

/** Whether the picker list has the entry, rather than it being read from a tag. */
export function isListedLanguage(entry: LanguageEntry): boolean {
	return LANGUAGES.includes(entry);
}

/** A well formed BCP 47 or ISO 639 code, for codes the list does not have. */
export function isLanguageCode(code: string): boolean {
	return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(code.trim());
}
