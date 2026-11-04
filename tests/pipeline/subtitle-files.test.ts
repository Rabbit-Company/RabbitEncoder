import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Web } from "@rabbit-company/web";
import { getDefaultJobSettings } from "../../src/core/config";
import { run } from "../../src/core/process";
import type { AppConfig, Job, JobSettings } from "../../src/core/types";
import { registerSubtitleFileRoutes } from "../../src/api/subtitle-files";
import { runSubtitleAddJob } from "../../src/pipeline/subtitle-add";
import { identifyMatroska } from "../../src/pipeline/repair";
import {
	assFontSpellings,
	buildSubtitleFilePlan,
	fontReport,
	guessSubtitleLanguage,
	planFontArgs,
	scanSubtitleFiles,
	subtitleFolderCredit,
} from "../../src/pipeline/subtitle-files";

const ass = (styles: [string, string][], events: string[]) => `[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styles.map(([name, font]) => `Style: ${name},${font},30,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,204`).join("\n")}
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join("\n")}
`;

const settings = (restyle: boolean): JobSettings => ({
	...getDefaultJobSettings(),
	restyleAssFont: restyle,
	assRestyleTargets: ["full"],
	fontGroup: "Noto Sans",
});

describe("subtitle file import", () => {
	test("reads the language and credit from fansub folder and file names", () => {
		const kirion = Array.from({ length: 3 }, (_, i) => `/subs/[Kirion] Kemono no Souja Erin - 0${i + 1} (BD 720p x264 AAC).ass`);
		const folder = "/Subs/Kogarasi & Exmel & DJATOM & drauglin [Rus]";
		expect(guessSubtitleLanguage(kirion, folder)).toBe("ru");
		expect(subtitleFolderCredit(folder)).toBe("Kogarasi & Exmel & DJATOM & drauglin");
		expect(guessSubtitleLanguage(["/s/Show - 01.pt-BR.ass", "/s/Show - 02.pt-BR.ass"], "/s/Subs")).toBe("pt-BR");
		expect(guessSubtitleLanguage(kirion, "/Subs/Group")).toBeNull();
		expect(guessSubtitleLanguage(kirion, "/Subs/Group [Rus Eng]")).toBeNull();
		for (const generic of ["/x/Subs", "/x/Russian", "/x/[Rus]", "/x/Fonts"]) expect(subtitleFolderCredit(generic)).toBe("");
		expect(subtitleFolderCredit("/x/[Kirion] [Rus]")).toBe("Kirion");
	});

	test("keeps the spelling of fonts from styles and overrides", () => {
		const text = ass(
			[
				["Default", "TheSans OT 7B"],
				["Sign", "@Calligrapher"],
			],
			["Dialogue: 0,0:00:01.00,0:00:02.00,Sign,,0,0,0,,{\\fnCountry Western Swing Black}Hi"],
		);
		expect([...assFontSpellings(text)]).toEqual([
			["thesans ot 7b", "TheSans OT 7B"],
			["calligrapher", "Calligrapher"],
			["country western swing black", "Country Western Swing Black"],
		]);
	});

	test("reports where each font comes from, and which ones the dialogue font group replaces", () => {
		const dialogue = Array.from({ length: 6 }, (_, i) => `Dialogue: 0,0:00:0${i}.00,0:00:0${i}.90,Default,,0,0,0,,Line ${i}`);
		const files: Record<string, string> = {
			"/s/01.ass": ass(
				[
					["Default", "TheSans OT 7B"],
					["Sign", "Calligrapher"],
				],
				[...dialogue, "Dialogue: 0,0:00:07.00,0:00:08.00,Sign,,0,0,0,,{\\fnArial}Sign"],
			),
			"/s/02.ass": ass(
				[
					["Default", "TheSans OT 7B"],
					["Sign", "Devroye Unicode"],
				],
				[...dialogue, "Dialogue: 0,0:00:07.00,0:00:08.00,Sign,,0,0,0,,Sign"],
			),
		};
		const pairs = [
			{ targetName: "E01.mkv", sourcePath: "/s/01.ass", attached: new Set(["calligrapher"]) },
			{ targetName: "E02.mkv", sourcePath: "/s/02.ass", attached: new Set<string>() },
			{ targetName: "E03.mkv", sourcePath: "", attached: new Set<string>() },
		];
		const read = (path: string) => files[path]!;
		const plain = fontReport(pairs, [{ names: ["devroye unicode"] }], [], settings(false), read);
		expect(plain.map((f) => [f.name, f.status, f.usedBy, f.missingIn, !!f.windows])).toEqual([
			["TheSans OT 7B", "missing", 2, ["E01.mkv", "E02.mkv"], false],
			["Arial", "missing", 1, ["E01.mkv"], true],
			["Calligrapher", "attached", 1, [], false],
			["Devroye Unicode", "folder", 1, [], false],
		]);
		const restyled = fontReport(pairs, [], [{ names: ["arial"] }], settings(true), read);
		expect(restyled.map((f) => [f.name, f.status])).toEqual([
			["Devroye Unicode", "missing"],
			["TheSans OT 7B", "replaced"],
			["Arial", "uploaded"],
			["Calligrapher", "attached"],
		]);
	});

	test("attaches only fonts the video lacks, under free file names", () => {
		const fonts = [
			{ file: "/missing.ttf", fileName: "a.ttf", names: ["a"] },
			{ file: import.meta.path, fileName: "Attached.ttf", names: ["attached"] },
			{ file: import.meta.path, fileName: "Arial.ttf", names: ["arial"] },
		];
		const args = planFontArgs(fonts, new Set(["attached"]), new Set(["arial.ttf"]), () => "font/ttf");
		expect(args).toEqual(["--attachment-mime-type", "font/ttf", "--attachment-name", "Arial_2.ttf", "--attach-file", import.meta.path]);
	});
});

