import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { alignToReference } from "../../src/subsearch/align";
import { dialogueCues, mapCue, retimeDocument, type Interval } from "../../src/subsearch/cues";
import { decodeSubtitleBytes, toSubDocument } from "../../src/subsearch/formats";
import { measureSync, rateCandidate, releaseMatch } from "../../src/subsearch/score";
import { evaluateDownload, type EvaluatedCandidate } from "../../src/subsearch/search";
import { speechFromLoudness } from "../../src/subsearch/reference";

function srt(cues: Interval[], text = (i: number) => `Line ${i}`): string {
	const tc = (ms: number) => {
		const p = (n: number, w = 2) => String(Math.floor(n)).padStart(w, "0");
		return `${p(ms / 3_600_000)}:${p((ms / 60_000) % 60)}:${p((ms / 1000) % 60)},${p(ms % 1000, 3)}`;
	};
	return cues.map((c, i) => `${i + 1}\n${tc(c.startMs)} --> ${tc(c.endMs)}\n${text(i)}\n`).join("\n");
}

function timeline(count: number, seed = 3): Interval[] {
	let state = seed;
	const rand = () => (state = (state * 16807) % 2147483647) / 2147483647;
	const out: Interval[] = [];
	let t = 20_000;
	for (let i = 0; i < count; i++) {
		const len = 1200 + Math.round(rand() * 2500);
		out.push({ startMs: t, endMs: t + len });
		t += len + 400 + Math.round(rand() * 5000);
	}
	return out;
}

describe("decodeSubtitleBytes", () => {
	it("reads UTF-8 and BOMs", () => {
		expect(decodeSubtitleBytes(new TextEncoder().encode("Čaša"), "sl")).toBe("Čaša");
		expect(decodeSubtitleBytes(new Uint8Array([0xff, 0xfe, 0x0c, 0x01, 0x61, 0x00]), "sl")).toBe("Ča");
	});

	it("reads Slovenian cp1250 and Serbian Cyrillic cp1251", () => {
		expect(decodeSubtitleBytes(new Uint8Array([0xc8, 0x61, 0x9a, 0x61]), "sl")).toBe("Čaša");
		expect(decodeSubtitleBytes(new Uint8Array([0xc7, 0xe4, 0xf0, 0xe0, 0xe2, 0xee]), "sr")).toBe("Здраво");
	});
});

describe("toSubDocument", () => {
	it("converts WebVTT and MicroDVD to SRT", () => {
		const vtt = toSubDocument("WEBVTT\n\n00:01.000 --> 00:02.500\n<c.yellow>Hello</c>\n", "a.vtt", 25)!;
		expect(dialogueCues(vtt)).toEqual([{ startMs: 1000, endMs: 2500, text: "Hello" }]);
		const sub = toSubDocument("{1}{1}25.000\n{50}{100}Hi|there\n", "a.sub", 23.976)!;
		expect(dialogueCues(sub)).toEqual([{ startMs: 2000, endMs: 4000, text: "Hi there" }]);
	});
});

describe("retimeDocument", () => {
	it("shifts SRT cues and drops cues before zero", () => {
		const doc = {
			format: "srt" as const,
			content: srt([
				{ startMs: 500, endMs: 900 },
				{ startMs: 5000, endMs: 6000 },
			]),
		};
		const out = retimeDocument(doc, { scale: 1, pieces: [{ fromMs: 0, offsetMs: -1000 }] });
		expect(dialogueCues(out)).toEqual([{ startMs: 4000, endMs: 5000, text: "Line 1" }]);
	});

	it("only changes ASS times", () => {
		const ass =
			"[Script Info]\nTitle: x\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.50,Default,Bob,0,0,0,,{\\i1}Hi, you\n";
		const out = retimeDocument({ format: "ass", content: ass }, { scale: 1, pieces: [{ fromMs: 0, offsetMs: 1230 }] });
		expect(out.content).toContain("Dialogue: 0,0:00:02.23,0:00:03.73,Default,Bob,0,0,0,,{\\i1}Hi, you");
	});
});

describe("measureSync", () => {
	const ref = timeline(400);
	const duration = ref[ref.length - 1]!.endMs + 60_000;

	it("rates a synced subtitle high and a shifted one near zero", () => {
		expect(measureSync(ref, ref, duration, "subtitle").sync).toBe(1);
		const shifted = ref.map((c) => ({ startMs: c.startMs + 7000, endMs: c.endMs + 7000 }));
		expect(measureSync(shifted, ref, duration, "subtitle").agreement).toBeLessThan(0.25);
	});

	it("finds the missing part of a subtitle", () => {
		const cut = ref.filter((c) => c.startMs < duration / 2);
		const q = measureSync(cut, ref, duration, "subtitle");
		expect(q.missingShare).toBeGreaterThan(0.4);
		expect(q.longestGapMs).toBeGreaterThan(10 * 60_000);
	});
});

