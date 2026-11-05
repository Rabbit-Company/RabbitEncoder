import { closeSync, existsSync, openSync, readSync, renameSync, rmSync, statSync } from "fs";
import { Logger } from "../core/logger";
import { run } from "../core/process";
import type { StillStyle } from "../core/still-style";

/** Colour tags of a video as ffprobe names them, null where the file leaves them out. */
export interface ScreenshotColor {
	range: "tv" | "pc" | null;
	space: string | null;
	transfer: string | null;
	primaries: string | null;
	chromaLocation: string | null;
	height: number;
}

export interface ScreenshotSize {
	width: number;
	height: number;
}

/** Tags for the 16-bit RGB PNG, so the encoder writes sRGB colour chunks. */
const SRGB_TAGS = "setparams=range=pc:colorspace=gbr:color_primaries=bt709:color_trc=iec61966-2-1";

const ZIMG_MATRIX: Record<string, string> = {
	bt709: "709",
	smpte170m: "170m",
	bt470bg: "470bg",
	bt2020nc: "2020_ncl",
	bt2020c: "2020_cl",
};

const CHROMA_LOCATIONS = new Set(["left", "center", "topleft", "top", "bottomleft", "bottom"]);

export function isHdrTransfer(transfer: string | null): boolean {
	return transfer === "smpte2084" || transfer === "arib-std-b67";
}

/** Tags with the gaps filled the way players fill them: by frame height, and chroma on the left as 4:2:0 codecs default to. */
function resolve(color: ScreenshotColor) {
	const space = color.space && ZIMG_MATRIX[color.space] ? color.space : color.height >= 720 ? "bt709" : "smpte170m";
	const primaries = color.primaries ?? (space.startsWith("bt2020") ? "bt2020" : space === "bt470bg" ? "bt470bg" : space === "bt709" ? "bt709" : "smpte170m");
	return {
		range: color.range === "pc" ? "pc" : "tv",
		space,
		transfer: color.transfer ?? "bt709",
		primaries,
		chromaLocation: color.chromaLocation && CHROMA_LOCATIONS.has(color.chromaLocation) ? color.chromaLocation : "left",
	};
}

/**
 * The tags are set first so libplacebo does not guess them and hand-set
 * overrides take effect.
 *
 * standard: EWA Lanczos Sharp with 0.6 anti-ringing for chroma and upscaling,
 * sigmoid upscaling, Hermite in linear light for downscaling, and SDR kept in
 * its own BT.709 transfer. HDR and Dolby Vision are tone mapped with Spline,
 * perceptual gamut mapping, peak detection and 0.3 contrast recovery. The
 * guide's 100 nit target has no option here, so libplacebo's SDR white is used.
 *
 * mpv: Lanczos for chroma and upscaling, Hermite for downscaling, SDR shown
 * as a BT.1886 display and written as sRGB, HDR tone mapped without contrast
 * recovery.
 */
function libplaceboChain(style: StillStyle, color: ScreenshotColor, size?: ScreenshotSize): string {
	const c = resolve(color);
	const scale = size ? `w=${size.width}:h=${size.height}:` : "";
	const render =
		style === "standard"
			? "color_trc=bt709:upscaler=ewa_lanczossharp:antiringing=0.6:sigmoid=1:downscaler=hermite:tonemapping=spline:gamut_mode=perceptual:peak_detect=1:contrast_recovery=0.3"
			: "color_trc=iec61966-2-1:upscaler=lanczos:downscaler=hermite:contrast_recovery=0";
	return [
		`setparams=range=${c.range}:colorspace=${c.space}:color_trc=${c.transfer}:color_primaries=${c.primaries}:chroma_location=${c.chromaLocation}`,
		`libplacebo=${scale}format=gbrp16le:colorspace=gbr:range=pc:color_primaries=bt709:dithering=-1:${render}`,
		"format=rgb48be",
		SRGB_TAGS,
	].join(",");
}

/**
 * libplacebo shows SDR video as a BT.1886 display of 1000:1 contrast, takes
 * that black level away and writes sRGB. This curve does the same on full
 * range RGB, which darkens the deepest shadows by up to 2 levels.
 */
function bt1886ToSrgbExpr(): string {
	const black = 1 / 1000;
	const lift = Math.pow(black, 1 / 2.4);
	const linear = `pow(${lift.toFixed(8)}+${(1 - lift).toFixed(8)}*val/65535\\,2.4)`;
	const shifted = `max(0\\,(${linear}-${black})/${1 - black})`;
	return `st(0\\,${shifted});65535*if(lte(ld(0)\\,0.0031308)\\,12.92*ld(0)\\,1.055*pow(ld(0)\\,1/2.4)-0.055)`;
}

