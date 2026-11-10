import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { run } from "../../src/core/process";
import type { RepairInspectionFile, RepairSubtitleTrack } from "../../src/core/types";
import {
	planReleaseSubtitles,
	releaseCredit,
	releaseGrid,
	releaseLanguageKey,
	scanReleaseSubtitles,
	type ReleaseRow,
	type ReleaseSubsOptions,
} from "../../src/pipeline/release-subs";

describe("releaseLanguageKey", () => {
	it("treats spellings of one language as one", () => {
		for (const tag of ["de", "ger", "deu", "de-DE"]) expect(releaseLanguageKey(tag)).toBe("de");
		for (const tag of ["en", "eng", "en-US", "enm"]) expect(releaseLanguageKey(tag)).toBe("en");
		for (const tag of ["fr", "fre", "fr-FR"]) expect(releaseLanguageKey(tag)).toBe("fr");
		expect(releaseLanguageKey("ara")).toBe("ar");
	});

	it("keeps the variants releases carry as separate tracks apart", () => {
		expect(releaseLanguageKey("es-419")).toBe("es-419");
		expect(releaseLanguageKey("es-MX")).toBe("es-419");
		for (const tag of ["es", "spa", "es-ES"]) expect(releaseLanguageKey(tag)).toBe("es");
		expect(releaseLanguageKey("pt-BR")).toBe("pt-BR");
		expect(releaseLanguageKey("por")).toBe("pt");
		expect(releaseLanguageKey("fr-CA")).toBe("fr-CA");
		for (const tag of ["zh", "chi", "zh-CN", "zh-Hans"]) expect(releaseLanguageKey(tag)).toBe("zh-Hans");
		for (const tag of ["zh-TW", "zh-HK", "zh-Hant"]) expect(releaseLanguageKey(tag)).toBe("zh-Hant");
	});

	it("has no key for a track of no language", () => {
		expect(releaseLanguageKey("und")).toBeNull();
		expect(releaseLanguageKey("")).toBeNull();
	});
});

describe("releaseCredit", () => {
	it("credits the track name first, then the release's source, then its group", () => {
		expect(releaseCredit("Full Subtitles [CrappySubs]", "x.mkv")).toBe("CrappySubs");
		expect(releaseCredit("English", "[Erai-raws] Show - 01 [1080p CR WEB-DL AVC AAC][MultiSub][ABCD1234].mkv")).toBe("CR");
		expect(releaseCredit("", "Show.S01E01.1080p.NF.WEB-DL.DDP2.0.H.264-VARYG.mkv")).toBe("NF");
		expect(releaseCredit("SDH Dubtitles (AMZN)", "Show.S03E01.1080p.BluRay.Opus.2.0.x265-YURASUKA.mkv")).toBe("AMZN");
		expect(releaseCredit("English", "Show.S03E01.1080p.BluRay.Opus.2.0.x265-YURASUKA.mkv")).toBe("YURASUKA");
	});

	it("does not take the CRC of a fansub release for its group", () => {
		expect(releaseCredit("English", "[SubsPlease] Show - 01 (1080p) [ABCD1234].mkv")).toBe("SubsPlease");
	});
});

let nextId = 2;
function sub(language: string, title: string, codecId = "S_TEXT/ASS", flags: Partial<RepairSubtitleTrack> = {}): RepairSubtitleTrack {
	return {
		id: nextId++,
		codec: codecId === "S_HDMV/PGS" ? "HDMV PGS" : codecId === "S_TEXT/UTF8" ? "SubRip/SRT" : "SubStationAlpha",
		codecId,
		language,
		title,
		isDefault: false,
		isForced: false,
		isEnabled: true,
		isHearingImpaired: false,
		isOriginal: false,
		isCommentary: false,
		canRabbitProcess: codecId === "S_TEXT/ASS" || codecId === "S_TEXT/UTF8",
		currentCompression: "none",
		...flags,
	};
}

function file(path: string, subtitles: RepairSubtitleTrack[]): RepairInspectionFile {
	return { path, filename: path.split("/").pop()!, durationSeconds: 1420, subtitles };
}

const options: ReleaseSubsOptions = { preferredSources: ["CR", "NF"], formatPriority: "text-first", renameTracks: true, languagePriority: ["eng", "jpn", "*"] };

