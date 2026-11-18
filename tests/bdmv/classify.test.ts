import { describe, expect, test } from "bun:test";
import { classifyDisc, classifyMovieDisc, discShape, equalSplit, type DiscPlaylist } from "../../src/bdmv/classify";
import { parseMpls, playlistTimeline } from "../../src/bdmv/mpls";
import { buildMpls, type BuildItem, type BuildMark } from "./mpls-builder";

const EP = 1422; // 23:42
const RUNTIME = 23 * 60;

const playlist = (name: string, items: BuildItem[], marks: BuildMark[] = []): DiscPlaylist => ({ name, mpls: parseMpls(buildMpls(items, marks)) });

/** Avant, OP, A part, B part, ED and preview, as anime discs mark them. */
const episodeMarks = (item: number, base: number): BuildMark[] => [0, 95, 185, 700, 1300, 1390].map((at) => ({ item, at: base + at }));

describe("parseMpls", () => {
	test("reads play items, marks and stream languages", () => {
		const mpls = parseMpls(
			buildMpls(
				[
					{ clip: "00003", in: 10, out: 100, audio: ["jpn", "eng"], subtitles: ["eng"] },
					{ clip: "00004", in: 0, out: 50, angles: 2 },
				],
				[
					{ item: 0, at: 10 },
					{ item: 0, at: 40 },
					{ item: 1, at: 20 },
					{ item: 1, at: 30, type: 2 },
				],
			),
		);
		expect(mpls.items.map((i) => [i.clip, i.inTime / 45000, i.outTime / 45000, i.multiAngle])).toEqual([
			["00003", 10, 100, false],
			["00004", 0, 50, true],
		]);
		expect(mpls.items[0]!.audio.map((s) => s.language)).toEqual(["jpn", "eng"]);
		expect(mpls.items[0]!.subtitles.map((s) => s.language)).toEqual(["eng"]);
		expect(mpls.items[1]!.audio.map((s) => s.language)).toEqual(["jpn"]);
		expect(mpls.marks).toHaveLength(4);
	});

	test("puts chapters on the playlist's timeline and leaves out link points", () => {
		const timeline = playlistTimeline(
			parseMpls(
				buildMpls(
					[
						{ clip: "00003", in: 10, out: 100 },
						{ clip: "00004", in: 0, out: 50 },
					],
					[
						{ item: 0, at: 10 },
						{ item: 0, at: 40 },
						{ item: 1, at: 20 },
						{ item: 1, at: 30, type: 2 },
					],
				),
			),
		);
		expect(timeline.duration).toBe(140);
		expect(timeline.itemStarts).toEqual([0, 90]);
		expect(timeline.chapters).toEqual([0, 30, 110]);
	});

	test("rejects other files", () => {
		expect(() => parseMpls(Buffer.from("MOBJ0200".padEnd(64, "\0")))).toThrow();
	});
});

describe("equalSplit", () => {
	test("picks the points that make the ranges most equal", () => {
		expect(equalSplit([10, 95, 100, 190, 205, 290], 0, 300, 3)).toEqual([100, 205]);
	});

	test("gives up when there are too few points", () => {
		expect(equalSplit([100], 0, 300, 3)).toBeNull();
	});
});

