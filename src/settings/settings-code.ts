import { isValidEncoder } from "../core/encoders";
import type {
	JobSettings,
	EncoderQuality,
	EncoderSpeed,
	DenoiseLevel,
	DebandLevel,
	VideoEncodeMode,
	AudioEncodeMode,
	SubtitleProcessingMode,
	NlmeansParams,
	GradfunParams,
	AudioChannelBitrates,
	VsFilterEntry,
	VsParamValue,
	SubtitleLangDetectMode,
	SubtitleSourcePriority,
	SubtitleFansubTiebreak,
	SubtitleFormatPriority,
	AudioCodecPriority,
	CropMode,
} from "../core/types";
import { vsRegistry } from "../video/vs-filters";

export const SETTINGS_CODE_FORMAT = 1;
export const SETTINGS_CODE_PREFIX = `RE${SETTINGS_CODE_FORMAT}`;

/**
 * Frozen baseline for format RE1. This is a snapshot of the v1 shipped
 * defaults. DO NOT edit these to follow future default changes — bump the
 * format version and add a new baseline instead.
 */
const BASELINE: JobSettings = {
	encoder: "svt-av1-essential",
	manualCrf: 24,
	manualPreset: 4,
	customEncoderParams: "",
	videoEncode: "av1",
	audioEncode: "opus",
	subtitleProcessing: "full",
	quality: "medium",
	finalSpeed: "slow",
	denoise: "off",
	autoDenoiseThresholds: { light: 0.5, medium: 0.7, heavy: 0.9 },
	nlmeansParams: {
		light: { s: 1.0, p: 3, r: 7 },
		medium: { s: 1.5, p: 3, r: 9 },
		heavy: { s: 2.0, p: 3, r: 11 },
	},
	gradfunParams: {
		light: { strength: 0.8, radius: 8 },
		medium: { strength: 1.4, radius: 16 },
		heavy: { strength: 2.8, radius: 24 },
	},
	denoiseBackend: "auto",
	gpuDevice: "0.0",
	crop: "off",
	cropLimit: 0.1,
	deband: "off",
	downscale: false,
	skipBoosting: false,
	noPhaseInv: false,
	dedupeSubtitles: false,
	keepBestAudioChannelsOnly: false,
	removeCommentaryAudio: false,
	audioLanguages: [],
	removeDescriptiveAudio: false,
	removeKaraokeAudio: false,
	dropCompatibilityAudio: true,
	audioCodecPriority: "lossless-first",
	preferUncensoredAudio: true,
	dedupeAudio: true,
	audioLanguagePriority: ["jpn", "eng", "*"],
	renameAudioTracks: false,
	detectCommentaryAudio: true,
	detectDescriptiveAudio: true,
	detectKaraokeAudio: true,
	subtitleLanguagePriority: ["eng", "jpn", "*"],
	subtitleLanguages: [],
	subtitleLangDetect: "enabled",
	subtitleLangDetectConfidence: 0.05,
	detectSignsSongs: true,
	detectSDH: true,
	detectHonorifics: true,
	subtitleSourcePriority: "official-first",
	subtitleFansubTiebreak: "alphabetical",
	subtitleFormatPriority: "text-first",
	dropPictureSubtitles: false,
	dedupeAcrossFormat: true,
	renameSubtitleTracks: true,
	compressSubtitles: false,
	compressSubtitlesMinSavings: 10,
	removeSDHSubtitles: false,
	removeCommentarySubtitles: false,
	removeForcedSignsSongs: false,
	removeStoryboardSubtitles: false,
	removeHonorificsSubtitles: false,
	signsSongsStyleRatio: 0.8,
	signsSongsLineRatio: 0.1,
	sdhRatioThreshold: 0.2,
	sdhMinLines: 10,
	honorificsMinCount: 5,
	honorificsRatio: 3,
	assumeMislabeledTracks: true,
	convertSrtToAss: false,
	restyleAssFont: false,
	assRestyleTargets: ["full", "honorifics", "forced", "sdh", "commentary"],
	removeUnusedFonts: false,
	fontGroup: "Noto Sans",
	audioBitrates: {
		mono: 64,
		stereo: 128,
		"2.1": 160,
		"3.0": 160,
		"3.1": 192,
		"4.0": 192,
		"4.1": 224,
		"5.0": 224,
		"5.1": 256,
		"6.0": 256,
		"6.1": 320,
		"7.0": 320,
		"7.1": 384,
		"7.1.4": 512,
	},
	translateSubtitles: false,
	translateProvider: "openai",
	translateModel: "translategemma:12b",
	translateBaseUrl: "http://localhost:11434",
	translateApiKey: "",
	translateTargetLanguages: [],
	translateBatchSize: 40,
	translateSignsSongs: true,
	translateMaxTokens: 8192,
	translateTimeoutMs: 120000,
	translateConcurrency: 1,
	translateSourceTrack: "auto",
	vsFilters: [],
};

