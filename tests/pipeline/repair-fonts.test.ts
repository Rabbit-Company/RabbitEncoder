import { afterAll, describe, expect, it } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getDefaultJobSettings } from "../../src/core/config";
import { run } from "../../src/core/process";
import type { AppConfig, Job, RepairSubtitleTrackPlan } from "../../src/core/types";
import { buildRepairMkvmergeArgs, identifyMatroska, runRepairJob, sanitizeRepairPlan } from "../../src/pipeline/repair";
import { planSourceFonts, renameAssFonts, renamedNames, renameFontFamily, type InputFont } from "../../src/pipeline/repair-fonts";
import { fontRegistry, scanFontNames } from "../../src/fonts/fonts";
import { isRabbitGroupFace } from "../../src/fonts/inject";
import { assTime, command, extractSubtitle, hasReleaseTools, makeAvMkv, RATE, speechLike, writeWav } from "./release-fixtures";

let nextId = 1;
function font(input: number, fileName: string, family: string, hash: string, style = "Regular"): InputFont {
	const full = style === "Regular" ? family : `${family} ${style}`;
	return {
		input,
		id: nextId++,
		fileName,
		path: `/tmp/${fileName}`,
		hash,
		family,
		names: [family, full, `${family.replace(/\s+/g, "")}-${style}`].map((n) => n.toLowerCase()),
	};
}

describe("planSourceFonts", () => {
	it("leaves out a font the target has byte for byte, under any name", () => {
		const plan = planSourceFonts([font(-1, "arial.ttf", "Arial", "a")], [font(0, "ARIAL_copy.TTF", "Arial", "a")]);
		expect(plan.duplicates.map((f) => f.fileName)).toEqual(["ARIAL_copy.TTF"]);
		expect(plan.keep).toEqual([]);
		expect(plan.renames).toEqual([]);
	});

	it("renames every face of a family whose name another font already has", () => {
		const plan = planSourceFonts(
			[font(-1, "GandhiSans-Bold.ttf", "Gandhi Sans", "t1", "Bold")],
			[
				font(0, "GandhiSans-Regular.otf", "Gandhi Sans", "s1"),
				font(0, "GandhiSans-Bold.otf", "Gandhi Sans", "s2", "Bold"),
				font(0, "Fredoka.ttf", "Fredoka", "s3"),
			],
		);
		expect(plan.keep.map((f) => f.fileName)).toEqual(["Fredoka.ttf"]);
		expect(plan.renames.map((r) => [r.font.fileName, r.family, r.fileName])).toEqual([
			["GandhiSans-Regular.otf", "Gandhi Sans 2", "GandhiSans-Regular_2.otf"],
			["GandhiSans-Bold.otf", "Gandhi Sans 2", "GandhiSans-Bold_2.otf"],
		]);
	});

	it("renames a font whose file name the target already uses for another font", () => {
		const plan = planSourceFonts([font(-1, "font.ttf", "Alpha", "t")], [font(0, "font.ttf", "Beta", "s")]);
		expect(plan.renames.map((r) => [r.family, r.fileName])).toEqual([["Beta 2", "font_2.ttf"]]);
	});

	it("gives each later source that clashes the next free name", () => {
		const plan = planSourceFonts(
			[font(-1, "a.ttf", "Arial", "t")],
			[font(0, "a0.ttf", "Arial", "s0"), font(1, "a1.ttf", "Arial", "s1"), font(2, "a2.ttf", "Arial", "s0")],
		);
		expect(plan.renames.map((r) => [r.font.input, r.family])).toEqual([
			[0, "Arial 2"],
			[1, "Arial 3"],
		]);
		expect(plan.duplicates.map((f) => f.input)).toEqual([2]);
	});

	it("keeps fonts no other input has", () => {
		const plan = planSourceFonts([], [font(0, "x.ttf", "X", "1"), font(1, "y.ttf", "Y", "2")]);
		expect(plan.keep.map((f) => f.fileName)).toEqual(["x.ttf", "y.ttf"]);
	});
});