describe("classifyDisc", () => {
	test("splits a Play All that gives each episode its own play item", () => {
		const items = Array.from({ length: 6 }, (_, i) => ({ clip: "00003", in: 600 + i * EP, out: 600 + (i + 1) * EP, subtitles: ["jpn"] }));
		const marks = items.flatMap((item, i) => episodeMarks(i, item.in));
		const result = classifyDisc(
			[
				playlist("00000", [{ clip: "00000", in: 0, out: 8 }]),
				playlist("00002", items, marks),
				playlist("00003", [{ clip: "00002", in: 0, out: 91 }]),
				playlist("00004", [{ clip: "00004", in: 0, out: 5 }]),
			],
			{ runtime: RUNTIME },
		);
		const episodes = result.filter((r) => r.kind === "episode");
		expect(episodes).toHaveLength(6);
		expect(episodes.every((e) => e.playlist === "00002" && e.split === "items")).toBe(true);
		expect(episodes.map((e) => [e.start, e.end])).toEqual(Array.from({ length: 6 }, (_, i) => [i * EP, (i + 1) * EP]));
		expect(episodes[0]!.subtitles).toEqual(["jpn"]);
		expect(result.filter((r) => r.kind === "extra").map((r) => r.playlist)).toEqual(["00003"]);
	});

	test("splits one long play item at the chapters that start episodes", () => {
		// Episodes differ a little in length, as they do on discs.
		const lengths = [1422, 1420, 1425, 1421, 1418, 1393];
		const starts = lengths.map((_, i) => lengths.slice(0, i).reduce((a, b) => a + b, 0));
		const total = starts[5]! + lengths[5]!;
		const marks = starts.flatMap((s, i) => (i === 5 ? [0, 95, 185, 700, 1300] : [0, 95, 185, 700, 1300, 1390]).map((at) => ({ item: 0, at: s + at })));
		const result = classifyDisc([playlist("00001", [{ clip: "00001", in: 0, out: total }], marks)], { runtime: RUNTIME });
		expect(result.map((r) => [r.kind, r.split])).toEqual(Array.from({ length: 6 }, () => ["episode", "chapters"]));
		expect(result.map((r) => r.start)).toEqual(starts);
		expect(result[5]!.end).toBe(total);
		expect(result[0]!.note).toContain("chapters");
	});

	test("keeps the shared opening and ending with their episode", () => {
		const items: BuildItem[] = [];
		for (let i = 0; i < 4; i++) {
			items.push({ clip: "00010", in: 0, out: 90 }, { clip: String(20 + i).padStart(5, "0"), in: 0, out: 1240 }, { clip: "00011", in: 0, out: 90 });
		}
		const result = classifyDisc([playlist("00001", items)], { runtime: RUNTIME });
		expect(result.map((r) => [r.start, r.end, r.split])).toEqual(Array.from({ length: 4 }, (_, i) => [i * 1420, (i + 1) * 1420, "items"]));
	});

	test("leaves out the logo before the first episode", () => {
		const items: BuildItem[] = [{ clip: "00000", in: 0, out: 10 }, ...Array.from({ length: 3 }, (_, i) => ({ clip: "00003", in: i * EP, out: (i + 1) * EP }))];
		const result = classifyDisc([playlist("00002", items)], { runtime: RUNTIME });
		expect(result.map((r) => [r.start, r.end])).toEqual(Array.from({ length: 3 }, (_, i) => [10 + i * EP, 10 + (i + 1) * EP]));
	});

	test("uses one playlist per episode when there is no Play All", () => {
		const result = classifyDisc(
			[1, 2, 3].map((n) => playlist(String(n).padStart(5, "0"), [{ clip: String(n + 10).padStart(5, "0"), in: 0, out: EP }])),
			{ runtime: RUNTIME },
		);
		expect(result.map((r) => [r.kind, r.playlist, r.split])).toEqual([
			["episode", "00001", "playlist"],
			["episode", "00002", "playlist"],
			["episode", "00003", "playlist"],
		]);
	});

	test("drops episode playlists the Play All already plays, and twins of a playlist", () => {
		const single = (n: number) => playlist(String(n).padStart(5, "0"), [{ clip: String(n + 10).padStart(5, "0"), in: 0, out: EP }]);
		const all = playlist(
			"00009",
			[1, 2, 3].map((n) => ({ clip: String(n + 10).padStart(5, "0"), in: 0, out: EP })),
		);
		const ncop = playlist("00010", [{ clip: "00030", in: 0, out: 90 }]);
		const ncopTwin = playlist("00011", [{ clip: "00030", in: 0, out: 90 }]);
		const result = classifyDisc([single(1), single(2), single(3), all, ncop, ncopTwin], { runtime: RUNTIME });
		expect(result.filter((r) => r.kind === "episode").map((r) => [r.playlist, r.split])).toEqual([
			["00009", "items"],
			["00009", "items"],
			["00009", "items"],
		]);
		expect(result.filter((r) => r.kind === "extra").map((r) => r.playlist)).toEqual(["00010"]);
	});

	test("offers an episode-length playlist outside the Play All as a possible special", () => {
		const items = Array.from({ length: 2 }, (_, i) => ({ clip: "00003", in: i * EP, out: (i + 1) * EP }));
		const result = classifyDisc([playlist("00002", items), playlist("00005", [{ clip: "00008", in: 0, out: 1500 }])], { runtime: RUNTIME });
		const extra = result.find((r) => r.kind === "extra")!;
		expect(extra.playlist).toBe("00005");
		expect(extra.note).toContain("special");
	});

	test("takes the episode count of a disc when it is given", () => {
		const items = Array.from({ length: 4 }, (_, i) => ({ clip: "00003", in: i * EP, out: (i + 1) * EP }));
		const result = classifyDisc([playlist("00002", items)], { runtime: RUNTIME, episodes: 2 });
		expect(result.map((r) => [r.start, r.end])).toEqual([
			[0, 2 * EP],
			[2 * EP, 4 * EP],
		]);
	});

	test("keeps the dub credits after each episode with it and skips a looped menu", () => {
		// Laid out like the Cyberpunk: Edgerunners discs.
		const lengths = [1440, 1443, 1448];
		const items = lengths.flatMap((length, i) => [
			{ clip: `0000${2 * i}`, in: 0, out: length },
			{ clip: `0000${2 * i + 1}`, in: 0, out: 19 },
		]);
		const loop = Array.from({ length: 501 }, () => ({ clip: "00007", in: 0, out: 53 }));
		const result = classifyDisc([playlist("00001", [{ clip: "00006", in: 0, out: 31 }]), playlist("00002", loop), playlist("00003", items)], {
			runtime: 27 * 60,
		});
		expect(result.filter((r) => r.kind === "episode").map((r) => [r.playlist, r.start, r.end])).toEqual([
			["00003", 0, 1459],
			["00003", 1459, 2921],
			["00003", 2921, 4388],
		]);
		expect(result.filter((r) => r.kind === "extra").map((r) => [r.playlist, r.selected])).toEqual([["00001", false]]);
	});
});

