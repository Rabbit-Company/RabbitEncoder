import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getDefaultJobSettings } from "../../src/core/config";
import { run } from "../../src/core/process";
import type { AppConfig, FontCheckFile, Job, RepairAuditTrack } from "../../src/core/types";
import { buildFontCheckPlans, checkFolderFonts, summarizeFontCheck, type FontCheckUpload } from "../../src/pipeline/font-check";
import { buildRepairMkvpropeditArgs, identifyMatroska, isMetadataOnlyRepair, runRepairJob } from "../../src/pipeline/repair";

const sub = (id: number, language = "ru"): RepairAuditTrack => ({
	id,
	type: "subtitles",
	codec: "SubStationAlpha",
	language,
	title: "Full Subtitles",
	isDefault: false,
	isForced: false,
	isEnabled: true,
	isHearingImpaired: false,
	isVisualImpaired: false,
	isTextDescriptions: false,
	isOriginal: false,
	isCommentary: false,
	compression: "none",
});

const file = (name: string, missing: string[], families: string[]): FontCheckFile => ({
	path: `/show/${name}`,
	fileName: name,
	families,
	missing,
	tracks: [sub(2)],
});

describe("font check plans", () => {
	const spellings = new Map([
		["calligrapher", "Calligrapher"],
		["thesans ot 7b", "TheSans OT 7B"],
		["arial", "Arial"],
	]);
	const result = summarizeFontCheck(
		"/show",
		[
			file("E01.mkv", ["arial", "calligrapher", "thesans ot 7b"], ["Noto Sans"]),
			file("E02.mkv", ["calligrapher"], []),
			file("E03.mkv", [], ["Noto Sans"]),
			{ ...file("E04.mkv", [], []), error: "Could not read its subtitles" },
		],
		spellings,
	);

	test("counts each missing font and the families the videos carry", () => {
		expect(result.missing).toEqual([
			{ key: "calligrapher", name: "Calligrapher", files: 2 },
			{ key: "arial", name: "Arial", files: 1, windows: true },
			{ key: "thesans ot 7b", name: "TheSans OT 7B", files: 1 },
		]);
		expect(result.families).toEqual([{ family: "Noto Sans", files: 2 }]);
	});

	test("maps to a carried family, attaches uploads, and reports videos a mapping cannot reach", () => {
		const root = mkdtempSync(join(tmpdir(), "rabbit-fontcheck-plan-"));
		try {
			const fontPath = join(root, "TheSans OT 7B.ttf");
			writeFileSync(fontPath, "font");
			const upload: FontCheckUpload = {
				key: "thesans ot 7b",
				path: fontPath,
				fileName: "TheSans OT 7B.ttf",
				family: "TheSans OT 7B",
				names: ["thesans ot 7b"],
			};
			const { plans, unreachable } = buildFontCheckPlans(
				result,
				{ maps: [{ key: "calligrapher", to: "noto sans" }], replaceTarget: true },
				[upload],
				join(root, "work"),
			);
			expect(plans.map((p) => p.targetPath)).toEqual(["/show/E01.mkv"]);
			expect(plans[0]!.fontFix!.maps).toEqual([{ from: "Calligrapher", to: "Noto Sans" }]);
			expect(plans[0]!.fontFix!.attachments.map((a) => a.fileName)).toEqual(["TheSans OT 7B.ttf"]);
			expect(existsSync(plans[0]!.fontFix!.attachments[0]!.file)).toBe(true);
			expect(plans[0]!.tracks).toMatchObject([{ source: "target", trackId: 2, mode: "copy", compression: "preserve", title: "Full Subtitles" }]);
			expect(unreachable).toEqual([{ fileName: "E02.mkv", font: "Calligrapher", to: "noto sans" }]);

			// Mapped to the upload, a video that lacks the upload's font gets it attached as well.
			const toUpload = buildFontCheckPlans(
				result,
				{ maps: [{ key: "calligrapher", to: "TheSans OT 7B" }], replaceTarget: false },
				[upload],
				join(root, "work"),
			);
			expect(toUpload.plans.map((p) => [p.targetPath, p.fontFix!.maps, p.fontFix!.attachments.map((a) => a.fileName)])).toEqual([
				["/show/E01.mkv", [{ from: "Calligrapher", to: "TheSans OT 7B" }], ["TheSans OT 7B.ttf"]],
				["/show/E02.mkv", [{ from: "Calligrapher", to: "TheSans OT 7B" }], ["TheSans OT 7B.ttf"]],
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("an upload alone is attached in place and leaves unchanged subtitles alone", () => {
		const root = mkdtempSync(join(tmpdir(), "rabbit-fontcheck-edit-"));
		try {
			const fontPath = join(root, "Arial.ttf");
			writeFileSync(fontPath, "font");
			const upload: FontCheckUpload = { key: "arial", path: fontPath, fileName: "Arial.ttf", family: "Arial", names: ["arial"] };
			const plan = buildFontCheckPlans(result, { maps: [], replaceTarget: true }, [upload], join(root, "work")).plans[0]!;
			const target = {
				tracks: [
					{ id: 0, type: "video", codec: "AV1", properties: {} },
					{
						id: 2,
						type: "subtitles",
						codec: "SubStationAlpha",
						properties: { codec_id: "S_TEXT/ASS", language: "rus", language_ietf: "ru", track_name: "Full Subtitles" },
					},
				],
			};
			expect(isMetadataOnlyRepair(plan, target)).toBe(true);
			const args = buildRepairMkvpropeditArgs("/tmp/staged.mkv", plan, target);
			expect(args).not.toContain("--edit");
			expect(args.slice(2)).toEqual([
				"--attachment-name",
				"Arial.ttf",
				"--attachment-mime-type",
				"font/ttf",
				"--add-attachment",
				plan.fontFix!.attachments[0]!.file,
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

const LIBERATION = "/usr/share/fonts/liberation-sans-fonts/LiberationSans-Regular.ttf";
const LIBERATION_MONO = "/usr/share/fonts/liberation-mono-fonts/LiberationMono-Regular.ttf";
const hasTools =
	["ffmpeg", "mkvmerge", "mkvextract", "mkvpropedit", "fc-scan"].every((tool) => Bun.which(tool)) && existsSync(LIBERATION) && existsSync(LIBERATION_MONO);

(hasTools ? test : test.skip)(
	"finds the fonts a folder lacks and fixes them by mapping and by attaching",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "rabbit-fontcheck-"));
		const command = async (args: string[]) => {
			const result = await run(args, { cwd: root });
			if (result.code !== 0 && !(args[0] === "mkvmerge" && result.code === 1)) throw new Error(result.stderr || result.stdout);
		};
		try {
			const folder = join(root, "Season 01");
			mkdirSync(folder);
			await command([
				"ffmpeg",
				"-v",
				"error",
				"-f",
				"lavfi",
				"-i",
				"color=black:s=320x180:r=10:d=2",
				"-f",
				"lavfi",
				"-i",
				"sine=d=2",
				"-c:v",
				"libx264",
				"-preset",
				"ultrafast",
				"-c:a",
				"aac",
				"plain.mkv",
			]);
			const ass = (sign: string) => `[Script Info]
ScriptType: v4.00+
PlayResX: 320
PlayResY: 180
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Liberation Sans,20,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,204
Style: Sign,${sign},20,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,8,10,10,10,204
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.50,0:00:01.50,Default,,0,0,0,,Привет {\\fn${sign}}мир
Dialogue: 0,0:00:01.00,0:00:01.50,Sign,,0,0,0,,Знак
`;
			writeFileSync(join(root, "e01.ass"), ass("Calligrapher"));
			writeFileSync(join(root, "e02.ass"), ass("Liberation Mono"));
			for (const ep of ["01", "02"])
				await command([
					"mkvmerge",
					"-q",
					"-o",
					join(folder, `Show - S01E${ep}.mkv`),
					"plain.mkv",
					"--language",
					"0:rus",
					"--track-name",
					"0:Full Subtitles",
					`e${ep}.ass`,
					"--attachment-mime-type",
					"font/ttf",
					"--attach-file",
					LIBERATION,
				]);

			const progress: number[] = [];
			const result = await checkFolderFonts(folder, [join(folder, "Show - S01E01.mkv"), join(folder, "Show - S01E02.mkv")], join(root, "scan"), (done) =>
				progress.push(done),
			);
			expect(progress.at(-1)).toBe(2);
			expect(result.files.map((f) => [f.fileName, f.missing, f.families])).toEqual([
				["Show - S01E01.mkv", ["calligrapher"], ["Liberation Sans"]],
				["Show - S01E02.mkv", ["liberation mono"], ["Liberation Sans"]],
			]);
			expect(result.missing.map((m) => [m.name, m.files])).toEqual([
				["Calligrapher", 1],
				["Liberation Mono", 1],
			]);

			const upload: FontCheckUpload = {
				key: "liberation mono",
				path: LIBERATION_MONO,
				fileName: "LiberationMono-Regular.ttf",
				family: "Liberation Mono",
				names: ["liberation mono"],
			};
			const { plans } = buildFontCheckPlans(
				result,
				{ maps: [{ key: "calligrapher", to: "Liberation Sans" }], replaceTarget: true },
				[upload],
				join(root, "work"),
			);
			expect(plans).toHaveLength(2);
			const config = { tempDir: join(root, "tmp") } as AppConfig;
			mkdirSync(config.tempDir, { recursive: true });
			for (const [index, plan] of plans.entries()) {
				const job = {
					id: `fix${index}`,
					kind: "repair",
					filename: "x",
					inputPath: plan.targetPath,
					relativePath: "",
					status: "queued",
					progress: 0,
					queueOrder: 1,
					currentStage: "",
					steps: [],
					settings: getDefaultJobSettings(),
					replaceSource: false,
					repairPlan: plan,
				} as Job;
				await runRepairJob(job, config, (partial) => Object.assign(job, partial));
				expect(job.error).toBeUndefined();
				expect(job.status).toBe("done");
				expect(job.steps.at(-1)?.detail).toBe("Target replaced after verification");
				expect(existsSync(plan.fontFix!.workDir)).toBe(false);
			}

			const mapped = await identifyMatroska(plans[0]!.targetPath);
			expect((mapped.attachments ?? []).map((a) => a.file_name)).toEqual(["LiberationSans-Regular.ttf"]);
			await command(["mkvextract", plans[0]!.targetPath, "tracks", `2:${join(root, "out1.ass")}`]);
			const text = readFileSync(join(root, "out1.ass"), "utf-8");
			expect(text).toContain("Style: Sign,Liberation Sans,");
			expect(text).toContain("{\\fnLiberation Sans}мир");
			expect(text).not.toContain("Calligrapher");
			const subtitle = mapped.tracks!.find((t) => t.type === "subtitles")!.properties;
			expect([subtitle.language_ietf, subtitle.track_name]).toEqual(["ru", "Full Subtitles"]);

			const attached = await identifyMatroska(plans[1]!.targetPath);
			expect((attached.attachments ?? []).map((a) => a.file_name).sort()).toEqual(["LiberationMono-Regular.ttf", "LiberationSans-Regular.ttf"]);

			const again = await checkFolderFonts(
				folder,
				plans.map((p) => p.targetPath),
				join(root, "scan2"),
				() => {},
			);
			expect(again.missing).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
	90_000,
);
