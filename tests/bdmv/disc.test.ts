import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { findDiscFolders, groupDiscSets, guessDiscTitle, guessDiscYear, readDisc } from "../../src/bdmv/disc";
import { scanDiscSet } from "../../src/bdmv/plan";
import { DEFAULT_NAMING_FORMATS } from "../../src/bdmv/naming";
import { buildDiscExtractArgs, buildTimingFixArgs, constantFrameRate, onlyJoinJitter, splitTimestamp } from "../../src/pipeline/disc-extract";
import { parseMpls } from "../../src/bdmv/mpls";
import { buildMpls, type BuildItem } from "./mpls-builder";

const root = mkdtempSync(join(tmpdir(), "rabbit-bdmv-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function makeDisc(path: string, playlists: Record<string, BuildItem[]>, clips: string[]): void {
	for (const dir of ["PLAYLIST", "STREAM", "CLIPINF", "BACKUP/PLAYLIST"]) mkdirSync(join(path, "BDMV", dir), { recursive: true });
	writeFileSync(join(path, "BDMV", "index.bdmv"), Buffer.from("INDX0200".padEnd(132, "\0")));
	for (const [name, items] of Object.entries(playlists)) {
		writeFileSync(join(path, "BDMV", "PLAYLIST", `${name}.mpls`), buildMpls(items));
		writeFileSync(join(path, "BDMV", "BACKUP", "PLAYLIST", `${name}.mpls`), buildMpls(items));
	}
	for (const clip of clips) writeFileSync(join(path, "BDMV", "STREAM", `${clip}.m2ts`), Buffer.alloc(1024));
}

const EP = 1422;
const playAll = (count: number): BuildItem[] => Array.from({ length: count }, (_, i) => ({ clip: "00003", in: i * EP, out: (i + 1) * EP }));
const set = join(root, "[BDMV] Gals Can't be Kind to Otaku!");
makeDisc(join(set, "TCBD_1974_2"), { "00002": playAll(6), "00003": [{ clip: "00002", in: 0, out: 91 }], "00007": [{ clip: "00099", in: 0, out: 500 }] }, [
	"00002",
	"00003",
]);
makeDisc(join(set, "TCBD_1974_1"), { "00000": [{ clip: "00000", in: 0, out: 8 }], "00002": playAll(6) }, ["00000", "00003"]);

describe("disc folders", () => {
	test("needs an index.bdmv to call a folder a disc", () => {
		const bare = join(root, "bare");
		for (const dir of ["PLAYLIST", "STREAM"]) mkdirSync(join(bare, "BDMV", dir), { recursive: true });
		expect(findDiscFolders(bare)).toEqual([]);
		rmSync(bare, { recursive: true });
	});

	test("finds the discs of a set in disc order", () => {
		const discs = findDiscFolders(root);
		expect(discs).toEqual([join(set, "TCBD_1974_1"), join(set, "TCBD_1974_2")]);
		expect(groupDiscSets(discs)).toEqual([{ path: set, discs }]);
		expect(findDiscFolders(join(set, "TCBD_1974_1", "BDMV"))).toEqual([join(set, "TCBD_1974_1")]);
		// Right inside a root, such as the input folder, each disc is a set of its own.
		const loose = [join(root, "Movie A (2016)"), join(root, "Movie B (2019)")];
		expect(groupDiscSets(loose, [root])).toEqual(loose.map((path) => ({ path, discs: [path] })));
		expect(groupDiscSets(discs, [root])).toEqual([{ path: set, discs }]);
	});

	test("names a disc after the folder around a BD_VIDEO wrapper", () => {
		const edge = join(root, "wrapped", "[BDMV] Cyberpunk Edgerunners");
		for (const n of [2, 1]) makeDisc(join(edge, `Disc ${n} [ANZX-1674${n}]`, "BD_VIDEO"), { "00003": playAll(2) }, ["00003"]);
		const discs = findDiscFolders(edge);
		expect(groupDiscSets(discs, [join(root, "wrapped")])).toEqual([{ path: edge, discs }]);
		expect(readDisc(discs[0]!).label).toBe("Disc 1 [ANZX-16741]");
		expect(guessDiscTitle(join(edge, "Disc 1 [ANZX-16741]"), [discs[0]!])).toBe("");
		expect(guessDiscTitle(edge, discs)).toBe("Cyberpunk Edgerunners");
		rmSync(join(root, "wrapped"), { recursive: true });
	});

	test("guesses the title from the set folder and skips catalogue codes", () => {
		expect(guessDiscTitle(set, [join(set, "TCBD_1974_1")])).toBe("Gals Can't be Kind to Otaku!");
		expect(guessDiscTitle(join(root, "TCBD_1974_1"), [])).toBe("");
		expect(guessDiscTitle(join(root, "Show.Name.Vol.2.1080p.BluRay"), [])).toBe("Show Name");
		expect(guessDiscTitle(join(root, "Blade.Runner.2049.2017.1080p.BluRay"), [])).toBe("Blade Runner 2049");
		expect(guessDiscYear(join(root, "Blade.Runner.2049.2017.1080p.BluRay"), [])).toBe(2017);
		expect(guessDiscYear(join(root, "Your Name (2016) [BDMV]"), [])).toBe(2016);
		expect(guessDiscYear(set, [])).toBeUndefined();
	});

	test("reads only playlists whose clips are all there", () => {
		const disc = readDisc(join(set, "TCBD_1974_2"));
		expect(disc.playlists.map((p) => p.name)).toEqual(["00002", "00003"]);
	});

	test("numbers the episodes of both discs in order", () => {
		const scan = scanDiscSet(set, findDiscFolders(set), { guessedTitle: "Gals Can't be Kind to Otaku!", formats: DEFAULT_NAMING_FORMATS });
		expect(scan.discs.map((d) => [d.label, d.episodes])).toEqual([
			["TCBD_1974_1", 6],
			["TCBD_1974_2", 6],
		]);
		const episodes = scan.rows.filter((r) => r.kind === "episode");
		expect(episodes.map((r) => r.episode)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
		expect(episodes[6]!.discLabel).toBe("TCBD_1974_2");
		expect(scan.rows.filter((r) => r.kind === "extra").map((r) => [r.discLabel, r.playlist, r.title])).toEqual([["TCBD_1974_2", "00003", "Disc 2 Extra 1"]]);
		expect(scan.mode).toBe("series");
		expect(scan.identity).toEqual({ title: "Gals Can't be Kind to Otaku!", year: undefined });
	});
});

describe("disc extraction", () => {
	test("formats mkvmerge timestamps", () => {
		expect(splitTimestamp(0)).toBe("00:00:00.000000000");
		expect(splitTimestamp(4266.5)).toBe("01:11:06.500000000");
	});

	test("cuts a range and copies a whole playlist as it is", () => {
		const base = { discPath: "/d/Disc", playlist: "00002", duration: 8532, filename: "x.mkv", relativePath: "Show" };
		expect(buildDiscExtractArgs({ ...base, start: 1422, end: 2844 }, "/t/x.mkv")).toEqual([
			"mkvmerge",
			"--gui-mode",
			"-o",
			"/t/x.mkv",
			"--split",
			"parts:00:23:42.000000000-00:47:24.000000000",
			"/d/Disc/BDMV/PLAYLIST/00002.mpls",
		]);
		expect(buildDiscExtractArgs({ ...base, start: 0, end: 8532 }, "/t/x.mkv")).not.toContain("--split");
	});
});

describe("disc remux timing", () => {
	const mpls = (items: BuildItem[]) => parseMpls(buildMpls(items));
	const episode = { clip: "00000", in: 0, out: 1440, video: 0x61 };
	const credits = { clip: "00001", in: 0, out: 19, video: 0x61 };

	test("retimes a range whose clips share one progressive rate", () => {
		expect(constantFrameRate(mpls([episode, credits]), 0, 1459)).toBe("24000/1001p");
		const plan = { discPath: "/d", playlist: "00003", start: 0, end: 1459, duration: 2918, filename: "e.mkv", relativePath: "x" };
		expect(buildDiscExtractArgs(plan, "/t/e.mkv", { track: 0, rate: "24000/1001p" })).toContain("0:24000/1001p");
	});

	test("keeps the disc's timing when rates differ or the video is interlaced", () => {
		const promo = { clip: "00002", in: 0, out: 60, video: 0x44 };
		expect(constantFrameRate(mpls([episode, credits, promo]), 0, 1519)).toBeNull();
		expect(constantFrameRate(mpls([episode, credits, promo]), 0, 1459)).toBe("24000/1001p");
		expect(constantFrameRate(mpls([{ ...episode, video: 0x41 }]), 0, 1440)).toBeNull();
	});

	test("retimes jumps of a few milliseconds but not dropped frames", () => {
		const frame = 1001 / 24;
		const grid = Array.from({ length: 100 }, (_, i) => Math.round(i * frame));
		expect(onlyJoinJitter(grid, frame)).toBe(false);
		expect(
			onlyJoinJitter(
				grid.map((t, i) => (i >= 60 ? t + 10 : t)),
				frame,
			),
		).toBe(true);
		expect(
			onlyJoinJitter(
				grid.filter((_, i) => i !== 50),
				frame,
			),
		).toBe(false);
	});
	test("moves every track of a range cut after the first clip back to 0", () => {
		const tracks = [
			{ id: 0, type: "video" },
			{ id: 1, type: "audio" },
			{ id: 2, type: "subtitles" },
		];
		expect(buildTimingFixArgs("/t/in.mkv", "/t/out.mkv", tracks, 334)).toEqual([
			"mkvmerge",
			"-o",
			"/t/out.mkv",
			"--sync",
			"0:-334",
			"--sync",
			"1:-334",
			"--sync",
			"2:-334",
			"/t/in.mkv",
		]);
		// The rate already starts the video at 0, so only the other tracks move.
		expect(buildTimingFixArgs("/t/in.mkv", "/t/out.mkv", tracks, 334, "24000/1001p")).toEqual([
			"mkvmerge",
			"-o",
			"/t/out.mkv",
			"--default-duration",
			"0:24000/1001p",
			"--sync",
			"1:-334",
			"--sync",
			"2:-334",
			"/t/in.mkv",
		]);
		expect(buildTimingFixArgs("/t/in.mkv", "/t/out.mkv", tracks, 0, "24000/1001p")).toEqual([
			"mkvmerge",
			"-o",
			"/t/out.mkv",
			"--default-duration",
			"0:24000/1001p",
			"/t/in.mkv",
		]);
	});
});