const QUALITY_TO_CODE: Record<EncoderQuality, string> = { low: "l", medium: "m", high: "h" };
const SPEED_TO_CODE: Record<EncoderSpeed, string> = { slower: "sr", slow: "s", medium: "m", fast: "f", faster: "fr" };
const DENOISE_TO_CODE: Record<DenoiseLevel, string> = { off: "o", light: "l", medium: "m", heavy: "h", auto: "a" };
const DEBAND_TO_CODE: Record<DebandLevel, string> = { off: "o", light: "l", medium: "m", heavy: "h" };
const CROP_TO_CODE: Record<CropMode, string> = { off: "o", auto: "a" };

function reverse<T extends string>(map: Record<T, string>): Record<string, T> {
	const out: Record<string, T> = {};
	for (const k in map) out[map[k as T]] = k as T;
	return out;
}
const CODE_TO_QUALITY = reverse(QUALITY_TO_CODE);
const CODE_TO_SPEED = reverse(SPEED_TO_CODE);
const CODE_TO_CROP = reverse(CROP_TO_CODE);
const CODE_TO_DENOISE = reverse(DENOISE_TO_CODE);
const CODE_TO_DEBAND = reverse(DEBAND_TO_CODE);

const AUDIOCODEC_TO_CODE: Record<AudioCodecPriority, string> = { "lossless-first": "l", "smallest-first": "s" };
const CODE_TO_AUDIOCODEC = reverse(AUDIOCODEC_TO_CODE);

const LANGDETECT_TO_CODE: Record<SubtitleLangDetectMode, string> = { enabled: "e", "und-only": "u", disabled: "d" };
const CODE_TO_LANGDETECT = reverse(LANGDETECT_TO_CODE);
const SUBSRC_TO_CODE: Record<SubtitleSourcePriority, string> = { "official-first": "o", "fansub-first": "f" };
const CODE_TO_SUBSRC = reverse(SUBSRC_TO_CODE);
const SUBTIE_TO_CODE: Record<SubtitleFansubTiebreak, string> = { alphabetical: "a", "source-order": "s" };
const CODE_TO_SUBTIE = reverse(SUBTIE_TO_CODE);
const SUBFMT_TO_CODE: Record<SubtitleFormatPriority, string> = { "text-first": "t", "picture-first": "p" };
const CODE_TO_SUBFMT = reverse(SUBFMT_TO_CODE);

const VIDEO_VALUES: VideoEncodeMode[] = ["av1", "off"];
const AUDIO_VALUES: AudioEncodeMode[] = ["opus", "copy"];
const SUB_VALUES: SubtitleProcessingMode[] = ["full", "copy"];

const BITRATE_CHANNELS: { key: keyof AudioChannelBitrates; code: string }[] = [
	{ key: "mono", code: "mo" },
	{ key: "stereo", code: "so" },
	{ key: "2.1", code: "c21" },
	{ key: "3.0", code: "c30" },
	{ key: "3.1", code: "c31" },
	{ key: "4.0", code: "c40" },
	{ key: "4.1", code: "c41" },
	{ key: "5.0", code: "c50" },
	{ key: "5.1", code: "c51" },
	{ key: "6.0", code: "c60" },
	{ key: "6.1", code: "c61" },
	{ key: "7.0", code: "c70" },
	{ key: "7.1", code: "c71" },
	{ key: "7.1.4", code: "c714" },
];

function esc(s: string): string {
	return s.replace(/%/g, "%25").replace(/\|/g, "%7C").replace(/~/g, "%7E").replace(/,/g, "%2C").replace(/=/g, "%3D").replace(/\+/g, "%2B");
}

function unesc(s: string): string {
	return s.replace(/%(7C|7E|2C|3D|2B|25)/gi, (_, h: string) => {
		switch (h.toUpperCase()) {
			case "7C":
				return "|";
			case "7E":
				return "~";
			case "2C":
				return ",";
			case "3D":
				return "=";
			case "2B":
				return "+";
			case "25":
				return "%";
			default:
				return _;
		}
	});
}

function num(n: number): string {
	return String(n);
}

function coerceScalar(s: string): VsParamValue {
	if (s === "true") return true;
	if (s === "false") return false;
	if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
	return s;
}

class Section {
	readonly tag: string;
	private parts: string[] = [];

	constructor(tag: string) {
		this.tag = tag;
	}

	put(key: string, value: string | number | boolean): this {
		const v = typeof value === "boolean" ? (value ? "1" : "0") : typeof value === "number" ? num(value) : esc(value);
		this.parts.push(`${key}=${v}`);
		return this;
	}

