import type { TranslateLang } from "./translate-languages";

/** Extra prompt requirements for target languages with pitfalls the general rules miss. */
const TARGET_RULES: Record<string, string[]> = {
	sl: [
		`Past tense verbs and adjectives must agree with the gender of the speaker and of the person addressed ("sem bil" / "sem bila", "si utrujen" / "si utrujena"). Work out each character's gender from the name, any series notes and the context, and keep it consistent for that character, except while they are disguised as another gender.`,
		`Use the dual whenever exactly two people are meant ("midva greva", "vidva sta", "onadva"), not the plural.`,
		`Use tikanje between friends, family, children and peers, and vikanje towards strangers, superiors and in formal situations. Keep each pair of characters consistent. Vikanje uses the standard plural forms ("Ste bili utrujeni?"), not polvikanje.`,
		`Write pure standard Slovenian. Never use Croatian, Serbian or Bosnian words or forms ("kaj", not "šta" or "što"; "nič", not "ništa"; "hiša", not "kuća"; "srečno", not "sretno").`,
		`Dialogue should sound like natural spoken Slovenian with standard spelling. Avoid English calques and English word order, and place clitics (sem, si, se, mi, ga, je) where a native speaker would.`,
		`Use Slovenian typography: „…" for quotes and a decimal comma.`,
	],
};

/** Requirement lines for this target language, or an empty list. */
export function targetLanguageRules(target: TranslateLang): string[] {
	return TARGET_RULES[target.code] ?? [];
}