describe("renamedNames", () => {
	it("moves the family, full and PostScript names to the new family", () => {
		expect(renamedNames({ family: "Gandhi Sans", names: ["gandhi sans", "gandhi sans bold", "gandhisans-bold"] }, "Gandhi Sans 2").sort()).toEqual(
			["gandhi sans 2", "gandhi sans 2 bold", "gandhisans2", "gandhisans2-bold"].sort(),
		);
	});
});

describe("renameAssFonts", () => {
	const renames = [{ names: new Set(["gandhi sans", "gandhi sans bold", "gandhisans-bold"]), from: "Gandhi Sans", to: "Gandhi Sans 2" }];
	const ass = [
		"[Script Info]",
		"Title: Gandhi Sans test",
		"",
		"[V4+ Styles]",
		"Format: Name, Fontname, Fontsize, PrimaryColour",
		"Style: Default,Gandhi Sans,52,&H00FFFFFF",
		"Style: Sign,gandhi sans bold,40,&H00FFFFFF",
		"Style: Other,Fredoka,40,&H00FFFFFF",
		"",
		"[Events]",
		"Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
		"Dialogue: 0,0:00:01.00,0:00:02.00,Other,,0,0,0,,{\\fnGandhi Sans\\b1}Hi {\\fn@Gandhi Sans}there {\\fnFredoka}you{\\fn}",
		"Comment: 0,0:00:01.00,0:00:02.00,Other,,0,0,0,,{\\fnGandhiSans-Bold}x",
	].join("\r\n");
	const out = renameAssFonts(ass, renames);

	it("renames style fonts and inline overrides, keeping the rest", () => {
		expect(out).toContain("Style: Default,Gandhi Sans 2,52,&H00FFFFFF");
		expect(out).toContain("Style: Sign,Gandhi Sans 2 bold,40,&H00FFFFFF");
		expect(out).toContain("Style: Other,Fredoka,40,&H00FFFFFF");
		expect(out).toContain("{\\fnGandhi Sans 2\\b1}Hi {\\fn@Gandhi Sans 2}there {\\fnFredoka}you{\\fn}");
		expect(out).toContain("{\\fnGandhi Sans 2}x");
	});

	it("leaves everything else alone, line endings included", () => {
		expect(out).toContain("Title: Gandhi Sans test\r\n");
		expect(out.split("\r\n")).toHaveLength(ass.split("\r\n").length);
		expect(renameAssFonts(ass, [])).toBe(ass);
	});

	it("finds the font column from the Format line", () => {
		const reordered = "[V4+ Styles]\nFormat: Fontname, Name\nStyle: Gandhi Sans,Gandhi Sans\n";
		expect(renameAssFonts(reordered, renames)).toBe("[V4+ Styles]\nFormat: Fontname, Name\nStyle: Gandhi Sans 2,Gandhi Sans\n");
	});
});

describe("source fonts in the mux", () => {
	const track = (source: "target" | "source", trackId: number, order: number): RepairSubtitleTrackPlan => ({
		source,
		trackId,
		mode: "copy",
		order,
		title: "x",
		language: "eng",
		compression: "none",
		isDefault: false,
		isForced: false,
		isEnabled: true,
		isHearingImpaired: false,
		isOriginal: false,
		isCommentary: false,
	});

	it("attaches the chosen source fonts and nothing the sources carry", () => {
		const plan = sanitizeRepairPlan({ targetPath: "/media/e.mkv", sourcePath: "/media/s.mkv", replaceTarget: false, tracks: [track("source", 3, 0)] });
		const args = buildRepairMkvmergeArgs({
			outputPath: "/tmp/out.mkv",
			plan,
			target: { tracks: [], attachments: [] },
			source: {
				tracks: [{ id: 3, type: "subtitles", codec: "HDMV PGS", properties: { codec_id: "S_HDMV/PGS" } }],
				attachments: [{ id: 1, file_name: "a.ttf" }],
			},
			prepared: [],
			sourceFonts: [{ fileName: "a_2.ttf", path: "/tmp/fonts/renamed_0_1.ttf", mime: "font/ttf", isFont: true, names: ["a 2"] }],
		});
		const sourceArgs = args.slice(args.indexOf("/media/e.mkv") + 1, args.indexOf("/media/s.mkv"));
		expect(sourceArgs).toContain("--no-attachments");
		expect(args[args.indexOf("/tmp/fonts/renamed_0_1.ttf") - 2]).toBe("a_2.ttf");
	});
});