	putRaw(key: string, rawValue: string): this {
		this.parts.push(`${key}=${rawValue}`);
		return this;
	}

	get empty(): boolean {
		return this.parts.length === 0;
	}

	toString(): string {
		return `${this.tag}~${this.parts.join(",")}`;
	}
}

function parsePayload(payload: string): Record<string, string> {
	const out: Record<string, string> = {};
	if (!payload) return out;
	for (const pair of payload.split(",")) {
		if (!pair) continue;
		const eq = pair.indexOf("=");
		if (eq < 0) continue;
		const k = pair.slice(0, eq);
		out[k] = pair.slice(eq + 1);
	}
	return out;
}

export function encodeSettingsCode(s: JobSettings): string {
	const sections: string[] = [];

	// core
	const core = new Section("c");
	if (s.encoder !== BASELINE.encoder) core.put("en", s.encoder);
	if (s.manualCrf !== BASELINE.manualCrf) core.put("cr", s.manualCrf);
	if (s.manualPreset !== BASELINE.manualPreset) core.put("pr", s.manualPreset);
	if (s.customEncoderParams !== BASELINE.customEncoderParams) core.put("cp", esc(s.customEncoderParams));
	if (s.quality !== BASELINE.quality) core.put("q", QUALITY_TO_CODE[s.quality] ?? QUALITY_TO_CODE.medium);
	if (s.finalSpeed !== BASELINE.finalSpeed) core.put("sp", SPEED_TO_CODE[s.finalSpeed] ?? SPEED_TO_CODE.slow);
	if (s.videoEncode !== BASELINE.videoEncode) core.put("v", s.videoEncode);
	if (s.audioEncode !== BASELINE.audioEncode) core.put("a", s.audioEncode);
	if (s.subtitleProcessing !== BASELINE.subtitleProcessing) core.put("su", s.subtitleProcessing);
	if (s.crop !== BASELINE.crop) core.put("crp", CROP_TO_CODE[s.crop] ?? CROP_TO_CODE.off);
	if (s.cropLimit !== BASELINE.cropLimit) core.put("cl", s.cropLimit);
	if (s.downscale !== BASELINE.downscale) core.put("ds", s.downscale);
	if (s.skipBoosting !== BASELINE.skipBoosting) core.put("sb", s.skipBoosting);
	if (s.noPhaseInv !== BASELINE.noPhaseInv) core.put("np", s.noPhaseInv);
	if (s.dedupeSubtitles !== BASELINE.dedupeSubtitles) core.put("dd", s.dedupeSubtitles);
	if (s.keepBestAudioChannelsOnly !== BASELINE.keepBestAudioChannelsOnly) core.put("kc", s.keepBestAudioChannelsOnly);
	if (s.removeCommentaryAudio !== BASELINE.removeCommentaryAudio) core.put("rc", s.removeCommentaryAudio);
	if (!core.empty) sections.push(core.toString());

	// denoise
	if (s.denoise !== "off") {
		const dn = new Section("dn");
		dn.put("m", DENOISE_TO_CODE[s.denoise]);
		if (s.denoise === "auto") {
			if (s.autoDenoiseThresholds.light !== BASELINE.autoDenoiseThresholds.light) {
				dn.put("tl", s.autoDenoiseThresholds.light);
			}
			if (s.autoDenoiseThresholds.medium !== BASELINE.autoDenoiseThresholds.medium) {
				dn.put("tm", s.autoDenoiseThresholds.medium);
			}
			if (s.autoDenoiseThresholds.heavy !== BASELINE.autoDenoiseThresholds.heavy) {
				dn.put("th", s.autoDenoiseThresholds.heavy);
			}

			putNlmeansDiff(dn, "l", s.nlmeansParams.light, BASELINE.nlmeansParams.light);
			putNlmeansDiff(dn, "m", s.nlmeansParams.medium, BASELINE.nlmeansParams.medium);
			putNlmeansDiff(dn, "h", s.nlmeansParams.heavy, BASELINE.nlmeansParams.heavy);
		} else {
			const lvl = s.nlmeansParams[s.denoise];
			const base = BASELINE.nlmeansParams[s.denoise];
			putNlmeansDiff(dn, "", lvl, base);
		}
		sections.push(dn.toString());
	}

	// deband
	if (s.deband !== "off") {
		const db = new Section("db");
		db.put("m", DEBAND_TO_CODE[s.deband]);
		const g = s.gradfunParams[s.deband];
		const base = BASELINE.gradfunParams[s.deband];
		putGradfunDiff(db, g, base);
		sections.push(db.toString());
	}

	// audio bitrates (only when Opus, only channels that differ)
	if (s.audioEncode === "opus") {
		const ab = new Section("ab");
		for (const { key, code } of BITRATE_CHANNELS) {
			if (s.audioBitrates[key] !== BASELINE.audioBitrates[key]) ab.put(code, s.audioBitrates[key]);
		}
		if (!ab.empty) sections.push(ab.toString());
	}

	// language selection
	if (s.audioLanguages.length > 0) sections.push(new Section("al").putRaw("v", s.audioLanguages.map(esc).join("+")).toString());
	if (s.subtitleLanguages.length > 0) sections.push(new Section("sl").putRaw("v", s.subtitleLanguages.map(esc).join("+")).toString());

	// subtitle detection
	const sd = new Section("sd");
	if (s.subtitleLangDetect !== BASELINE.subtitleLangDetect) sd.put("ld", LANGDETECT_TO_CODE[s.subtitleLangDetect] ?? "e");
	if (s.subtitleLangDetectConfidence !== BASELINE.subtitleLangDetectConfidence) sd.put("lc", s.subtitleLangDetectConfidence);
	if (s.detectSignsSongs !== BASELINE.detectSignsSongs) sd.put("ss", s.detectSignsSongs);
	if (s.detectSDH !== BASELINE.detectSDH) sd.put("sh", s.detectSDH);
	if (s.detectHonorifics !== BASELINE.detectHonorifics) sd.put("ho", s.detectHonorifics);
	if (s.signsSongsStyleRatio !== BASELINE.signsSongsStyleRatio) sd.put("ssr", s.signsSongsStyleRatio);
	if (s.signsSongsLineRatio !== BASELINE.signsSongsLineRatio) sd.put("slr", s.signsSongsLineRatio);
	if (s.sdhRatioThreshold !== BASELINE.sdhRatioThreshold) sd.put("sdr", s.sdhRatioThreshold);
	if (s.sdhMinLines !== BASELINE.sdhMinLines) sd.put("sdl", s.sdhMinLines);
	if (s.honorificsMinCount !== BASELINE.honorificsMinCount) sd.put("hmc", s.honorificsMinCount);
	if (s.honorificsRatio !== BASELINE.honorificsRatio) sd.put("hr", s.honorificsRatio);
	if (s.assumeMislabeledTracks !== BASELINE.assumeMislabeledTracks) sd.put("am", s.assumeMislabeledTracks);
	if (!sd.empty) sections.push(sd.toString());

	// subtitle manipulation
	const sm = new Section("sm");
	if (s.subtitleSourcePriority !== BASELINE.subtitleSourcePriority) sm.put("sp", SUBSRC_TO_CODE[s.subtitleSourcePriority]);
	if (s.subtitleFansubTiebreak !== BASELINE.subtitleFansubTiebreak) sm.put("tb", SUBTIE_TO_CODE[s.subtitleFansubTiebreak]);
	if (s.subtitleFormatPriority !== BASELINE.subtitleFormatPriority) sm.put("fp", SUBFMT_TO_CODE[s.subtitleFormatPriority]);
	if (s.dropPictureSubtitles !== BASELINE.dropPictureSubtitles) sm.put("dp", s.dropPictureSubtitles);
	if (s.dedupeAcrossFormat !== BASELINE.dedupeAcrossFormat) sm.put("df", s.dedupeAcrossFormat);
	if (s.renameSubtitleTracks !== BASELINE.renameSubtitleTracks) sm.put("rn", s.renameSubtitleTracks);
	if (s.compressSubtitles !== BASELINE.compressSubtitles) sm.put("cz", s.compressSubtitles);
	if (s.compressSubtitlesMinSavings !== BASELINE.compressSubtitlesMinSavings) sm.put("zm", s.compressSubtitlesMinSavings);
	if (s.removeSDHSubtitles !== BASELINE.removeSDHSubtitles) sm.put("rs", s.removeSDHSubtitles);
	if (s.removeCommentarySubtitles !== BASELINE.removeCommentarySubtitles) sm.put("rc", s.removeCommentarySubtitles);
	if (s.removeForcedSignsSongs !== BASELINE.removeForcedSignsSongs) sm.put("rf", s.removeForcedSignsSongs);
	if (s.removeStoryboardSubtitles !== BASELINE.removeStoryboardSubtitles) sm.put("rb", s.removeStoryboardSubtitles);
	if (s.removeHonorificsSubtitles !== BASELINE.removeHonorificsSubtitles) sm.put("rh", s.removeHonorificsSubtitles);
	if (s.subtitleLanguagePriority.join("+") !== BASELINE.subtitleLanguagePriority.join("+")) {
		sm.putRaw("lp", s.subtitleLanguagePriority.map(esc).join("+"));
	}
	if (!sm.empty) sections.push(sm.toString());

	// subtitle styling / fonts
	const st = new Section("st");
	if (s.convertSrtToAss !== BASELINE.convertSrtToAss) st.put("cv", s.convertSrtToAss);
	if (s.restyleAssFont !== BASELINE.restyleAssFont) st.put("ra", s.restyleAssFont);
	if (s.removeUnusedFonts !== BASELINE.removeUnusedFonts) st.put("ru", s.removeUnusedFonts);
	if (s.assRestyleTargets.join("+") !== BASELINE.assRestyleTargets.join("+")) {
		st.putRaw("tg", s.assRestyleTargets.map(esc).join("+"));
	}
	if (!st.empty) sections.push(st.toString());

	// audio manipulation
	const am = new Section("am");
	if (s.removeDescriptiveAudio !== BASELINE.removeDescriptiveAudio) am.put("rd", s.removeDescriptiveAudio);
	if (s.removeKaraokeAudio !== BASELINE.removeKaraokeAudio) am.put("rk", s.removeKaraokeAudio);
	if (s.dropCompatibilityAudio !== BASELINE.dropCompatibilityAudio) am.put("dc", s.dropCompatibilityAudio);
	if (s.audioCodecPriority !== BASELINE.audioCodecPriority) am.put("co", AUDIOCODEC_TO_CODE[s.audioCodecPriority]);
	if (s.preferUncensoredAudio !== BASELINE.preferUncensoredAudio) am.put("pu", s.preferUncensoredAudio);
	if (s.dedupeAudio !== BASELINE.dedupeAudio) am.put("de", s.dedupeAudio);
	if (s.renameAudioTracks !== BASELINE.renameAudioTracks) am.put("rn", s.renameAudioTracks);
	if (s.detectCommentaryAudio !== BASELINE.detectCommentaryAudio) am.put("dco", s.detectCommentaryAudio);
	if (s.detectDescriptiveAudio !== BASELINE.detectDescriptiveAudio) am.put("dde", s.detectDescriptiveAudio);
	if (s.detectKaraokeAudio !== BASELINE.detectKaraokeAudio) am.put("dka", s.detectKaraokeAudio);
	if (s.audioLanguagePriority.join("+") !== BASELINE.audioLanguagePriority.join("+")) {
		am.putRaw("lp", s.audioLanguagePriority.map(esc).join("+"));
	}
	if (!am.empty) sections.push(am.toString());

	// VapourSynth chain (one section per active filter, in order)
	for (const entry of s.vsFilters ?? []) {
		if (!entry || entry.level === "off") continue;
		const vs = new Section("vs");
		vs.put("id", entry.presetId);
		vs.put("lv", entry.level);
		putVsParamDiffs(vs, entry);
		sections.push(vs.toString());
	}

	return [SETTINGS_CODE_PREFIX, ...sections].join("|");
}