/** zimg in place of libplacebo where Vulkan does not work. Close for SDR, an approximation for HDR. */
function zimgChain(style: StillStyle, color: ScreenshotColor, size?: ScreenshotSize): string {
	const c = resolve(color);
	// Chroma is always upscaled, so Lanczos unless the whole picture shrinks. zimg has no EWA kernels.
	const downscale = size && size.height < color.height;
	const scaleFilter = downscale ? "filter=bicubic:param_a=0:param_b=0" : "filter=lanczos";
	const input = `zscale=${size ? `w=${size.width}:h=${size.height}:` : ""}${scaleFilter}:matrixin=${ZIMG_MATRIX[c.space]}:rangein=${c.range === "pc" ? "full" : "limited"}:chromalin=${c.chromaLocation}`;
	if (isHdrTransfer(c.transfer)) {
		const out = style === "standard" ? "bt709" : "iec61966-2-1";
		return [
			`${input}:transferin=${c.transfer}:primariesin=${c.primaries === "bt2020" ? "2020" : "709"}:t=linear:npl=100`,
			"format=gbrpf32le",
			"zscale=p=bt709",
			"tonemap=tonemap=hable:desat=0",
			`zscale=t=${out}:m=bt709:r=pc:dither=none`,
			"format=gbrp16le",
			"format=rgb48be",
			SRGB_TAGS,
		].join(",");
	}
	const curve = style === "mpv" ? [`lutrgb=r='${bt1886ToSrgbExpr()}':g='${bt1886ToSrgbExpr()}':b='${bt1886ToSrgbExpr()}'`] : [];
	return [`${input}:matrix=${ZIMG_MATRIX[c.space]}:range=full:dither=none`, "format=gbrp16le", ...curve, "format=rgb48be", SRGB_TAGS].join(",");
}

/** A PNG's bit depth per channel, read from its IHDR chunk. */
function pngBitDepth(path: string): number {
	const fd = openSync(path, "r");
	try {
		const head = Buffer.alloc(25);
		readSync(fd, head, 0, 25, 0);
		return head[24]!;
	} finally {
		closeSync(fd);
	}
}

/**
 * An 8-bit copy of a 16-bit still for showing in a browser, dithered with
 * error diffusion. Browsers cut 16-bit PNGs to 8 bits by dropping the low
 * byte, which brings the banding back and darkens the picture by half a
 * level. The copy is made once and kept next to the still. 8-bit stills are
 * returned as they are.
 */
export async function viewablePng(path: string, signal?: AbortSignal): Promise<string> {
	if (pngBitDepth(path) <= 8) return path;
	const view = `${path}.view.png`;
	if (existsSync(view) && statSync(view).mtimeMs >= statSync(path).mtimeMs) return view;
	const tmp = `${view}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp.png`;
	const res = await run(
		[
			"ffmpeg",
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-i",
			path,
			"-vf",
			`format=gbrp16le,zscale=dither=error_diffusion,format=gbrp,format=rgb24,${SRGB_TAGS}`,
			"-frames:v",
			"1",
			tmp,
		],
		{ signal },
	);
	if (res.code !== 0 || !existsSync(tmp)) {
		Logger.warn(`[screenshot] Could not make an 8-bit copy of ${path}: ${res.stderr.trim().slice(-300)}`);
		rmSync(tmp, { force: true });
		return path;
	}
	renameSync(tmp, view);
	return view;
}

let libplaceboProbe: Promise<boolean> | null = null;

/** Whether ffmpeg's libplacebo filter runs here, checked once. It needs a Vulkan device, a GPU or Mesa's software one. */
function libplaceboWorks(): Promise<boolean> {
	libplaceboProbe ??= run([
		"ffmpeg",
		"-hide_banner",
		"-loglevel",
		"error",
		"-f",
		"lavfi",
		"-i",
		"color=c=gray:s=64x64:d=0.1,format=yuv420p",
		"-vf",
		libplaceboChain("standard", { range: "tv", space: "bt709", transfer: "bt709", primaries: "bt709", chromaLocation: "left", height: 64 }),
		"-frames:v",
		"1",
		"-f",
		"null",
		"-",
	])
		.then((res) => {
			if (res.code !== 0) Logger.warn(`[screenshot] libplacebo is unavailable, stills use zimg instead: ${res.stderr.trim().slice(-300)}`);
			return res.code === 0;
		})
		.catch(() => false);
	return libplaceboProbe;
}

/**
 * Captures a 16-bit PNG in the given style. `build` gets the conversion
 * filters to append to its own chain and returns the ffmpeg command. With
 * libplacebo unusable, or failing on this file, the capture runs again with
 * zimg.
 */
export async function captureScreenshot(
	build: (toRgb: string) => string[],
	style: StillStyle,
	color: ScreenshotColor,
	signal: AbortSignal,
	size?: ScreenshotSize,
): Promise<{ code: number; stderr: string }> {
	if (await libplaceboWorks()) {
		const res = await run(build(libplaceboChain(style, color, size)), { signal });
		if (res.code === 0 || signal.aborted) return res;
		Logger.warn(`[screenshot] libplacebo capture failed, trying zimg: ${res.stderr.trim().slice(-300)}`);
	}
	return run(build(zimgChain(style, color, size)), { signal });
}