const hasFontTools = Bun.spawnSync(["python3", "-c", "import fontTools"]).exitCode === 0 && !!Bun.which("fc-scan");
const NOTO_SANS = join(import.meta.dir, "../../fonts/Noto Sans/latin.ttf");
const NOTO_SERIF = join(import.meta.dir, "../../fonts/Noto Serif/latin.ttf");

(hasFontTools ? describe : describe.skip)("renameFontFamily", () => {
	const root = mkdtempSync(join(tmpdir(), "rabbit-font-rename-"));
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it("renames the family of every instance and keeps their styles", async () => {
		const out = join(root, "renamed.ttf");
		expect(await renameFontFamily(NOTO_SANS, out, "Noto Sans", "Noto Sans 2")).toBe(true);
		const scanned = await run(["fc-scan", "--format", "%{family}|%{fullname}|%{postscriptname}|%{style}\n", out]);
		const rows = scanned.stdout.trim().split("\n");
		expect(rows).toContain("Noto Sans 2|Noto Sans 2 Bold|NotoSans2-Bold|Bold");
		expect(rows.every((row) => row.startsWith("Noto Sans 2|"))).toBe(true);
	});

	it("does not rename a font collection", async () => {
		expect(await renameFontFamily("/tmp/x.ttc", join(root, "x.ttc"), "X", "X 2")).toBe(false);
	});
});

