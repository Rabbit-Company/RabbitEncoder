import { run } from "../core/process";
import type { ProbeResult } from "../core/types";

export function svtColorParamsFromProbe(probe: ProbeResult): string {
	const primMap: Record<string, number> = { "BT.709": 1, "BT.2020": 9, "BT.601 NTSC": 6, "BT.601 PAL": 5 };
	const trcMap: Record<string, number> = { "BT.709": 1, PQ: 16, HLG: 18, "BT.601": 6 };
	const mtxMap: Record<string, number> = { "BT.709": 1, "BT.2020 non-constant": 9, "BT.601": 6 };

	// Reasonable HD/SD fallbacks if mediainfo returned nothing
	const isHD = probe.height >= 720;
	const cp = primMap[probe.colorPrimaries] ?? (isHD ? 1 : 6);
	const tc = trcMap[probe.transferCharacteristics] ?? (isHD ? 1 : 6);
	const mc = mtxMap[probe.matrixCoefficients] ?? (isHD ? 1 : 6);
	const cr = probe.colorRange === "Full" ? 1 : 0;

	return `--color-primaries ${cp} --transfer-characteristics ${tc} --matrix-coefficients ${mc} --color-range ${cr}`;
}

/**
 * Sets the colour elements of the video track. `measured` holds the MaxCLL and MaxFALL that HDR10+
 * measuring found, used when the source states none.
 */
export async function applyColorMetadata(mkvPath: string, probe: ProbeResult, signal?: AbortSignal, measured?: { maxCll?: number; maxFall?: number }) {
	const cmd: string[] = ["mkvpropedit", mkvPath, "--edit", "track:v1"];

	const isHD = probe.height >= 720;

	let primaries: number;
	switch (probe.colorPrimaries) {
		case "BT.2020":
			primaries = 9;
			break;
		case "BT.709":
			primaries = 1;
			break;
		case "BT.601 NTSC":
			primaries = 6;
			break;
		case "BT.601 PAL":
			primaries = 5;
			break;
		case "Display P3":
			primaries = 12;
			break;
		default:
			primaries = isHD ? 1 : 6;
	}

	let transfer: number;
	switch (probe.transferCharacteristics) {
		case "PQ":
			transfer = 16;
			break;
		case "HLG":
			transfer = 18;
			break;
		case "BT.709":
			transfer = 1;
			break;
		case "BT.601":
			transfer = 6;
			break;
		case "sRGB/sYCC":
			transfer = 13;
			break;
		default:
			transfer = isHD ? 1 : 6;
	}

	let matrix: number;
	switch (probe.matrixCoefficients) {
		case "BT.2020 non-constant":
			matrix = 9;
			break;
		case "BT.2020 constant":
			matrix = 10;
			break;
		case "BT.709":
			matrix = 1;
			break;
		case "BT.601":
			matrix = 6;
			break;
		case "Identity":
			matrix = 0;
			break;
		default:
			matrix = isHD ? 1 : 6;
	}

	const range = probe.colorRange === "Full" ? 2 : 1;

	cmd.push("--set", `color-primaries=${primaries}`);
	cmd.push("--set", `color-transfer-characteristics=${transfer}`);
	cmd.push("--set", `color-matrix-coefficients=${matrix}`);
	cmd.push("--set", `color-range=${range}`);

	// HDR-only metadata
	if (probe.isHDR) {
		if (/^\d+$/.test(probe.maxCLL) && /^\d+$/.test(probe.maxFALL)) {
			cmd.push("--set", `max-content-light=${probe.maxCLL}`);
			cmd.push("--set", `max-frame-light=${probe.maxFALL}`);
		} else if (measured?.maxCll && measured.maxFall) {
			cmd.push("--set", `max-content-light=${measured.maxCll}`);
			cmd.push("--set", `max-frame-light=${measured.maxFall}`);
		}

		if (probe.masteringDisplay && probe.masteringLuminance) {
			let RX: string, RY: string, GX: string, GY: string, BX: string, BY: string;
			if (probe.masteringDisplay === "Display P3") {
				[RX, RY, GX, GY, BX, BY] = ["0.6800", "0.3200", "0.2650", "0.6900", "0.1500", "0.0600"];
			} else {
				// BT.2020 (default / unrecognized mastering display)
				[RX, RY, GX, GY, BX, BY] = ["0.7080", "0.2920", "0.1700", "0.7970", "0.1310", "0.0460"];
			}
			const maxLum = probe.masteringLuminance.match(/max:\s*([0-9.]+)/)?.[1];
			const minLum = probe.masteringLuminance.match(/min:\s*([0-9.]+)/)?.[1];
			if (maxLum && minLum) {
				cmd.push(
					"--set",
					`chromaticity-coordinates-red-x=${RX}`,
					"--set",
					`chromaticity-coordinates-red-y=${RY}`,
					"--set",
					`chromaticity-coordinates-green-x=${GX}`,
					"--set",
					`chromaticity-coordinates-green-y=${GY}`,
					"--set",
					`chromaticity-coordinates-blue-x=${BX}`,
					"--set",
					`chromaticity-coordinates-blue-y=${BY}`,
					"--set",
					"white-coordinates-x=0.3127",
					"--set",
					"white-coordinates-y=0.3290",
					"--set",
					`max-luminance=${maxLum}`,
					"--set",
					`min-luminance=${minLum}`,
				);
			}
		}
	}

	await run(cmd, { signal });
}