const target = file("/enc/Show - S01E01 [AV1]-Rabbit.mkv", [
	sub("en", "Full Subtitles [CrappySubs]", "S_TEXT/ASS", { isDefault: true }),
	sub("en", "Signs & Songs [CrappySubs]", "S_TEXT/ASS", { isForced: true }),
]);
const erai = file("/erai/[Erai-raws] Show - 01 [1080p CR WEB-DL AVC AAC][MultiSub][ABCD1234].mkv", [
	sub("en", "English"),
	sub("de", "Deutsch"),
	sub("es-419", "Español (América Latina)"),
	sub("es-ES", "Español (España)"),
	sub("pt-BR", "Português (Brasil)"),
	sub("und", "Unknown"),
	sub("en", "Commentary", "S_TEXT/ASS", { isCommentary: true }),
]);
const varyg = file("/varyg/Show.S01E01.1080p.NF.WEB-DL.DDP2.0.H.264-VARYG.mkv", [
	sub("ger", "German", "S_TEXT/UTF8"),
	sub("it", "Italian", "S_TEXT/UTF8"),
	sub("it", "Italian", "S_HDMV/PGS"),
	sub("ja", "Japanese", "S_HDMV/PGS"),
]);

describe("planReleaseSubtitles", () => {
	const plan = planReleaseSubtitles(target, [varyg, erai], options);
	const action = (key: string) => plan.cells.find((c) => c.key === key)?.action;
	const added = (key: string) => plan.additions.find((a) => a.key === key);

	it("keeps what the target has and adds what it lacks", () => {
		expect(action("en:full")).toBe("keep");
		expect(action("en:forced")).toBe("keep");
		expect(plan.additions.map((a) => a.key)).toEqual(["ja:full", "de:full", "es:full", "es-419:full", "it:full", "pt-BR:full"]);
		expect(plan.removals).toEqual([]);
	});

	it("takes the preferred source first, whichever folder it is in", () => {
		expect(added("de:full")).toMatchObject({ sourcePath: erai.path, credit: "CR", trackName: "Full Subtitles [CR]", mode: "rabbit", language: "de" });
		expect(plan.cells.find((c) => c.key === "de:full")!.candidates.map((c) => c.credit)).toEqual(["CR", "NF"]);
	});

	it("takes text before pictures and ASS before SRT from the same source", () => {
		expect(added("it:full")).toMatchObject({ sourcePath: varyg.path, codecId: "S_TEXT/UTF8", mode: "rabbit" });
		expect(added("ja:full")).toMatchObject({ codecId: "S_HDMV/PGS", mode: "copy" });
		const pictures = planReleaseSubtitles(target, [varyg], { ...options, formatPriority: "picture-first" });
		expect(pictures.additions.find((a) => a.key === "it:full")!.codecId).toBe("S_HDMV/PGS");
	});

	it("leaves out tracks of no language and commentary", () => {
		expect(plan.cells.some((c) => c.key.startsWith("und") || c.kind === "commentary")).toBe(false);
	});

	it("makes each added language's track its default, as the target's English already has one", () => {
		expect(plan.additions.every((a) => a.isDefault)).toBe(true);
		const signs = planReleaseSubtitles(file("/enc/x.mkv", []), [file("/src/x.mkv", [sub("de", "Signs & Songs", "S_TEXT/ASS", { isForced: true })])], options);
		expect(signs.additions[0]).toMatchObject({ kind: "forced", isForced: true, isDefault: false, trackName: "Signs & Songs" });
	});

	it("orders the cells by the language priority", () => {
		expect(plan.cells.slice(0, 3).map((c) => c.key)).toEqual(["en:full", "en:forced", "ja:full"]);
	});

	it("replaces a track from a source ranked lower when asked", () => {
		const replaced = planReleaseSubtitles(target, [erai], { ...options, replaceWorse: true });
		expect(replaced.cells.find((c) => c.key === "en:full")!.action).toBe("replace");
		expect(replaced.removals).toEqual([target.subtitles[0]!.id]);
		expect(replaced.additions.find((a) => a.key === "en:full")).toMatchObject({ credit: "CR", isDefault: true });
		// A target track from a preferred source stays.
		const crTarget = file("/enc/x.mkv", [sub("en", "Full Subtitles [CR]")]);
		expect(
			planReleaseSubtitles(crTarget, [varyg, file("/src/[Erai-raws] x [CR].mkv", [sub("en", "English")])], { ...options, replaceWorse: true }).removals,
		).toEqual([]);
	});

	it("follows choices made by hand", () => {
		const chosen = planReleaseSubtitles(target, [varyg, erai], {
			...options,
			choices: { "de:full": { sourcePath: varyg.path, trackId: varyg.subtitles[0]!.id }, "it:full": null },
		});
		expect(chosen.additions.find((a) => a.key === "de:full")!.sourcePath).toBe(varyg.path);
		expect(chosen.cells.find((c) => c.key === "it:full")!.action).toBe("skip");
		expect(chosen.additions.some((a) => a.key === "it:full")).toBe(false);
	});

	it("reads the variant from the title when the tag is bare", () => {
		const newGate = file("/sankyuu/[SanKyuu] The New Gate - 01 [WEB 1080p AV1 AAC] [002F0254].mkv", [
			sub("spa", "Spanish(Latin_America)"),
			sub("spa", "Spanish"),
			sub("por", "Portuguese(Brazil)"),
			sub("chi", "Chinese (Simplified)"),
			sub("chi", "繁體中文"),
		]);
		const titled = planReleaseSubtitles(file("/enc/x.mkv", [sub("por", "Portuguese (Brazil)")]), [newGate], options);
		expect(titled.cells.find((c) => c.key === "pt-BR:full")!.action).toBe("keep");
		expect(titled.additions.map((a) => [a.key, a.language])).toEqual([
			["es:full", "spa"],
			["es-419:full", "es-419"],
			["zh-Hans:full", "zh-Hans"],
			["zh-Hant:full", "zh-Hant"],
		]);
	});

	it("keeps the source's own names when tracks are not renamed", () => {
		const kept = planReleaseSubtitles(target, [erai], { ...options, renameTracks: false });
		expect(kept.additions.find((a) => a.key === "de:full")!.trackName).toBe("Deutsch");
	});
});

