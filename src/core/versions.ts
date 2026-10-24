import pkg from "../../package.json";
import { run } from "./process";

export interface ToolVersion {
	name: string;
	/** null when the tool is missing or did not report a version. */
	version: string | null;
	purpose: string;
	url: string;
}

export interface VersionsReport {
	rabbitEncoder: string;
	/** The x86-64 level whose builds the container picked for this CPU, such as "x86-64-v3". */
	cpuLevel: string | null;
	tools: ToolVersion[];
}

interface ToolSpec {
	name: string;
	command: string[];
	purpose: string;
	url: string;
	parse: (output: string) => string | null;
}

/** The second word, as Rust command line tools print "regrain 0.2.2 (x86_64-unknown-linux-musl)". */
const secondWord = (output: string): string | null => output.trim().split(/\s+/)[1] ?? null;
const firstMatch =
	(pattern: RegExp) =>
	(output: string): string | null =>
		output.match(pattern)?.[1] ?? null;

export const TOOLS: ToolSpec[] = [
	{
		name: "FFmpeg",
		command: ["ffmpeg", "-hide_banner", "-version"],
		purpose: "Decoding, filters and muxing",
		url: "https://ffmpeg.org",
		parse: firstMatch(/^ffmpeg version (\S+)/m),
	},
	{
		name: "FFprobe",
		command: ["ffprobe", "-hide_banner", "-version"],
		purpose: "Reading stream information",
		url: "https://ffmpeg.org",
		parse: firstMatch(/^ffprobe version (\S+)/m),
	},
	{
		name: "SVT-AV1-Essential",
		command: ["SVT-AV1-Essential", "--version"],
		purpose: "AV1 encoder",
		url: "https://github.com/nekotrix/SVT-AV1-Essential",
		parse: firstMatch(/v(\d+\.\d+\.\d+[^\s]*)/),
	},
	{
		name: "SVT-AV1-HDR",
		command: ["SVT-AV1-HDR", "--version"],
		purpose: "AV1 encoder",
		url: "https://github.com/juliobbv-p/svt-av1-hdr",
		parse: firstMatch(/v(\d+\.\d+\.\d+[^\s]*)/),
	},
	{
		name: "SVT-AV1-5FISH",
		command: ["SVT-AV1-5FISH", "--version"],
		purpose: "AV1 encoder",
		url: "https://github.com/5fish/SVT-AV1",
		parse: firstMatch(/v(\d+\.\d+\.\d+[^\s]*)/),
	},
	{
		name: "SVT-AV1-Tritium",
		command: ["SVT-AV1-Tritium", "--version"],
		purpose: "AV1 encoder",
		url: "https://github.com/Uranite/svt-av1-tritium",
		parse: firstMatch(/v(\d+\.\d+\.\d+[^\s]*)/),
	},
	{
		name: "av-denoise",
		command: ["av-denoise", "--version"],
		purpose: "GPU denoisers",
		url: "https://github.com/ChillFish8/av-denoise",
		parse: secondWord,
	},
	{
		name: "VapourSynth",
		command: ["vspipe", "--version"],
		purpose: "Filter chains",
		url: "https://www.vapoursynth.com",
		parse: (output) => {
			const core = output.match(/Core R(\d+)/)?.[1];
			return core ? `R${core}` : null;
		},
	},
	{
		name: "regrain",
		command: ["regrain", "--version"],
		purpose: "Film grain tables",
		url: "https://github.com/Rabbit-Company/regrain",
		parse: secondWord,
	},
	{
		name: "retone",
		command: ["retone", "--version"],
		purpose: "HDR10+ and HDR10 metadata",
		url: "https://github.com/Rabbit-Company/retone",
		parse: secondWord,
	},
	{
		name: "Language Detector",
		command: ["language-detector", "--version"],
		purpose: "Subtitle language detection",
		url: "https://github.com/Rabbit-Company/language-detector",
		parse: (output) => output.replace("Language Detector", "").trim().replace(/^v/, "") || null,
	},
	{
		name: "MKVToolNix",
		command: ["mkvmerge", "--version"],
		purpose: "MKV muxing and editing",
		url: "https://mkvtoolnix.download",
		parse: firstMatch(/mkvmerge v(\S+)/),
	},
	{
		name: "MediaInfo",
		command: ["mediainfo", "--Version"],
		purpose: "Reading HDR and colour information",
		url: "https://mediaarea.net/en/MediaInfo",
		parse: firstMatch(/v(\d+(?:\.\d+)+)/),
	},
];

async function toolVersion(spec: ToolSpec): Promise<ToolVersion> {
	const timeout = AbortSignal.timeout(10_000);
	const result = await run(spec.command, { signal: timeout }).catch(() => null);
	// Some tools print their version on standard error.
	const output = result ? `${result.stdout}\n${result.stderr}` : "";
	return { name: spec.name, version: result?.code === 0 ? spec.parse(output) : null, purpose: spec.purpose, url: spec.url };
}

let cached: Promise<VersionsReport> | null = null;

/** The versions of Rabbit Encoder and every tool it runs. Read once, as they only change with a new container. */
export function getVersions(): Promise<VersionsReport> {
	cached ??= Promise.all(TOOLS.map(toolVersion)).then((tools) => ({
		rabbitEncoder: pkg.version,
		cpuLevel: process.env.RABBIT_CPU_LEVEL || null,
		tools,
	}));
	return cached;
}
