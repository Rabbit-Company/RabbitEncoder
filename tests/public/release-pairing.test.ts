import { describe, expect, test } from "bun:test";
import { pairingView, pickRelease, releaseLabels, shiftBelow, shortNames } from "../../public/features/release-pairing";

const release = (n: string) => `/rel/[Fluff] Show S2 - ${n} [BD 1920x1080 x264 FLAC].mkv`;
const row = (e: number, sources: string[]) => ({
	targetPath: `/enc/Show - S02E0${e}.mkv`,
	targetName: `Show - S02E0${e}.mkv`,
	sources: sources.map((path) => ({ path, name: path.slice(path.lastIndexOf("/") + 1), method: "episode" as const })),
});

describe("shortNames", () => {
	test("cuts what every name shares and keeps numbers whole", () => {
		const names = ["[Fluff] Show S2 - 01 [BD].mkv", "[Fluff] Show S2 - 09 [BD].mkv", "[Fluff] Show S2 - 10 [BD].mkv"];
		expect([...shortNames(names).values()]).toEqual(["01", "09", "10"]);
		expect([...shortNames(["Show - 1.mkv", "Show - 10.mkv"]).values()]).toEqual(["1", "10"]);
		expect([...shortNames(["Show - 01 [x].mkv", "Show - 11 [x].mkv"]).values()]).toEqual(["01", "11"]);
	});

	test("keeps episode titles and leaves a single name whole", () => {
		const names = ["Show - S02E01 - Each Ones Promise [AV1].mkv", "Show - S02E02 - The Next Location [AV1].mkv"];
		expect([...shortNames(names).values()]).toEqual(["01 - Each Ones Promise", "02 - The Next Location"]);
		expect([...shortNames(["Movie [BD].mkv"]).values()]).toEqual(["Movie [BD]"]);
	});

	test("leads with the folder name when there are several folders", () => {
		const labels = releaseLabels(["/a/Show - 01.mkv", "/a/Show - 02.mkv", "/b/Other - 01.mkv", "/b/Other - 02.mkv"]);
		expect(labels.get("/a/Show - 02.mkv")).toBe("a · 02");
		expect(labels.get("/b/Other - 01.mkv")).toBe("b · 01");
	});
});

describe("shifting the episodes below a pick", () => {
	const files: string[] = ["01", "02", "03", "04", "05"].map(release);
	const rows = [row(1, [files[0]!]), row(2, [files[1]!]), row(3, [files[2]!]), row(4, [files[3]!])];
	const view = pairingView(rows, files);

	test("a pick reports how many files it moved", () => {
		expect(pickRelease(view, rows[1]!, 0, files[2]!)).toEqual({ paths: [files[2]!], pick: { targetPath: rows[1]!.targetPath, folder: "/rel", delta: 1 } });
		expect(pickRelease(view, rows[1]!, 0, "").pick).toBeNull();
	});

	test("moves every later episode by the same number of files and drops one past the end", () => {
		const shifted = shiftBelow(view, rows, 1, { targetPath: rows[1]!.targetPath, folder: "/rel", delta: 2 });
		expect([...shifted]).toEqual([
			[rows[2]!.targetPath, [files[4]!]],
			[rows[3]!.targetPath, []],
		]);
	});

	test("flags a release paired with two episodes", () => {
		const doubled = pairingView([row(1, [files[0]!]), row(2, [files[0]!])], files);
		expect(doubled.shared.get(files[0]!)).toEqual([rows[0]!.targetPath, rows[1]!.targetPath]);
		expect(doubled.targets.get(rows[1]!.targetPath)).toBe("02");
	});
});