describe("releaseGrid", () => {
	it("gives every row a cell for every column any file has, in the order tracks get in files", () => {
		const one = planReleaseSubtitles(target, [erai], options);
		const two = planReleaseSubtitles(file("/enc/Show - S01E02 [AV1]-Rabbit.mkv", [sub("en", "Full Subtitles")]), [varyg], options);
		const rows: ReleaseRow[] = [
			{ ...one, targetName: "1", sources: [] },
			{ ...two, targetName: "2", sources: [] },
		];
		const grid = releaseGrid(rows, ["eng", "jpn", "*"]);
		expect(grid.columns.map((c) => c.label)).toEqual([
			"English",
			"English Signs & Songs",
			"Japanese",
			"German",
			"Spanish",
			"Spanish (Latin America)",
			"Italian",
			"Portuguese (Brazil)",
		]);
		expect(grid.rows.every((r) => r.cells.length === grid.columns.length)).toBe(true);
		expect(grid.rows[1]!.cells.find((c) => c.key === "en:forced")!.action).toBe("missing");
		expect(grid.rows[0]!.cells.find((c) => c.key === "it:full")!.action).toBe("missing");
	});
});

const hasTools = ["mkvmerge"].every((tool) => Bun.which(tool));

(hasTools ? describe : describe.skip)("scanReleaseSubtitles", () => {
	const root = mkdtempSync(join(tmpdir(), "rabbit-release-scan-"));
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it("pairs each episode with its releases and plans what it lacks", async () => {
		const srt = join(root, "line.srt");
		writeFileSync(srt, "1\n00:00:01,000 --> 00:00:02,000\nHi\n");
		const make = async (path: string, tracks: Array<[string, string]>) => {
			const args = ["mkvmerge", "-q", "-o", path];
			for (const [language, title] of tracks) args.push("--language", `0:${language}`, "--track-name", `0:${title}`, srt);
			const result = await run(args);
			if (result.code > 1) throw new Error(result.stderr || result.stdout);
		};
		for (const dir of ["enc", "erai", "varyg"]) mkdirSync(join(root, dir));
		await make(join(root, "enc", "Show - S01E01 [AV1]-Rabbit.mkv"), [["en", "Full Subtitles [CR]"]]);
		await make(join(root, "enc", "Show - S01E02 [AV1]-Rabbit.mkv"), [["en", "Full Subtitles [CR]"]]);
		await make(join(root, "erai", "[Erai-raws] Show - 01 [1080p CR WEB-DL][ABCD1234].mkv"), [
			["en", "English"],
			["de", "Deutsch"],
		]);
		await make(join(root, "erai", "[Erai-raws] Show - 02 [1080p CR WEB-DL][ABCD1235].mkv"), [["en", "English"]]);
		await make(join(root, "erai", "[Erai-raws] Show - 03 [1080p CR WEB-DL][ABCD1236].mkv"), [["en", "English"]]);
		await make(join(root, "varyg", "Show.S01E02.1080p.NF.WEB-DL-VARYG.mkv"), [["it", "Italian"]]);

		const targets = [join(root, "enc", "Show - S01E01 [AV1]-Rabbit.mkv"), join(root, "enc", "Show - S01E02 [AV1]-Rabbit.mkv")];
		const scan = await scanReleaseSubtitles({ targets, sourceDirs: [join(root, "erai"), join(root, "varyg")], options });
		expect(scan.unmatchedSources.map((p) => p.split("/").pop())).toEqual(["[Erai-raws] Show - 03 [1080p CR WEB-DL][ABCD1236].mkv"]);
		expect(scan.columns.map((c) => c.key)).toEqual(["en:full", "de:full", "it:full"]);
		const [first, second] = scan.rows;
		expect(first!.sources.map((s) => [s.name, s.method])).toEqual([["[Erai-raws] Show - 01 [1080p CR WEB-DL][ABCD1234].mkv", "episode"]]);
		expect(first!.cells.map((c) => c.action)).toEqual(["keep", "add", "missing"]);
		expect(second!.sources).toHaveLength(2);
		expect(second!.cells.map((c) => c.action)).toEqual(["keep", "missing", "add"]);
		expect(second!.additions[0]).toMatchObject({ key: "it:full", credit: "NF", trackName: "Full Subtitles [NF]" });
	}, 30_000);
});