function putNlmeansDiff(sec: Section, prefix: string, p: NlmeansParams, base: NlmeansParams): void {
	if (p.s !== base.s) sec.put(`${prefix}s`, p.s);
	if (p.p !== base.p) sec.put(`${prefix}p`, p.p);
	if (p.r !== base.r) sec.put(`${prefix}r`, p.r);
}

function putGradfunDiff(sec: Section, p: GradfunParams, base: GradfunParams): void {
	if (p.strength !== base.strength) sec.put("st", p.strength);
	if (p.radius !== base.radius) sec.put("rd", p.radius);
}

function sameVsParamValue(a: VsParamValue | undefined, b: VsParamValue | undefined): boolean {
	if (a === b) return true;

	if (typeof a === "number" || typeof b === "number") {
		const an = Number(a);
		const bn = Number(b);
		return Number.isFinite(an) && Number.isFinite(bn) && an === bn;
	}

	return false;
}

function putVsParamDiffs(sec: Section, entry: VsFilterEntry): void {
	const active = entry.params?.[entry.level] ?? {};
	const manifest = vsRegistry.get(entry.presetId);

	if (!manifest) {
		for (const key of Object.keys(active)) {
			const val = active[key]!;
			if (typeof val === "boolean") sec.put(key, val ? "true" : "false");
			else sec.put(key, val);
		}
		return;
	}

	for (const spec of manifest.params) {
		const val = active[spec.key];
		if (val === undefined) continue;

		const defaultForLevel = spec.defaults[entry.level];
		if (sameVsParamValue(val, defaultForLevel)) continue;

		if (typeof val === "boolean") sec.put(spec.key, val ? "true" : "false");
		else sec.put(spec.key, val);
	}

	for (const key of Object.keys(active)) {
		if (manifest.params.some((spec) => spec.key === key)) continue;
		const val = active[key]!;
		if (typeof val === "boolean") sec.put(key, val ? "true" : "false");
		else sec.put(key, val);
	}
}

