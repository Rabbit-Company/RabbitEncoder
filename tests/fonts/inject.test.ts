import { describe, expect, it } from "bun:test";
import { createFaceMaterializer } from "../../src/fonts/inject";
import { instancedFontNames, type FaceRecipe, type InstanceOptions } from "../../src/fonts/font-instance";
import { DEFAULT_STYLE_APPEARANCE } from "../../src/subtitles/subtitle-style";
import type { ResolvedFace } from "../../src/fonts/fonts";
import type { StyleAppearance } from "../../src/subtitles/subtitle-style";

/** A variable face the way the registry reports one, with a weight axis. */
function variableFace(): ResolvedFace {
	return {
		family: "Noto Sans",
		names: ["notosans"],
		path: "/config/fonts/Noto Sans/latin.ttf",
		fileName: "latin.ttf",
		mime: "font/ttf",
		axes: [{ tag: "wght", name: "Weight", min: 100, default: 400, max: 900 }],
	};
}

function staticFace(): ResolvedFace {
	return { family: "Noto Sans", names: ["notosans"], path: "/config/fonts/Noto Sans/latin.ttf", fileName: "latin.ttf", mime: "font/ttf", axes: [] };
}

const appearance = (over: Partial<StyleAppearance> = {}): StyleAppearance => ({ ...DEFAULT_STYLE_APPEARANCE, ...over });

/** Records what the real instancer would have been asked to produce. */
function fakeInstancer() {
	const calls: { src: string; coords: Record<string, number>; family: string; bold: boolean; out: string; recipe?: FaceRecipe }[] = [];
	const instance = async (
		src: string,
		coords: Record<string, number>,
		family: string,
		bold: boolean,
		out: string,
		_s?: AbortSignal,
		options: InstanceOptions = {},
	) => {
		calls.push({ src, coords, family, bold, out, recipe: options.recipe });
		return { path: out, family, names: instancedFontNames(family, bold) };
	};
	return { calls, instance };
}

describe("createFaceMaterializer", () => {
	it("pins the configured weight axis into a materialized copy", async () => {
		const { calls, instance } = fakeInstancer();
		const materialize = createFaceMaterializer({ tempDir: "/tmp/job", occupiedNames: new Set(), instance });

		const face = await materialize(variableFace(), appearance({ fontAxes: { wght: 700 } }));

		expect(calls).toHaveLength(1);
		expect(calls[0]!.coords).toEqual({ wght: 700 });
		expect(calls[0]!.src).toBe("/config/fonts/Noto Sans/latin.ttf");
		expect(face!.path).toBe(calls[0]!.out); // the ASS-referenced face is the pinned copy
		expect(face!.fileName).toBe("noto_sans.ttf"); // attached under the family, not "latin.ttf"
	});

	it("renames the family when the plain name is already attached", async () => {
		const { instance } = fakeInstancer();
		const occupiedNames = new Set(["notosans"]); // e.g. a face attached by an earlier encode
		const materialize = createFaceMaterializer({ tempDir: "/tmp/job", occupiedNames, instance });

		const face = await materialize(variableFace(), appearance({ fontAxes: { wght: 700 } }));

		expect(face!.family).toBe("Noto Sans 2");
		expect(face!.fileName).toBe("noto_sans_2.ttf");
	});

	it("renames the family when its italic or bold name is already taken", async () => {
		const { instance } = fakeInstancer();
		const materialize = createFaceMaterializer({ tempDir: "/tmp/job", occupiedNames: new Set(["noto sans italic"]), instance });

		const face = await materialize(variableFace(), appearance({ fontAxes: { wght: 700 } }));

		expect(face!.family).toBe("Noto Sans 2");
	});

	it("stores the recipe of a group face in the face it makes", async () => {
		const { calls, instance } = fakeInstancer();
		const materialize = createFaceMaterializer({ tempDir: "/tmp/job", occupiedNames: new Set(), instance });

		const face = await materialize({ ...variableFace(), group: "Noto Sans" }, appearance({ fontAxes: { wght: 700 } }));

		const recipe = { group: "Noto Sans", face: "latin.ttf", coords: { wght: 700 }, bold: false };
		expect(face!.recipe).toEqual(recipe);
		expect(calls[0]!.recipe).toEqual(recipe);
	});

	it("reserves the identity it took, so a second distinct face cannot reuse it", async () => {
		const { instance } = fakeInstancer();
		const occupiedNames = new Set<string>();
		const materialize = createFaceMaterializer({ tempDir: "/tmp/job", occupiedNames, instance });

		const first = await materialize(variableFace(), appearance({ fontAxes: { wght: 700 } }));
		const second = await materialize(
			{ ...variableFace(), path: "/config/fonts/Noto Sans/ja.ttf", fileName: "ja.ttf" },
			appearance({ fontAxes: { wght: 700 } }),
		);

		expect(first!.family).toBe("Noto Sans");
		expect(second!.family).toBe("Noto Sans 2");
	});

	it("reuses one materialized copy for the same face and appearance", async () => {
		const { calls, instance } = fakeInstancer();
		const materialize = createFaceMaterializer({ tempDir: "/tmp/job", occupiedNames: new Set(), instance });

		const first = await materialize(variableFace(), appearance({ fontAxes: { wght: 700 } }));
		const second = await materialize(variableFace(), appearance({ fontAxes: { wght: 700 } }));

		expect(calls).toHaveLength(1);
		expect(second!.path).toBe(first!.path);
		expect(second!.family).toBe("Noto Sans"); // not bumped to "Noto Sans 2" by its own reservation
	});

	it("skips instancing for a static face whose family is free", async () => {
		const { calls, instance } = fakeInstancer();
		const materialize = createFaceMaterializer({ tempDir: "/tmp/job", occupiedNames: new Set(), instance });

		const face = await materialize(staticFace(), appearance({ fontAxes: {} }));

		expect(calls).toHaveLength(0);
		expect(face!.path).toBe("/config/fonts/Noto Sans/latin.ttf");
		expect(face!.fileName).toBe("noto_sans.ttf");
	});

	it("falls back to the original face when instancing fails", async () => {
		const materialize = createFaceMaterializer({ tempDir: "/tmp/job", occupiedNames: new Set(), instance: async () => null });

		const face = await materialize(variableFace(), appearance({ fontAxes: { wght: 700 } }));

		expect(face!.path).toBe("/config/fonts/Noto Sans/latin.ttf");
		expect(face!.family).toBe("Noto Sans");
	});

	it("returns null when the group has no face", async () => {
		const materialize = createFaceMaterializer({ tempDir: "/tmp/job", occupiedNames: new Set() });
		expect(await materialize(null, appearance())).toBeNull();
	});
});