(hasTools ? describe : describe.skip)("scanReleaseSubtitles with releases numbered across seasons", () => {
	const root = mkdtempSync(join(tmpdir(), "rabbit-release-absolute-"));
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	async function make(path: string, language: string) {
		const srt = join(root, "line.srt");
		writeFileSync(srt, "1\n00:00:01,000 --> 00:00:02,000\nHi\n");
		const result = await run(["mkvmerge", "-q", "-o", path, "--language", `0:${language}`, srt]);
		if (result.code > 1) throw new Error(result.stderr || result.stdout);
	}

	it("finds the offset from the names, or takes it from the folder", async () => {
		for (const dir of ["enc", "season", "series"]) mkdirSync(join(root, dir));
		const targets = [join(root, "enc", "Show - S02E01.mkv"), join(root, "enc", "Show - S02E02.mkv")];
		for (const target of targets) await make(target, "en");
		for (const n of [13, 14]) await make(join(root, "season", `[Erai-raws] Show - ${n} [1080p CR WEB-DL].mkv`), "de");
		for (let n = 1; n <= 24; n++) await make(join(root, "series", `[Erai-raws] Show - ${String(n).padStart(2, "0")} [1080p CR WEB-DL].mkv`), "it");

		const auto = await scanReleaseSubtitles({ targets, sourceDirs: [join(root, "season"), join(root, "series")], options });
		expect(auto.rows.map((row) => row.sources.map((s) => [s.name, s.method, s.offset]))).toEqual([
			[["[Erai-raws] Show - 13 [1080p CR WEB-DL].mkv", "absolute", 12]],
			[["[Erai-raws] Show - 14 [1080p CR WEB-DL].mkv", "absolute", 12]],
		]);

		const given = await scanReleaseSubtitles({ targets, sourceDirs: [{ path: join(root, "series"), offset: 12 }], options });
		expect(given.rows.map((row) => row.sources.map((s) => s.name))).toEqual([
			["[Erai-raws] Show - 13 [1080p CR WEB-DL].mkv"],
			["[Erai-raws] Show - 14 [1080p CR WEB-DL].mkv"],
		]);
		expect(given.rows[0]!.additions.map((a) => a.key)).toEqual(["it:full"]);
	}, 30_000);
});