// DECODE

export class SettingsCodeError extends Error {}

export function decodeSettingsCode(code: string): Partial<JobSettings> {
	const raw = (code ?? "").trim();
	if (!raw) throw new SettingsCodeError("Empty settings code.");

	const tokens = raw.split("|");
	const version = tokens[0] ?? "";
	const m = version.match(/^RE(\d+)$/);
	if (!m) throw new SettingsCodeError(`Not a Rabbit settings code (expected "RE<n>...", got "${version.slice(0, 12)}").`);
	const ver = parseInt(m[1]!, 10);
	if (ver !== SETTINGS_CODE_FORMAT) {
		throw new SettingsCodeError(`Unsupported settings-code version RE${ver}. This build understands RE${SETTINGS_CODE_FORMAT}.`);
	}

	// Start from a deep copy of the baseline, then apply overrides.
	const out: JobSettings = structuredClone(BASELINE);
	const vsFilters: VsFilterEntry[] = [];

	for (let i = 1; i < tokens.length; i++) {
		const sectionRaw = tokens[i]!;
		if (!sectionRaw) continue;
		const t = sectionRaw.indexOf("~");
		if (t < 0) continue; // malformed section (skip)
		const tag = sectionRaw.slice(0, t);
		const kv = parsePayload(sectionRaw.slice(t + 1));

		switch (tag) {
			case "c":
				applyCore(out, kv);
				break;
			case "dn":
				applyDenoise(out, kv);
				break;
			case "db":
				applyDeband(out, kv);
				break;
			case "ab":
				applyBitrates(out, kv);
				break;
			case "al":
				out.audioLanguages = splitList(kv.v);
				break;
			case "sl":
				out.subtitleLanguages = splitList(kv.v);
				break;
			case "sd":
				applySubtitleDetect(out, kv);
				break;
			case "sm":
				applySubtitleManip(out, kv);
				break;
			case "st":
				applySubtitleStyle(out, kv);
				break;
			case "am":
				applyAudioManip(out, kv);
				break;
			case "vs": {
				const entry = parseVsSection(kv);
				if (entry) vsFilters.push(entry);
				break;
			}
			default:
				// Unknown section: ignore for forward-compatibility.
				break;
		}
	}

	out.vsFilters = vsFilters;

	// Strip machine-local fields so the importer leaves them as-is.
	const result: Partial<JobSettings> = { ...out };
	delete (result as Partial<JobSettings>).denoiseBackend;
	delete (result as Partial<JobSettings>).gpuDevice;
	delete (result as Partial<JobSettings>).fontGroup;
	return result;
}