(hasFontTools && hasReleaseTools ? describe : describe.skip)("repairing with fonts that clash", () => {
	const root = mkdtempSync(join(tmpdir(), "rabbit-font-clash-"));
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	const styles =
		"[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n" +
		"Style: Default,Noto Sans,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1\n";
	const ass = (shift: number, word: string) =>
		"[Script Info]\nScriptType: v4.00+\nPlayResX: 640\nPlayResY: 360\n\n" +
		styles +
		"\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" +
		Array.from(
			{ length: 30 },
			(_, i) => `Dialogue: 0,${assTime(2000 + i * 3500 + shift)},${assTime(3500 + i * 3500 + shift)},Default,,0,0,0,,${word} ${i + 1}\n`,
		).join("") +
		`Dialogue: 0,${assTime(50_000 + shift)},${assTime(52_000 + shift)},Default,,0,0,0,,{\\fnNoto Sans}${word}schild\n`;

	it("renames a different font of the same name, leaves out a copy of the target's, and points the source's track at the new name", async () => {
		// Serif glyphs under the name Noto Sans, which the encode uses for its own font.
		const impostor = join(root, "impostor.ttf");
		expect(await renameFontFamily(NOTO_SERIF, impostor, "Noto Serif", "Noto Sans")).toBe(true);
		copyFileSync(NOTO_SANS, join(root, "dup.ttf"));

		const speech = speechLike(120, 1);
		writeWav(join(root, "target.wav"), speech);
		writeWav(join(root, "source.wav"), speechLike(3, 2), speech);
		await makeAvMkv(join(root, "target-av.mkv"), join(root, "target.wav"), 120);
		await makeAvMkv(join(root, "source-av.mkv"), join(root, "source.wav"), 123);
		writeFileSync(join(root, "eng.ass"), ass(0, "Line"));
		writeFileSync(join(root, "ger.ass"), ass(3000, "Zeile"));
		const targetPath = join(root, "Target.mkv");
		const sourcePath = join(root, "Source.mkv");
		await command([
			"mkvmerge",
			"-q",
			"-o",
			targetPath,
			join(root, "target-av.mkv"),
			"--language",
			"0:eng",
			join(root, "eng.ass"),
			"--attachment-name",
			"NotoSans.ttf",
			"--attach-file",
			NOTO_SANS,
		]);
		await command([
			"mkvmerge",
			"-q",
			"-o",
			sourcePath,
			join(root, "source-av.mkv"),
			"--language",
			"0:ger",
			join(root, "ger.ass"),
			"--attachment-name",
			"NotoSans.ttf",
			"--attach-file",
			impostor,
			"--attach-file",
			join(root, "dup.ttf"),
			"--attachment-name",
			"NotoSerif.ttf",
			"--attach-file",
			NOTO_SERIF,
		]);

		const [target, source] = await Promise.all([identifyMatroska(targetPath), identifyMatroska(sourcePath)]);
		const sub = (info: typeof target) => (info.tracks ?? []).find((t) => t.type === "subtitles")!.id;
		const base = {
			mode: "copy" as const,
			compression: "none" as const,
			isDefault: false,
			isForced: false,
			isEnabled: true,
			isHearingImpaired: false,
			isOriginal: false,
			isCommentary: false,
		};
		const plan = sanitizeRepairPlan({
			targetPath,
			sourcePath,
			replaceTarget: false,
			alignSource: true,
			tracks: [
				{ ...base, source: "target", trackId: sub(target), order: 0, title: "English", language: "en" },
				{ ...base, source: "source", trackId: sub(source), order: 1, title: "German", language: "de" },
			],
		});
		const job = {
			id: "fonts",
			kind: "repair",
			inputPath: targetPath,
			settings: getDefaultJobSettings(),
			repairPlan: plan,
			status: "queued",
			steps: [],
		} as unknown as Job;
		mkdirSync(join(root, "tmp"), { recursive: true });
		await runRepairJob(job, { tempDir: join(root, "tmp") } as AppConfig, (partial) => Object.assign(job, partial));
		expect(job.error).toBeUndefined();
		expect(job.status).toBe("done");

		const output = await identifyMatroska(job.outputFilename!);
		expect((output.attachments ?? []).map((a) => a.file_name).sort()).toEqual(["NotoSans.ttf", "NotoSans_2.ttf", "NotoSerif.ttf"]);
		const extracted = join(root, "out");
		mkdirSync(extracted);
		await command(["mkvextract", job.outputFilename!, "attachments", ...(output.attachments ?? []).map((a) => `${a.id}:${join(extracted, a.file_name)}`)]);
		expect(readFileSync(join(extracted, "NotoSans.ttf")).equals(readFileSync(NOTO_SANS))).toBe(true);
		expect((await scanFontNames(join(extracted, "NotoSans_2.ttf"))).family).toBe("Noto Sans 2");

		const english = await extractSubtitle(job.outputFilename!, 0, ".ass", root);
		const german = await extractSubtitle(job.outputFilename!, 1, ".ass", root);
		expect(english).toContain("Style: Default,Noto Sans,20");
		expect(german).toContain("Style: Default,Noto Sans 2,20");
		expect(german).toContain("{\\fnNoto Sans 2}Zeileschild");
		expect(german).toContain(`${assTime(2000)},${assTime(3500)},Default,,0,0,0,,Zeile 1`);
	}, 120_000);
});

describe("isRabbitGroupFace", () => {
	const root = mkdtempSync(join(tmpdir(), "rabbit-own-face-"));
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it("knows a face of the font group by its family and the file name Rabbit gives it", async () => {
		fontRegistry.configure(join(import.meta.dir, "../../fonts"), join(root, "fonts"));
		fontRegistry.seed(["Noto Sans"]);
		await fontRegistry.reload();
		expect(isRabbitGroupFace("noto_sans.ttf", "Noto Sans", "Noto Sans")).toBe(true);
		expect(isRabbitGroupFace("noto_sans_2.ttf", "Noto Sans 2", "Noto Sans")).toBe(true);
		expect(isRabbitGroupFace("noto_sans_thai.ttf", "Noto Sans Thai", "Noto Sans")).toBe(true);
		expect(isRabbitGroupFace("NotoSans-Regular.ttf", "Noto Sans", "Noto Sans")).toBe(false);
		expect(isRabbitGroupFace("arial.ttf", "Arial", "Noto Sans")).toBe(false);
		expect(isRabbitGroupFace("noto_sans.ttf", "Noto Sans", "Another group")).toBe(false);
	});
});

