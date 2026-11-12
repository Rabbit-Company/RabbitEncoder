import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getDefaultJobSettings } from "../../src/core/config";
import { run } from "../../src/core/process";
import { fontRegistry } from "../../src/fonts/fonts";
import { clearOriginals, fontSha, originalMarker, originalsDir, originalsUsage, readOriginalMarker, storeOriginal } from "../../src/fonts/font-cut";
import { dropAttachmentArgs, fileFontState, refreshFonts } from "../../src/fonts/rabbit-faces";
import { buildRepairFontPlans, sanitizeRepairPlan } from "../../src/pipeline/repair";

const FONT = join(import.meta.dir, "../../fonts/Noto Sans/latin.ttf");
const hasTools = ["mkvmerge", "mkvextract", "fc-scan"].every((tool) => Bun.which(tool)) && Bun.spawnSync(["python3", "-c", "import fontTools"]).exitCode === 0;

let root = "";
beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "rabbit-fontcut-"));
	fontRegistry.configure(join(import.meta.dir, "../../fonts"), join(root, "fonts"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("cut font originals", () => {
	it("reads only a well-formed marker", () => {
		const sha = "a".repeat(64);
		expect(readOriginalMarker(originalMarker(sha))).toBe(sha);
		expect(readOriginalMarker("RabbitEncoderOriginal;nothex")).toBeNull();
		expect(readOriginalMarker("Some vendor id")).toBeNull();
		expect(readOriginalMarker(null)).toBeNull();
	});

	it("stores a font once per content, however many files carry it", () => {
		const a = join(root, "a.ttf");
		const b = join(root, "b.ttf");
		writeFileSync(a, "same bytes");
		writeFileSync(b, "same bytes");
		storeOriginal(a, fontSha(a));
		storeOriginal(b, fontSha(b));
		expect(readdirSync(originalsDir())).toHaveLength(1);
		expect(originalsUsage()).toEqual({ count: 1, bytes: 10 });
		clearOriginals();
		expect(originalsUsage()).toEqual({ count: 0, bytes: 0 });
	});
});

describe("font rebuild plans", () => {
	const file = {
		path: "/media/Show - 01.mkv",
		tracks: [
			{ id: 1, type: "audio", title: "", language: "jpn" },
			{ id: 3, type: "subtitles", title: "Full", language: "eng", isDefault: true, isForced: false, isEnabled: true },
			{ id: 4, type: "subtitles", title: "Signs", language: "eng", isDefault: false, isForced: true, isEnabled: true },
		],
	} as any;

	it("copies every subtitle track as it is and asks only for the fonts", () => {
		const [plan] = buildRepairFontPlans([file], { subset: true, replaceTarget: true });
		expect(plan!.fonts).toEqual({ rebuild: true, subset: true });
		expect(plan!.tracks.map((t) => [t.trackId, t.mode, t.compression, t.order])).toEqual([
			[3, "copy", "preserve", 0],
			[4, "copy", "preserve", 1],
		]);
	});

	it("survives sanitizing, with subset read as a plain flag", () => {
		const plan = sanitizeRepairPlan({ targetPath: "/x.mkv", replaceTarget: false, tracks: [], fonts: { rebuild: true, subset: "yes" as any } });
		expect(plan.fonts).toEqual({ rebuild: true, subset: true });
		expect(sanitizeRepairPlan({ targetPath: "/x.mkv", replaceTarget: false, tracks: [] }).fonts).toBeUndefined();
	});

	it("leaves out the replaced attachments of an input", () => {
		expect(dropAttachmentArgs([3, 1, 3])).toEqual(["--attachments", "!3,1"]);
		expect(dropAttachmentArgs([])).toEqual([]);
	});
});

describe.skipIf(!hasTools)("cutting a release's fonts", () => {
	const ass = (text: string) =>
		[
			"[Script Info]",
			"ScriptType: v4.00+",
			"",
			"[V4+ Styles]",
			"Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
			"Style: Sign,Noto Sans,60,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,8,10,10,10,1",
			"",
			"[Events]",
			"Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
			`Dialogue: 0,0:00:00.00,0:00:02.00,Sign,,0,0,0,,${text}`,
		].join("\n");

	it("cuts it down, keeps the original, and gives characters back when the text needs them", async () => {
		const dir = mkdtempSync(join(root, "case-"));
		writeFileSync(join(dir, "signs.ass"), ass("Café"));
		const mkv = join(dir, "show.mkv");
		const muxed = await run(["mkvmerge", "-q", "-o", mkv, join(dir, "signs.ass"), "--attachment-name", "NotoSans-Regular.ttf", "--attach-file", FONT]);
		expect(muxed.code).toBe(0);
		const settings = getDefaultJobSettings();

		const cut = await refreshFonts({ mkvPath: mkv, texts: [ass("Café")], settings, tempDir: dir, cutOthers: true });
		expect(cut.cut).toBe(1);
		expect(cut.attach[0]!.fileName).toBe("NotoSans-Regular.ttf");
		expect(Bun.file(cut.attach[0]!.path).size).toBeLessThan(Bun.file(FONT).size / 4);
		expect(originalsUsage().count).toBe(1);

		const cutMkv = join(dir, "cut.mkv");
		await run(["mkvmerge", "-q", "-o", cutMkv, ...dropAttachmentArgs(cut.dropAttachmentIds), mkv, ...cut.attachArgs]);
		const state = await fileFontState(cutMkv, settings, dir);
		expect(state.cutCount).toBe(1);

		// The same text needs nothing, and Cyrillic the cut font lacks is restored from the original.
		expect((await refreshFonts({ mkvPath: cutMkv, texts: [ass("Café")], state, settings, tempDir: dir })).attach).toEqual([]);
		const restored = await refreshFonts({ mkvPath: cutMkv, texts: [ass("Café Жук")], state, settings, tempDir: dir });
		expect(restored.restored).toBe(1);

		// Rebuilding without cutting puts the full original back.
		const whole = await refreshFonts({ mkvPath: cutMkv, texts: [ass("Café")], state, settings, tempDir: dir, uncut: true });
		expect(Bun.file(whole.attach[0]!.path).size).toBe(Bun.file(FONT).size);
		clearOriginals();
	}, 60_000);
});