function splitList(v: string | undefined): string[] {
	if (!v) return [];
	return v
		.split("+")
		.map((x) => unesc(x).trim())
		.filter((x) => x.length > 0);
}

function applyCore(out: JobSettings, kv: Record<string, string>): void {
	if (kv.en && isValidEncoder(kv.en)) out.encoder = kv.en;
	if (kv.cr !== undefined) out.manualCrf = numOr(kv.cr, out.manualCrf);
	if (kv.pr !== undefined) out.manualPreset = numOr(kv.pr, out.manualPreset);
	if (kv.cp !== undefined) out.customEncoderParams = unesc(kv.cp);
	if (kv.q && CODE_TO_QUALITY[kv.q]) out.quality = CODE_TO_QUALITY[kv.q]!;
	if (kv.sp && CODE_TO_SPEED[kv.sp]) out.finalSpeed = CODE_TO_SPEED[kv.sp]!;
	if (kv.v && (VIDEO_VALUES as string[]).includes(kv.v)) out.videoEncode = kv.v as VideoEncodeMode;
	if (kv.a && (AUDIO_VALUES as string[]).includes(kv.a)) out.audioEncode = kv.a as AudioEncodeMode;
	if (kv.su && (SUB_VALUES as string[]).includes(kv.su)) out.subtitleProcessing = kv.su as SubtitleProcessingMode;
	if (kv.crp && CODE_TO_CROP[kv.crp]) out.crop = CODE_TO_CROP[kv.crp]!;
	if (kv.cl !== undefined) out.cropLimit = parseFloat(kv.cl) || out.cropLimit;
	if (kv.ds !== undefined) out.downscale = kv.ds === "1";
	if (kv.sb !== undefined) out.skipBoosting = kv.sb === "1";
	if (kv.np !== undefined) out.noPhaseInv = kv.np === "1";
	if (kv.dd !== undefined) out.dedupeSubtitles = kv.dd === "1";
	if (kv.kc !== undefined) out.keepBestAudioChannelsOnly = kv.kc === "1";
	if (kv.rc !== undefined) out.removeCommentaryAudio = kv.rc === "1";
}

