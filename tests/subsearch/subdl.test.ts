import { describe, expect, it } from "bun:test";
import { deflateRawSync } from "zlib";
import { buildZip, isZip, readZip } from "../../src/core/zip";
import type { MediaIdentity } from "../../src/subsearch/identify";
import { candidateCredit } from "../../src/subsearch/naming";
import { pickArchiveEntry, subdlLanguage, subdlListings, subdlSearchParams } from "../../src/subsearch/subdl";

const text = (s: string) => new TextEncoder().encode(s);

/** A ZIP with deflated entries, the way most archives come. */
function deflatedZip(entries: { name: string; data: Uint8Array }[]): Uint8Array {
	const parts: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;
	for (const e of entries) {
		const name = text(e.name);
		const packed = new Uint8Array(deflateRawSync(e.data));
		const crc = Bun.hash.crc32(e.data) >>> 0;
		const local = new Uint8Array(30 + name.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true);
		lv.setUint16(8, 8, true);
		lv.setUint32(14, crc, true);
		lv.setUint32(18, packed.length, true);
		lv.setUint32(22, e.data.length, true);
		lv.setUint16(26, name.length, true);
		local.set(name, 30);
		const c = new Uint8Array(46 + name.length);
		const cv = new DataView(c.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(10, 8, true);
		cv.setUint32(16, crc, true);
		cv.setUint32(20, packed.length, true);
		cv.setUint32(24, e.data.length, true);
		cv.setUint16(28, name.length, true);
		cv.setUint32(42, offset, true);
		c.set(name, 46);
		parts.push(local, packed);
		central.push(c);
		offset += local.length + packed.length;
	}
	const size = central.reduce((n, c) => n + c.length, 0);
	const end = new Uint8Array(22);
	const ev = new DataView(end.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, entries.length, true);
	ev.setUint16(10, entries.length, true);
	ev.setUint32(12, size, true);
	ev.setUint32(16, offset, true);
	return new Uint8Array(Buffer.concat([...parts, ...central, end]));
}

describe("readZip", () => {
	it("reads stored and deflated entries", () => {
		const entries = [
			{ name: "a.srt", data: text("1\n00:00:01,000 --> 00:00:02,000\nHello\n".repeat(50)) },
			{ name: "folder/b.ass", data: text("[Script Info]") },
		];
		for (const zip of [buildZip(entries), deflatedZip(entries)]) {
			expect(isZip(zip)).toBe(true);
			const read = readZip(zip);
			expect(read.map((e) => e.name)).toEqual(["a.srt", "folder/b.ass"]);
			expect(new TextDecoder().decode(read[0]!.data)).toBe(new TextDecoder().decode(entries[0]!.data));
		}
		expect(isZip(text("1\n00:00:01,000"))).toBe(false);
		expect(() => readZip(text("not a zip at all, just some text that is long enough"))).toThrow();
	});
});

describe("SubDL", () => {
	it("maps language tags to SubDL codes", () => {
		expect(subdlLanguage("slv")).toBe("SL");
		expect(subdlLanguage("eng")).toBe("EN");
		expect(subdlLanguage("pt-BR")).toBe("BR_PT");
		expect(subdlLanguage("por")).toBe("PT");
		expect(subdlLanguage("zh-Hant")).toBe("ZH_BG");
		expect(subdlLanguage("chi")).toBe("ZH");
		expect(subdlLanguage("fil")).toBe("TL");
		expect(subdlLanguage("xyz")).toBeNull();
	});

	it("searches an episode by its series, season and episode", () => {
		const episode: MediaIdentity = { kind: "episode", title: "Solo Leveling", season: 1, episode: 3, imdbId: "tt100", parentImdbId: "tt21209876", sources: [] };
		const params = subdlSearchParams(episode, ["SL", "EN"]);
		expect(params).toMatchObject({ imdb_id: "tt21209876", season_number: "1", episode_number: "3", type: "tv", languages: "EN,SL" });
		const titleOnly = subdlSearchParams({ ...episode, parentImdbId: undefined }, ["SL"]);
		expect(titleOnly.film_name).toBe("Solo Leveling");
		expect(titleOnly.imdb_id).toBeUndefined();
		const movie = subdlSearchParams({ kind: "movie", title: "The Matrix", year: 1999, sources: [] }, ["SL"]);
		expect(movie).toMatchObject({ film_name: "The Matrix", year: "1999", type: "movie" });
	});

	it("takes the searched episode out of a season pack", () => {
		const identity: MediaIdentity = { kind: "episode", title: "Show", season: 1, episode: 2, sources: [] };
		const pack = {
			release_name: "Show.S01.1080p.WEB-DL-GRP",
			name: "pack.zip",
			url: "/subtitle/9-10.zip",
			language: "EN",
			hi: false,
			full_season: true,
			unpack_files: [1, 2, 3].map((n) => ({
				file_n_id: `f${n}`,
				name: `Show.S01E0${n}.srt`,
				release_name: `Show.S01E0${n}.1080p.WEB-DL-GRP`,
				season: 1,
				episode: n,
				language: "EN",
				hi: false,
				url: `/subtitle/9/f${n}`,
			})),
		};
		const listings = subdlListings(pack, identity);
		expect(listings.map((l) => l.key)).toEqual(["sd-9-f2"]);
		expect(listings[0]!.downloadPath).toBe("/subtitle/9/f2");
		const single = subdlListings({ ...pack, unpack_files: undefined }, identity);
		expect(single[0]).toMatchObject({ key: "sd-9-10", season: 1, episode: 2, language: "EN" });
	});

	it("picks the episode's file from an archive of several", () => {
		const entries = [
			{ name: "Show.S01E01.srt", data: text("x".repeat(500)) },
			{ name: "Show.S01E02.srt", data: text("x".repeat(100)) },
			{ name: "info.nfo", data: text("x".repeat(900)) },
		];
		expect(pickArchiveEntry(entries, 1, 2)!.name).toBe("Show.S01E02.srt");
		expect(pickArchiveEntry(entries)!.name).toBe("Show.S01E01.srt");
		expect(pickArchiveEntry([entries[2]!])).toBeUndefined();
	});

	it("credits SubDL when nothing names anyone", () => {
		expect(candidateCredit("Movie.2020.WEB-DL", "", "", "subdl")).toBe("SubDL");
		expect(candidateCredit("Movie.2020.WEB-DL", "Anonymous")).toBe("OpenSubtitles");
	});
});