describe("syncing to detected speech", () => {
	it("separates the right subtitle from another episode's", () => {
		let state = 42;
		const rand = () => (state = (state * 16807) % 2147483647) / 2147483647;
		const truth = timeline(900);
		const duration = truth[truth.length - 1]!.endMs + 60_000;
		// Speech detection misses lines, splits them and also fires on music.
		const audio: Interval[] = [];
		for (const c of truth) {
			if (rand() < 0.25) continue;
			const mid = (c.startMs + c.endMs) / 2;
			audio.push({ startMs: c.startMs - 150 + rand() * 300, endMs: mid - 100 }, { startMs: mid + 150, endMs: c.endMs + rand() * 400 });
		}
		for (let i = 0; i < 300; i++) {
			const s = rand() * duration;
			audio.push({ startMs: s, endMs: s + 300 + rand() * 4000 });
		}
		const traits = { downloads: 100, hashMatch: false, hearingImpaired: false, machineTranslated: false, trustedUploader: false, releaseMatch: 0, fps: 0 };
		const rate = (cues: Interval[]) => {
			const a = alignToReference(cues, audio);
			return {
				offset: a.map.pieces[0]!.offsetMs,
				rating: rateCandidate(
					measureSync(
						cues.map((c) => mapCue(c, a.map)),
						audio,
						duration,
						"audio",
					),
					traits,
					"avoid",
				),
			};
		};
		const late = rate(truth.map((c) => ({ startMs: c.startMs + 3000, endMs: c.endMs + 3000 })));
		expect(Math.abs(late.offset + 3000)).toBeLessThanOrEqual(150);
		expect(late.rating).toBeGreaterThanOrEqual(80);
		expect(rate(timeline(900, 77)).rating).toBeLessThan(30);
	});
});

describe("releaseMatch", () => {
	it("prefers the same group and source", () => {
		const file = "Movie.2020.1080p.BluRay.x264-SPARKS.mkv";
		const same = releaseMatch("Movie.2020.1080p.BluRay.x264-SPARKS", file, "SPARKS");
		const web = releaseMatch("Movie.2020.1080p.WEB-DL.DDP5.1-NTb", file, "SPARKS");
		expect(same).toBeGreaterThan(0.9);
		expect(web).toBeLessThan(same - 0.4);
	});
});

describe("speechFromLoudness", () => {
	it("finds loud bursts in quiet audio", () => {
		const db = new Float32Array(3000).fill(-70);
		for (let k = 500; k < 600; k++) db[k] = -20;
		for (let k = 1500; k < 1700; k++) db[k] = -25;
		expect(speechFromLoudness(db)).toEqual([
			{ startMs: 10_000, endMs: 12_000 },
			{ startMs: 30_000, endMs: 34_000 },
		]);
	});
});

describe("evaluateDownload", () => {
	const dir = mkdtempSync(join(tmpdir(), "rabbit-subsearch-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const ref = timeline(500);
	const duration = ref[ref.length - 1]!.endMs + 30_000;
	const traits = { downloads: 5000, hashMatch: false, hearingImpaired: false, machineTranslated: false, trustedUploader: false, releaseMatch: 0.5, fps: 0 };
	const fresh = (): EvaluatedCandidate => ({
		key: "os-1",
		provider: "opensubtitles",
		release: "",
		fileName: "x.srt",
		uploader: "",
		url: "",
		downloads: 5000,
		hearingImpaired: false,
		machineTranslated: false,
		trustedUploader: false,
		hashMatch: false,
		fps: 0,
		prior: 0,
		status: "untested",
	});

	it("syncs a late cp1250 subtitle and rates it well", () => {
		const late = ref.map((c) => ({ startMs: c.startMs + 2500, endMs: c.endMs + 2500 }));
		const bytes = new TextEncoder().encode(srt(late, (i) => `Vrstica ${i}`));
		const candidate = fresh();
		evaluateDownload(candidate, bytes, "x.srt", "sl", { kind: "subtitle", label: "ref", intervals: ref }, duration, 23.976, traits, "avoid", (f) =>
			join(dir, `a.${f}`),
		);
		expect(candidate.status).toBe("rated");
		expect(Math.abs(candidate.offsetMs! + 2500)).toBeLessThanOrEqual(10);
		expect(candidate.rating!).toBeGreaterThanOrEqual(90);
		const written = dialogueCues({ format: "srt", content: readFileSync(candidate.syncedPath!, "utf-8") });
		expect(Math.abs(written[10]!.startMs - ref[10]!.startMs)).toBeLessThanOrEqual(10);
	});

	it("rates a subtitle of another episode low", () => {
		const other = timeline(500, 99);
		const candidate = fresh();
		evaluateDownload(
			candidate,
			new TextEncoder().encode(srt(other)),
			"x.srt",
			"en",
			{ kind: "subtitle", label: "ref", intervals: ref },
			duration,
			23.976,
			traits,
			"avoid",
			(f) => join(dir, `b.${f}`),
		);
		expect(candidate.rating!).toBeLessThan(40);
	});
});