function applySubtitleDetect(out: JobSettings, kv: Record<string, string>): void {
	if (kv.ld && CODE_TO_LANGDETECT[kv.ld]) out.subtitleLangDetect = CODE_TO_LANGDETECT[kv.ld]!;
	if (kv.lc !== undefined) {
		const c = parseFloat(kv.lc);
		if (Number.isFinite(c) && c >= 0 && c <= 1) out.subtitleLangDetectConfidence = c;
	}
	if (kv.ss !== undefined) out.detectSignsSongs = kv.ss === "1";
	if (kv.sh !== undefined) out.detectSDH = kv.sh === "1";
	if (kv.ho !== undefined) out.detectHonorifics = kv.ho === "1";
	if (kv.ssr !== undefined) {
		const n = parseFloat(kv.ssr);
		if (Number.isFinite(n) && n >= 0 && n <= 1) out.signsSongsStyleRatio = n;
	}
	if (kv.slr !== undefined) {
		const n = parseFloat(kv.slr);
		if (Number.isFinite(n) && n >= 0 && n <= 1) out.signsSongsLineRatio = n;
	}
	if (kv.sdr !== undefined) {
		const n = parseFloat(kv.sdr);
		if (Number.isFinite(n) && n >= 0 && n <= 1) out.sdhRatioThreshold = n;
	}
	if (kv.sdl !== undefined) out.sdhMinLines = numOr(kv.sdl, out.sdhMinLines);
	if (kv.hmc !== undefined) out.honorificsMinCount = numOr(kv.hmc, out.honorificsMinCount);
	if (kv.hr !== undefined) out.honorificsRatio = numOr(kv.hr, out.honorificsRatio);
	if (kv.am !== undefined) out.assumeMislabeledTracks = kv.am === "1";
}

function applySubtitleManip(out: JobSettings, kv: Record<string, string>): void {
	if (kv.sp && CODE_TO_SUBSRC[kv.sp]) out.subtitleSourcePriority = CODE_TO_SUBSRC[kv.sp]!;
	if (kv.tb && CODE_TO_SUBTIE[kv.tb]) out.subtitleFansubTiebreak = CODE_TO_SUBTIE[kv.tb]!;
	if (kv.fp && CODE_TO_SUBFMT[kv.fp]) out.subtitleFormatPriority = CODE_TO_SUBFMT[kv.fp]!;
	if (kv.dp !== undefined) out.dropPictureSubtitles = kv.dp === "1";
	if (kv.df !== undefined) out.dedupeAcrossFormat = kv.df === "1";
	if (kv.rn !== undefined) out.renameSubtitleTracks = kv.rn === "1";
	if (kv.cz !== undefined) out.compressSubtitles = kv.cz === "1";
	if (kv.rs !== undefined) out.removeSDHSubtitles = kv.rs === "1";
	if (kv.rc !== undefined) out.removeCommentarySubtitles = kv.rc === "1";
	if (kv.rf !== undefined) out.removeForcedSignsSongs = kv.rf === "1";
	if (kv.rb !== undefined) out.removeStoryboardSubtitles = kv.rb === "1";
	if (kv.rh !== undefined) out.removeHonorificsSubtitles = kv.rh === "1";
	if (kv.lp !== undefined) out.subtitleLanguagePriority = splitList(kv.lp);
}

function applySubtitleStyle(out: JobSettings, kv: Record<string, string>): void {
	if (kv.cv !== undefined) out.convertSrtToAss = kv.cv === "1";
	if (kv.ra !== undefined) out.restyleAssFont = kv.ra === "1";
	if (kv.ru !== undefined) out.removeUnusedFonts = kv.ru === "1";
	if (kv.tg !== undefined) out.assRestyleTargets = splitList(kv.tg);
}

function applyAudioManip(out: JobSettings, kv: Record<string, string>): void {
	if (kv.rd !== undefined) out.removeDescriptiveAudio = kv.rd === "1";
	if (kv.rk !== undefined) out.removeKaraokeAudio = kv.rk === "1";
	if (kv.dc !== undefined) out.dropCompatibilityAudio = kv.dc === "1";
	if (kv.co && CODE_TO_AUDIOCODEC[kv.co]) out.audioCodecPriority = CODE_TO_AUDIOCODEC[kv.co]!;
	if (kv.pu !== undefined) out.preferUncensoredAudio = kv.pu === "1";
	if (kv.de !== undefined) out.dedupeAudio = kv.de === "1";
	if (kv.rn !== undefined) out.renameAudioTracks = kv.rn === "1";
	if (kv.dco !== undefined) out.detectCommentaryAudio = kv.dco === "1";
	if (kv.dde !== undefined) out.detectDescriptiveAudio = kv.dde === "1";
	if (kv.dka !== undefined) out.detectKaraokeAudio = kv.dka === "1";
	if (kv.lp !== undefined) out.audioLanguagePriority = splitList(kv.lp);
}