const LIBERATION = "/usr/share/fonts/liberation-sans-fonts/LiberationSans-Regular.ttf";
const LIBERATION_MONO = "/usr/share/fonts/liberation-mono-fonts/LiberationMono-Regular.ttf";
const hasTools = ["ffmpeg", "mkvmerge", "mkvextract", "fc-scan"].every((tool) => Bun.which(tool)) && existsSync(LIBERATION) && existsSync(LIBERATION_MONO);

(hasTools ? test : test.skip)(
	"adds a folder of subtitles to their episodes with the fonts each one lacks",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "rabbit-subfiles-"));
		const command = async (args: string[]) => {
			const result = await run(args, { cwd: root });
			if (result.code !== 0 && !(args[0] === "mkvmerge" && result.code === 1)) throw new Error(result.stderr || result.stdout);
		};
		try {
			const videos = join(root, "Season 01");
			const subs = join(root, "Release", "Subs", "Kogarasi [Rus]");
			mkdirSync(videos, { recursive: true });
			mkdirSync(subs, { recursive: true });
			mkdirSync(join(root, "Release", "Fonts"));
			copyFileSync(LIBERATION_MONO, join(root, "Release", "Fonts", "LiberationMono-Regular.ttf"));
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
			writeFileSync(join(root, "eng.srt"), "1\n00:00:00,500 --> 00:00:01,500\nHello\n");
			for (const ep of ["01", "02"]) {
				await command([
					"mkvmerge",
					"-q",
					"-o",
					join(videos, `Show - S01E${ep}.mkv`),
					"plain.mkv",
					"--language",
					"0:eng",
					"eng.srt",
					"--attachment-mime-type",
					"font/ttf",
					"--attach-file",
					LIBERATION,
				]);
				writeFileSync(
					join(subs, `[Kirion] Show - ${ep} (BD 720p).ass`),
					ass(
						[
							["Default", "Liberation Sans"],
							["Sign", "Liberation Mono"],
						],
						["Dialogue: 0,0:00:00.50,0:00:01.50,Default,,0,0,0,,Привет", "Dialogue: 0,0:00:01.00,0:00:01.50,Sign,,0,0,0,,Знак"],
					),
				);
			}
			const defaults = settings(false);
			const scan = await scanSubtitleFiles({
				targetDir: videos,
				subtitleDir: subs,
				targets: [join(videos, "Show - S01E01.mkv"), join(videos, "Show - S01E02.mkv")],
				settings: defaults,
				tempDir: join(root, "scan"),
			});
			expect(scan.pairs.map((p) => [p.targetName, p.sourceName, p.method, p.existingLanguages])).toEqual([
				["Show - S01E01.mkv", "[Kirion] Show - 01 (BD 720p).ass", "episode", ["en"]],
				["Show - S01E02.mkv", "[Kirion] Show - 02 (BD 720p).ass", "episode", ["en"]],
			]);
			expect([scan.language, scan.credit]).toEqual(["ru", "Kogarasi"]);
			expect(scan.folderFonts.map((f) => f.fileName)).toEqual(["LiberationMono-Regular.ttf"]);
			expect(scan.fonts.map((f) => [f.name, f.status])).toEqual([
				["Liberation Mono", "folder"],
				["Liberation Sans", "attached"],
			]);

			const target = scan.pairs[0]!.targetPath;
			const plan = buildSubtitleFilePlan({
				targetPath: target,
				subtitlePath: scan.pairs[0]!.sourcePath,
				language: "ru",
				credit: scan.credit,
				fonts: scan.folderFonts,
				settings: defaults,
				workDir: join(root, "work"),
			});
			expect(plan.fonts?.map((f) => f.fileName)).toEqual(["LiberationMono-Regular.ttf"]);
			const job = {
				id: "subfiles",
				kind: "subtitles",
				filename: "Show - S01E01.mkv",
				inputPath: target,
				relativePath: "",
				status: "queued",
				progress: 0,
				queueOrder: 1,
				currentStage: "",
				steps: [],
				replaceSource: true,
				settings: { ...defaults, subtitleLanguagePriority: ["eng", "rus", "*"] },
				subtitleAddPlan: plan,
			} as Job;
			const config = { tempDir: join(root, "tmp-add"), outputDir: join(root, "out"), recycleBinDir: "", organization: "RabbitCompany" } as AppConfig;
			await runSubtitleAddJob(job, config, (partial) => Object.assign(job, partial));
			expect(job.error).toBeUndefined();
			expect(job.status).toBe("done");

			const result = await identifyMatroska(target);
			const subtitles = (result.tracks ?? []).filter((t) => t.type === "subtitles");
			expect(subtitles.map((t) => [t.properties.language_ietf, t.properties.track_name])).toEqual([
				["en", undefined],
				["ru", "Full Subtitles [Kogarasi]"],
			]);
			expect((result.attachments ?? []).map((a) => a.file_name).sort()).toEqual(["LiberationMono-Regular.ttf", "LiberationSans-Regular.ttf"]);
			expect(existsSync(plan.workDir)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
	60_000,
);

const hasFontTools = hasTools && (await run(["python3", "-c", "import fontTools"])).code === 0;

(hasFontTools ? test : test.skip)(
	"renames an uploaded font to the name the subtitles use",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "rabbit-subfiles-font-"));
		try {
			const app = new Web();
			registerSubtitleFileRoutes(app, { tempDir: root, inputDir: root, outputDir: root, libraryDirs: [] } as unknown as AppConfig);
			const upload = (name: string, body: Uint8Array<ArrayBuffer>) =>
				app.handle(new Request(`http://localhost/api/subtitle-files/font${name ? `?${new URLSearchParams({ name })}` : ""}`, { method: "POST", body }));
			const bytes = new Uint8Array(readFileSync(LIBERATION)) as Uint8Array<ArrayBuffer>;

			const renamed = await upload("Calligrapher", bytes);
			expect(renamed.status).toBe(201);
			const font = (await renamed.json()) as any;
			expect(font).toMatchObject({ fileName: "Calligrapher.ttf", family: "Calligrapher", renamedFrom: "Liberation Sans" });
			expect(font.names).toContain("calligrapher");
			expect(existsSync(font.path)).toBe(true);

			const kept = (await (await upload("", bytes)).json()) as any;
			expect(kept).toMatchObject({ fileName: "Liberation Sans.ttf", family: "Liberation Sans" });
			expect(kept.renamedFrom).toBeUndefined();

			const notFont = await upload("Calligrapher", new TextEncoder().encode("not a font at all") as Uint8Array<ArrayBuffer>);
			expect(notFont.status).toBe(400);
			expect(((await notFont.json()) as any).error).toContain("not a TrueType or OpenType font");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
	30_000,
);