(hasFontTools && hasReleaseTools ? describe : describe.skip)("repairing a file that already has Rabbit's font", () => {
	const root = mkdtempSync(join(tmpdir(), "rabbit-own-font-repair-"));
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	const styles = (font: string) =>
		"[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n" +
		`Style: Default,${font},20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1\n`;
	const ass = (font: string, word: string) =>
		"[Script Info]\nScriptType: v4.00+\nPlayResX: 640\nPlayResY: 360\n\n" +
		styles(font) +
		"\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" +
		Array.from({ length: 30 }, (_, i) => `Dialogue: 0,${assTime(2000 + i * 3500)},${assTime(3500 + i * 3500)},Default,,0,0,0,,${word} ${i + 1}\n`).join("");

	async function repairWith(removeUnusedFonts: boolean) {
		fontRegistry.configure(join(import.meta.dir, "../../fonts"), join(root, "fonts"));
		fontRegistry.seed(["Noto Sans"]);
		await fontRegistry.reload();
		const dir = mkdtempSync(join(root, "case-"));
		writeWav(join(dir, "audio.wav"), speechLike(120, 1));
		await makeAvMkv(join(dir, "av.mkv"), join(dir, "audio.wav"), 120);
		writeFileSync(join(dir, "eng.ass"), ass("Noto Sans", "Line"));
		writeFileSync(join(dir, "ger.ass"), ass("Arial", "Zeile"));
		const targetPath = join(dir, "Target.mkv");
		const sourcePath = join(dir, "Source.mkv");
		// The encode carries the face Rabbit attached for its English dialogue.
		await command([
			"mkvmerge",
			"-q",
			"-o",
			targetPath,
			join(dir, "av.mkv"),
			"--language",
			"0:eng",
			join(dir, "eng.ass"),
			"--attachment-name",
			"noto_sans.ttf",
			"--attach-file",
			NOTO_SANS,
		]);
		await command(["mkvmerge", "-q", "-o", sourcePath, join(dir, "av.mkv"), "--language", "0:ger", join(dir, "ger.ass")]);
		const [target, source] = await Promise.all([identifyMatroska(targetPath), identifyMatroska(sourcePath)]);
		const sub = (info: typeof target) => (info.tracks ?? []).find((t) => t.type === "subtitles")!.id;
		const base = {
			compression: "none" as const,
			isDefault: false,
			isForced: false,
			isEnabled: true,
			isHearingImpaired: false,
			isOriginal: false,
			isCommentary: false,
		};
		const plan = sanitizeRepairPlan({
			targetPath,
			sourcePath,
			replaceTarget: false,
			tracks: [
				{ ...base, source: "target", trackId: sub(target), mode: "copy", order: 0, title: "English", language: "en" },
				{ ...base, source: "source", trackId: sub(source), mode: "rabbit", order: 1, title: "German", language: "de" },
			],
		});
		const settings = { ...getDefaultJobSettings(), restyleAssFont: true, removeUnusedFonts };
		const job = {
			id: `own-${removeUnusedFonts}`,
			kind: "repair",
			inputPath: targetPath,
			settings,
			repairPlan: plan,
			status: "queued",
			steps: [],
		} as unknown as Job;
		mkdirSync(join(dir, "tmp"), { recursive: true });
		await runRepairJob(job, { tempDir: join(dir, "tmp") } as AppConfig, (partial) => Object.assign(job, partial));
		expect(job.error).toBeUndefined();
		const output = await identifyMatroska(job.outputFilename!);
		const german = await extractSubtitle(job.outputFilename!, 1, ".ass", dir);
		return { attachments: (output.attachments ?? []).map((a) => a.file_name).sort(), german };
	}

	it("reuses it for restyled tracks instead of attaching a copy as Noto Sans 2", async () => {
		const passed = await repairWith(false);
		expect(passed.attachments).toEqual(["noto_sans.ttf"]);
		expect(passed.german).toContain("Style: Default,Noto Sans,");
	}, 120_000);

	it("reuses it when unused fonts are dropped too", async () => {
		const rewritten = await repairWith(true);
		expect(rewritten.attachments).toEqual(["noto_sans.ttf"]);
		expect(rewritten.german).toContain("Style: Default,Noto Sans,");
	}, 120_000);
});
