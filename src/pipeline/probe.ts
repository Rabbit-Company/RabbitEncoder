import { readMkvTags } from "../core/mkv-tags";
import { tmpdir } from "os";
import type { AudioStreamInfo, SubtitleStreamInfo, AudioChannelBitrates, ProbeResult } from "../core/types";

async function exec(cmd: string[]): Promise<string> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
	const out = await new Response(proc.stdout).text();
	await proc.exited;
	return out.trim();
}

async function mediainfoJson(file: string): Promise<any> {
	try {
		return JSON.parse(await exec(["mediainfo", "--Output=JSON", file]));
	} catch {
		return {};
	}
}

export async function probeFile(inputPath: string): Promise<ProbeResult> {
	const filename = inputPath.split("/").pop() || "";

	let probeJson: any = {};
	try {
		probeJson = JSON.parse(await exec(["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", inputPath]));
	} catch {
		probeJson = {};
	}
	const allStreams: any[] = probeJson.streams ?? [];

	const videoStreams = allStreams
		.filter((s) => s.codec_type === "video" && s.width && !s.disposition?.attached_pic)
		.sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
	const best: any = videoStreams[0] ?? {
		index: 0,
		width: 1920,
		height: 1080,
		codec_name: "",
		disposition: {},
		tags: {},
	};

	const duration = parseFloat(probeJson.format?.duration) || 0;

	const parseFps = (s: string | undefined): number => {
		if (!s) return 23.976;
		const parts = s.split("/");
		if (parts.length === 2) {
			const n = parseInt(parts[0]!);
			const d = parseInt(parts[1]!);
			return d > 0 && n > 0 ? n / d : 23.976;
		}
		return parseFloat(s) || 23.976;
	};

	const videoStreamFps = parseFps(best.r_frame_rate);
	const videoDisplayFps = parseFps(best.avg_frame_rate);
	const videoFrameRate = best.r_frame_rate && best.r_frame_rate !== "0/0" ? best.r_frame_rate : "24000/1001";
	const isFrameRateMismatch = Math.abs(videoStreamFps - videoDisplayFps) > 0.5;

	const displayAspectRatio = best.display_aspect_ratio || "";
	const sampleAspectRatio = best.sample_aspect_ratio || "";
	const videoLanguage = best.tags?.language || "und";
	const videoOriginalFlag = best.disposition?.original === 1;

	// Mediainfo
	const mi = await mediainfoJson(inputPath);
	const miTracks: any[] = mi.media?.track ?? [];
	const miVideo: any = miTracks.find((t) => t["@type"] === "Video") ?? {};

	// Audio
	const delayMsByIndex = new Map<number, number>();
	const bitrateByIndex = new Map<number, number>();
	for (const t of miTracks) {
		if (t["@type"] === "Audio") {
			const order = Number(t.StreamOrder);

			const sec = parseFloat(t.Delay ?? "");
			delayMsByIndex.set(order, Number.isFinite(sec) ? Math.round(sec * 1000) : 0);

			const br = parseInt(t.BitRate ?? "", 10);
			if (Number.isFinite(br) && br > 0) bitrateByIndex.set(order, br);
		}
	}

	const audioStreams: AudioStreamInfo[] = allStreams
		.filter((s) => s.codec_type === "audio")
		.map((s) => ({
			index: s.index,
			channels: s.channels || 0,
			channelLayout: s.channel_layout || "",
			language: s.tags?.language || undefined,
			title: s.tags?.title || undefined,
			codec: s.codec_name || undefined,
			bitrate: s.bit_rate ? parseInt(s.bit_rate) : bitrateByIndex.get(s.index),
			delayMs: delayMsByIndex.get(s.index) ?? 0,
			isOriginal: s.disposition?.original === 1,
		}));

	// Subtitles
	const subtitleStreams: SubtitleStreamInfo[] = allStreams
		.filter((s) => s.codec_type === "subtitle")
		.map((s) => ({
			index: s.index,
			codec: s.codec_name || "unknown",
			language: s.tags?.language || undefined,
			title: s.tags?.title || undefined,
			isForced: s.disposition?.forced === 1,
			isDefault: s.disposition?.default === 1,
			isHearingImpaired: s.disposition?.hearing_impaired === 1,
			isOriginal: s.disposition?.original === 1,
		}));

	const firstAudio = audioStreams[0];
	const audioLayout = firstAudio ? normalizeLayout(firstAudio.channelLayout, firstAudio.channels) : "stereo";
	const audioChannels = firstAudio ? firstAudio.channels : 2;

	// Color / HDR
	const hdrFormat = miVideo.HDR_Format || "";
	const transferCharacteristics = miVideo.transfer_characteristics || "";
	const colorPrimaries = miVideo.colour_primaries || "";
	const matrixCoefficients = miVideo.matrix_coefficients || "";
	const colorRange = miVideo.colour_range || "";
	const masteringDisplay = miVideo.MasteringDisplay_ColorPrimaries || "";
	const masteringLuminance = miVideo.MasteringDisplay_Luminance || "";

	const hasHDR10Plus = /HDR10\+/i.test(hdrFormat);
	const hasDolbyVision = /Dolby Vision/i.test(hdrFormat);
	const maxCLL = (miVideo.MaxCLL || "").split(" ")[0] || "";
	const maxFALL = (miVideo.MaxFALL || "").split(" ")[0] || "";

	// Prior Rabbit Encoder tags
	const priorTags = await readMkvTags(inputPath, tmpdir());

	return {
		filename,
		width: best.width,
		height: best.height,
		videoCodec: best.codec_name || "",
		displayAspectRatio,
		sampleAspectRatio,
		duration,
		audioLayout,
		audioChannels,
		audioStreams,
		subtitleStreams,
		isHDR: transferCharacteristics === "PQ",
		hasHDR10Plus,
		hasDolbyVision,
		transferCharacteristics: transferCharacteristics || "",
		colorPrimaries: colorPrimaries || "",
		matrixCoefficients: matrixCoefficients || "",
		colorRange: colorRange || "",
		maxCLL,
		maxFALL,
		masteringDisplay: masteringDisplay || "",
		masteringLuminance: masteringLuminance || "",
		videoStreamIndex: best.index,
		videoFrameRate,
		videoStreamFps,
		videoDisplayFps,
		videoLanguage,
		videoOriginalFlag,
		isFrameRateMismatch,
		priorSource: priorTags.source,
		priorRabbitSettings: priorTags.rabbitSettings,
		priorRabbitVersion: priorTags.rabbitVersion,
		priorEncodedBy: priorTags.encodedBy,
	};
}

