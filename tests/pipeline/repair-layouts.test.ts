import { describe, expect, test } from "bun:test";
import type { RepairInspectionFile, RepairLayoutTrackPlan, RepairSubtitleTrack } from "../../src/core/types";
import { buildLayoutRepairPlans, groupSourceLayouts, planToLayoutTracks } from "../../src/pipeline/repair-layouts";

function subtitle(id: number, title: string, options: Partial<RepairSubtitleTrack> = {}): RepairSubtitleTrack {
	return {
		id,
		codec: "SubStationAlpha",
		codecId: "S_TEXT/ASS",
		language: "en",
		title,
		isDefault: false,
		isForced: title.includes("Signs"),
		isEnabled: true,
		isHearingImpaired: false,
		isOriginal: false,
		isCommentary: false,
		canRabbitProcess: true,
		currentCompression: "none",
		...options,
	};
}

const pgs = { codec: "HDMV PGS", codecId: "S_HDMV/PGS", canRabbitProcess: false };

const episode = (path: string): RepairInspectionFile => ({
	path,
	filename: path,
	durationSeconds: 1400,
	subtitles: [
		subtitle(5, "[Coalgirls] Signs/Songs"),
		subtitle(6, "[Coalgirls] Full Subtitles"),
		subtitle(7, "[Taka] Signs/Songs"),
		subtitle(8, "[Taka] Full Subtitles"),
		subtitle(10, "[PGS] Full Subtitles", pgs),
	],
});

const ova = (path: string): RepairInspectionFile => ({
	path,
	filename: path,
	durationSeconds: 1400,
	subtitles: [subtitle(3, "[Coalgirls] Signs/Songs"), subtitle(4, "[Umee] Full Subtitles"), subtitle(5, "[PGS] Full Subtitles", pgs)],
});

const plan = (position: number, title: string, options: Partial<RepairLayoutTrackPlan> = {}): RepairLayoutTrackPlan => ({
	position,
	mode: "copy",
	order: 0,
	title,
	language: "en",
	compression: "preserve",
	isDefault: false,
	isForced: false,
	isEnabled: true,
	isHearingImpaired: false,
	isOriginal: false,
	isCommentary: false,
	...options,
});

describe("batch subtitle layouts", () => {
	test("groups sources with the same tracks, the largest group first", () => {
		const layouts = groupSourceLayouts([ova("/s/20.5.mkv"), episode("/s/01.mkv"), episode("/s/02.mkv")]);

		expect(layouts.map((layout) => [layout.label, layout.sourcePaths])).toEqual([
			["A", ["/s/01.mkv", "/s/02.mkv"]],
			["B", ["/s/20.5.mkv"]],
		]);
		expect(layouts[0]!.tracks.map((track) => track.releaseGroup)).toEqual(["Coalgirls", "Coalgirls", "Taka", "Taka", null]);
	});

	test("turns a workflow plan into positions", () => {
		const tracks = planToLayoutTracks(
			[{ ...plan(0, "Signs & Songs [Taka]"), source: "source", trackId: 7 } as never, { ...plan(0, "Kept"), source: "target", trackId: 1 } as never],
			episode("/s/01.mkv").subtitles,
		);

		expect(tracks.map((track) => [track.position, track.title])).toEqual([[2, "Signs & Songs [Taka]"]]);
	});

	test("maps each pair onto the track IDs of its own source", () => {
		const sources = new Map([
			["/s/01.mkv", episode("/s/01.mkv")],
			["/s/20.5.mkv", ova("/s/20.5.mkv")],
		]);
		const [a, b] = groupSourceLayouts([...sources.values()]);
		const plans = buildLayoutRepairPlans({
			pairs: [
				{ targetPath: "/e/01.mkv", sourcePath: "/s/01.mkv" },
				{ targetPath: "/e/20.5.mkv", sourcePath: "/s/20.5.mkv" },
			],
			sources,
			layouts: [
				{
					signature: a!.signature,
					tracks: [plan(3, "Full Subtitles (Honorifics) [Taka]", { language: "en-JP", isDefault: true }), plan(2, "Signs & Songs [Taka]")],
				},
				{ signature: b!.signature, tracks: [plan(1, "Full Subtitles (Honorifics) [Umee]")] },
			],
			replaceTarget: true,
		});

		expect(plans[0]!.tracks.map((track) => [track.source, track.trackId, track.order, track.title, track.language])).toEqual([
			["source", 8, 0, "Full Subtitles (Honorifics) [Taka]", "en-JP"],
			["source", 7, 1, "Signs & Songs [Taka]", "en"],
		]);
		expect(plans[0]!.replaceFromSource).toBe(false);
		expect(plans[1]!.tracks.map((track) => track.trackId)).toEqual([4]);
	});

	test("refuses a source whose layout has no plan", () => {
		const sources = new Map([["/s/20.5.mkv", ova("/s/20.5.mkv")]]);
		const [a] = groupSourceLayouts([episode("/s/01.mkv")]);

		expect(() =>
			buildLayoutRepairPlans({
				pairs: [{ targetPath: "/e/20.5.mkv", sourcePath: "/s/20.5.mkv" }],
				sources,
				layouts: [{ signature: a!.signature, tracks: [] }],
				replaceTarget: true,
			}),
		).toThrow("changed since the layouts were read");
	});

	test("refuses Rabbit defaults on a picture subtitle and positions that do not exist", () => {
		const sources = new Map([["/s/01.mkv", episode("/s/01.mkv")]]);
		const [a] = groupSourceLayouts([...sources.values()]);
		const build = (tracks: RepairLayoutTrackPlan[]) =>
			buildLayoutRepairPlans({
				pairs: [{ targetPath: "/e/01.mkv", sourcePath: "/s/01.mkv" }],
				sources,
				layouts: [{ signature: a!.signature, tracks }],
				replaceTarget: true,
			});

		expect(() => build([plan(4, "PGS", { mode: "rabbit" })])).toThrow("cannot use Rabbit defaults");
		expect(() => build([plan(9, "Nothing")])).toThrow("does not exist");
		expect(() => build([plan(1, "One"), plan(1, "Twice")])).toThrow("more than once");
	});
});