function applyDenoise(out: JobSettings, kv: Record<string, string>): void {
	const mode = kv.m && CODE_TO_DENOISE[kv.m] ? CODE_TO_DENOISE[kv.m]! : "off";
	out.denoise = mode;
	if (mode === "off") return;

	if (mode === "auto") {
		out.autoDenoiseThresholds = {
			light: numOr(kv.tl, out.autoDenoiseThresholds.light),
			medium: numOr(kv.tm, out.autoDenoiseThresholds.medium),
			heavy: numOr(kv.th, out.autoDenoiseThresholds.heavy),
		};
		out.nlmeansParams = {
			light: readNlmeans(kv, "l", out.nlmeansParams.light),
			medium: readNlmeans(kv, "m", out.nlmeansParams.medium),
			heavy: readNlmeans(kv, "h", out.nlmeansParams.heavy),
		};
	} else {
		// Fixed level: only that level's triplet was stored.
		const triplet: NlmeansParams = {
			s: numOr(kv.s, out.nlmeansParams[mode].s),
			p: numOr(kv.p, out.nlmeansParams[mode].p),
			r: numOr(kv.r, out.nlmeansParams[mode].r),
		};
		out.nlmeansParams = { ...out.nlmeansParams, [mode]: triplet };
	}
}

function readNlmeans(kv: Record<string, string>, prefix: string, fallback: NlmeansParams): NlmeansParams {
	return {
		s: numOr(kv[`${prefix}s`], fallback.s),
		p: numOr(kv[`${prefix}p`], fallback.p),
		r: numOr(kv[`${prefix}r`], fallback.r),
	};
}

function applyDeband(out: JobSettings, kv: Record<string, string>): void {
	const level = kv.m && CODE_TO_DEBAND[kv.m] ? CODE_TO_DEBAND[kv.m]! : "off";
	out.deband = level;
	if (level === "off") return;
	const g: GradfunParams = {
		strength: numOr(kv.st, out.gradfunParams[level].strength),
		radius: numOr(kv.rd, out.gradfunParams[level].radius),
	};
	out.gradfunParams = { ...out.gradfunParams, [level]: g };
}

function applyBitrates(out: JobSettings, kv: Record<string, string>): void {
	const next: AudioChannelBitrates = { ...out.audioBitrates };
	for (const { key, code } of BITRATE_CHANNELS) {
		if (kv[code] !== undefined) next[key] = numOr(kv[code], next[key]);
	}
	out.audioBitrates = next;
}

function parseVsSection(kv: Record<string, string>): VsFilterEntry | null {
	const presetId = kv.id ? unesc(kv.id) : "";
	const level = kv.lv ? unesc(kv.lv) : "";
	if (!presetId || !level) return null;
	const params: Record<string, VsParamValue> = {};
	for (const key of Object.keys(kv)) {
		if (key === "id" || key === "lv") continue;
		params[key] = coerceScalar(unesc(kv[key]!));
	}
	return { presetId, level, params: { [level]: params } };
}

function numOr(v: string | undefined, fallback: number): number {
	if (v === undefined) return fallback;
	const n = Number(v);
	return Number.isFinite(n) ? n : fallback;
}

function canonicalVsParamsForKey(e: VsFilterEntry): Record<string, VsParamValue> {
	const active = e.params?.[e.level] ?? {};
	const manifest = vsRegistry.get(e.presetId);

	if (!manifest) return active;

	const out: Record<string, VsParamValue> = {};

	for (const spec of manifest.params) {
		const value = active[spec.key] ?? spec.defaults[e.level];
		if (value !== undefined) out[spec.key] = value;
	}

	for (const key of Object.keys(active)) {
		if (!(key in out)) out[key] = active[key]!;
	}

	return out;
}

export function combineCumulativeSettings(prior: Partial<JobSettings> | null | undefined, current: JobSettings): JobSettings {
	if (!prior) return current;

	const combined: JobSettings = { ...current };

	// VS chain: prior first, then current; drop exact duplicates.
	const active = (e: VsFilterEntry | undefined | null): e is VsFilterEntry => !!e && e.level !== "off";
	const priorVs = (prior.vsFilters ?? []).filter(active);
	const currentVs = (current.vsFilters ?? []).filter(active);
	const seen = new Set<string>();
	const chain: VsFilterEntry[] = [];
	for (const e of [...priorVs, ...currentVs]) {
		const key = `${e.presetId}|${e.level}|${JSON.stringify(canonicalVsParamsForKey(e))}`;
		if (seen.has(key)) continue;
		seen.add(key);
		chain.push(e);
	}
	combined.vsFilters = chain;

	if ((current.denoise ?? "off") === "off" && prior.denoise && prior.denoise !== "off") {
		combined.denoise = prior.denoise;
	}
	if ((current.deband ?? "off") === "off" && prior.deband && prior.deband !== "off") {
		combined.deband = prior.deband;
	}

	combined.downscale = !!current.downscale || !!prior.downscale;

	return combined;
}