export function normalizeLayout(layout: string, channels?: number): string {
	const map: Record<string, string> = {
		mono: "mono",
		stereo: "stereo",
		"2.1": "2.1",
		"3.0": "3.0",
		"3.0(back)": "3.0",
		"3.1": "3.1",
		"4.0": "4.0",
		quad: "4.0",
		"quad(side)": "4.0",
		"4.1": "4.1",
		"5.0": "5.0",
		"5.0(side)": "5.0",
		"5.1": "5.1",
		"5.1(side)": "5.1",
		"6.0": "6.0",
		"6.0(front)": "6.0",
		hexagonal: "6.0",
		"6.1": "6.1",
		"6.1(back)": "6.1",
		"6.1(front)": "6.1",
		"7.0": "7.0",
		"7.0(front)": "7.0",
		"7.1": "7.1",
		"7.1(wide)": "7.1",
		"7.1(wide-side)": "7.1",
		octagonal: "7.1",
		"7.1.4": "7.1.4",
		dolbyatmos: "7.1.4",
	};
	const normalized = map[layout.trim().toLowerCase()];
	if (normalized) return normalized;

	const fallbackByChannels: Record<number, string> = {
		1: "mono",
		2: "stereo",
		3: "3.0",
		4: "4.0",
		5: "5.0",
		6: "5.1",
		7: "6.1",
		8: "7.1",
		12: "7.1.4",
	};
	return (channels ? fallbackByChannels[channels] : undefined) || "stereo";
}

export function getOpusBitrateForLayout(layout: string, bitrates: AudioChannelBitrates): number {
	const key = layout as keyof typeof bitrates;
	return bitrates[key] ?? bitrates.stereo ?? 128;
}

export function getAudioReplacementLabel(layout: string): string {
	const labels: Record<string, string> = {
		mono: "Opus 1.0",
		stereo: "Opus 2.0",
		"2.1": "Opus 2.1",
		"3.0": "Opus 3.0",
		"3.1": "Opus 3.1",
		"4.0": "Opus 4.0",
		"4.1": "Opus 4.1",
		"5.0": "Opus 5.0",
		"5.1": "Opus 5.1",
		"6.0": "Opus 6.0",
		"6.1": "Opus 6.1",
		"7.0": "Opus 7.0",
		"7.1": "Opus 7.1",
		"7.1.4": "Opus 7.1.4",
	};
	return labels[layout] || "Opus 2.0";
}
