import { beforeAll, describe, expect, it } from "bun:test";
import { join } from "path";
import { fontRegistry, type ResolvedFace } from "../../src/fonts/fonts";
import { decodeRecipe, encodeRecipe, instancedFontNames, type FaceRecipe, type InstanceOptions } from "../../src/fonts/font-instance";
import { buildRabbitFaces } from "../../src/fonts/rabbit-faces";

const hasTools = Bun.spawnSync(["python3", "-c", "import fontTools"]).exitCode === 0 && !!Bun.which("fc-scan");
const STOCK = join(import.meta.dir, "../../fonts");

const recipe: FaceRecipe = { group: "Noto Sans", face: "latin.ttf", coords: { wght: 700, wdth: 100 }, bold: false };

const doc = (...lines: string[]) =>
	[
		"[V4+ Styles]",
		"Format: Name, Fontname, Bold, Italic",
		"Style: Default,Noto Sans,0,0",
		"[Events]",
		"Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
		...lines.map((l) => `Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,${l}`),
	].join("\n");

/** Records what the real instancer would have been asked to make. */
function fakeInstancer() {
	const calls: { src: string; coords: Record<string, number>; bold: boolean; options: InstanceOptions }[] = [];
	const instance = async (
		src: string,
		coords: Record<string, number>,
		family: string,
		bold: boolean,
		out: string,
		_s?: AbortSignal,
		options: InstanceOptions = {},
	) => {
		calls.push({ src, coords, bold, options });
		return { path: out, family, names: instancedFontNames(family, bold, undefined, options.italic) };
	};
	return { calls, instance };
}

const build = (texts: string[], subset = false, base?: ResolvedFace) => {
	const fake = fakeInstancer();
	return buildRabbitFaces({ families: [{ family: "Noto Sans", recipe, base }], texts, subset, tempDir: "/tmp/job", instance: fake.instance }).then((r) => ({
		...r,
		calls: fake.calls,
	}));
};

describe("face recipes", () => {
	it("round-trip, and anything else is not a recipe", () => {
		expect(decodeRecipe(encodeRecipe(recipe))).toEqual(recipe);
		expect(decodeRecipe("NotoSans-Regular")).toBeNull();
		expect(decodeRecipe("RabbitEncoder;{broken")).toBeNull();
		expect(decodeRecipe(null)).toBeNull();
	});
});

describe.skipIf(!hasTools)("buildRabbitFaces", () => {
	beforeAll(async () => {
		fontRegistry.configure(STOCK, STOCK);
		await fontRegistry.reload();
	});

	it("pairs the upright face with the italic face of its family and never picks the italic for a track", () => {
		expect(fontRegistry.italicPartner("Noto Sans", "latin.ttf")?.fileName).toBe("latin-italic.ttf");
		expect(fontRegistry.resolve("Noto Sans", "eng", doc("Hello"))?.fileName).toBe("latin.ttf");
	});

	it("makes only the face the style names when the text needs nothing else", async () => {
		const { faces, calls } = await build([doc("Hello")]);
		expect(faces.map((f) => f.fileName)).toEqual(["noto_sans.ttf"]);
		expect(calls[0]!.coords).toEqual({ wght: 700, wdth: 100 });
		expect(calls[0]!.options.unicodes).toBeUndefined();
	});

	it("adds an italic face from the italic file at the same weight", async () => {
		const { faces, calls } = await build([doc("Hello {\\i1}there")]);
		expect(faces.map((f) => f.fileName)).toEqual(["noto_sans.ttf", "noto_sans_italic.ttf"]);
		const italic = calls.find((c) => c.options.italic)!;
		expect(italic.src.endsWith("latin-italic.ttf")).toBe(true);
		expect(italic.coords.wght).toBe(700);
	});

	it("makes bold a weight step heavier, capped at the axis maximum", async () => {
		const { faces, calls } = await build([doc("{\\b1}Loud{\\b0} {\\b1\\i1}both")]);
		expect(faces.map((f) => f.fileName).sort()).toEqual(["noto_sans.ttf", "noto_sans_bold.ttf", "noto_sans_bold_italic.ttf"]);
		for (const call of calls.filter((c) => c.bold)) expect(call.coords.wght).toBe(900);
	});

	it("cannot make a bolder face once the weight is at its heaviest", async () => {
		const fake = fakeInstancer();
		const heavy = { ...recipe, coords: { wght: 900, wdth: 100 } };
		const { faces } = await buildRabbitFaces({
			families: [{ family: "Noto Sans", recipe: heavy }],
			texts: [doc("{\\b1}x")],
			subset: false,
			tempDir: "/tmp/job",
			instance: fake.instance,
		});
		expect(faces.map((f) => f.fileName)).toEqual(["noto_sans.ttf"]);
	});

	it("cuts every face to the family's characters plus a small fixed set", async () => {
		const { calls } = await build([doc("Žabe {\\i1}Ω")], true);
		for (const call of calls) {
			const kept = new Set(call.options.unicodes);
			expect(kept.has(0x17d)).toBe(true); // Ž, drawn upright, kept in the italic too
			expect(kept.has(0x3a9)).toBe(true); // Ω
			expect(kept.has("Q".codePointAt(0)!)).toBe(true); // printable ASCII is always kept
			expect(kept.has(0x4e00)).toBe(false);
		}
	});

	it("reuses the materializer's face when nothing is cut, and gives no face to an unused family", async () => {
		const base: ResolvedFace = { family: "Noto Sans", names: [], path: "/tmp/base.ttf", fileName: "noto_sans.ttf", mime: "font/ttf", axes: [], recipe };
		const reused = await build([doc("Hello")], false, base);
		expect(reused.faces).toEqual([base]);
		expect(reused.calls).toHaveLength(0);
		expect((await build([doc("{\\fnArial}Only Arial")], false, base)).faces).toEqual([]);
	});

	it("reports a family whose group face is gone, so its old faces stay", async () => {
		const fake = fakeInstancer();
		const gone = { ...recipe, face: "missing.ttf" };
		const result = await buildRabbitFaces({
			families: [{ family: "Noto Sans", recipe: gone }],
			texts: [doc("Hello")],
			subset: true,
			tempDir: "/tmp/job",
			instance: fake.instance,
		});
		expect(result.faces).toEqual([]);
		expect([...result.unbuilt]).toEqual(["noto sans"]);
	});
});