describe("splitEpisodes edge cases", () => {
	test("splits short items when the disc's episode count is given", () => {
		const items = Array.from({ length: 3 }, (_, i) => ({ clip: "00003", in: i * 20, out: (i + 1) * 20 }));
		const result = classifyDisc([playlist("00002", items)], { runtime: RUNTIME, episodes: 3 });
		expect(result.map((r) => [r.start, r.end])).toEqual([
			[0, 20],
			[20, 40],
			[40, 60],
		]);
	});
});

describe("classifyMovieDisc", () => {
	const FILM = 6360; // 1:46:00
	const featureItems = (clips: number[]): BuildItem[] => clips.map((c) => ({ clip: String(c).padStart(5, "0"), in: 0, out: FILM / 4 }));

	test("takes the playlist closest to the runtime and offers the rest as extras", () => {
		const result = classifyMovieDisc(
			[
				playlist("00000", [{ clip: "00000", in: 0, out: 10 }]),
				playlist("00800", featureItems([10, 11, 12, 13])),
				playlist("00801", [{ clip: "00020", in: 0, out: 120 }]),
				playlist("00802", [{ clip: "00021", in: 0, out: 1800 }]),
			],
			{ runtime: FILM },
		);
		expect(result.map((r) => [r.kind, r.playlist, r.selected])).toEqual([
			["movie", "00800", undefined],
			["extra", "00801", undefined],
			["extra", "00802", undefined],
		]);
	});

	test("picks the playlist that plays the clips in order out of shuffled decoys", () => {
		const real = featureItems([10, 11, 12, 13]);
		const decoys = [
			[12, 10, 13, 11],
			[11, 13, 10, 12],
			[13, 12, 11, 10],
		].map((order, i) => playlist(String(800 + i).padStart(5, "0"), featureItems(order)));
		const result = classifyMovieDisc([...decoys, playlist("00850", real)], { runtime: FILM });
		const movies = result.filter((r) => r.kind === "movie");
		expect(movies.map((r) => r.playlist)).toEqual(["00850"]);
		expect(movies[0]!.note).toContain("Chosen from 4 playlists");
	});

	test("says so when it cannot tell the decoys apart", () => {
		const result = classifyMovieDisc([playlist("00800", featureItems([12, 10, 13, 11])), playlist("00801", featureItems([13, 11, 12, 10]))], {
			runtime: FILM,
		});
		expect(result.filter((r) => r.kind === "movie")[0]!.note).toContain("could not tell");
	});

	test("does not take a cut with a few minutes added for a decoy", () => {
		const theatrical = featureItems([10, 11, 12, 13]);
		const extended: BuildItem[] = [...theatrical.slice(0, 2), { clip: "00030", in: 0, out: 420 }, ...theatrical.slice(2)];
		const result = classifyMovieDisc([playlist("00800", featureItems([12, 10, 13, 11])), playlist("00802", theatrical), playlist("00810", extended)], {
			runtime: FILM,
		});
		expect(result.filter((r) => r.kind === "movie").map((r) => [r.playlist, r.selected ?? true])).toEqual([
			["00802", true],
			["00810", false],
		]);
		expect(result[0]!.note).toBeUndefined();
	});

	test("offers another cut unticked", () => {
		const theatrical = featureItems([10, 11, 12, 13]);
		const extended: BuildItem[] = [...theatrical.slice(0, 2), { clip: "00030", in: 0, out: 900 }, ...theatrical.slice(2)];
		const result = classifyMovieDisc([playlist("00001", extended), playlist("00002", theatrical)], { runtime: FILM });
		expect(result.map((r) => [r.playlist, r.selected ?? true])).toEqual([
			["00002", true],
			["00001", false],
		]);
		expect(result[1]!.note).toBe("Another cut, 15 min longer. Tick it and name its edition to keep both.");
	});

	test("takes the longest playlist when the runtime is unknown", () => {
		const result = classifyMovieDisc([playlist("00001", [{ clip: "00001", in: 0, out: 3000 }]), playlist("00002", [{ clip: "00002", in: 0, out: 5000 }])]);
		expect(result.map((r) => [r.playlist, r.selected ?? true])).toEqual([
			["00002", true],
			["00001", false],
		]);
	});
});

describe("discShape", () => {
	test("leaves long playlists to the lookups and settles short ones", () => {
		const episodes = playlist(
			"00002",
			Array.from({ length: 6 }, (_, i) => ({ clip: "00003", in: i * EP, out: (i + 1) * EP })),
		);
		expect(discShape([[episodes]])).toBe("series-like");
		expect(discShape([[playlist("00001", [{ clip: "00001", in: 0, out: 6360 }])]])).toBe("unclear");
		expect(discShape([[playlist("00001", [{ clip: "00001", in: 0, out: 2800 }])]])).toBe("series");
	});
});
