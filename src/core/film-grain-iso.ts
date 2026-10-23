/** Synthetic grain given as an ISO, shared by the server and the browser. */

/** The ISO range regrain generate accepts. 0 turns ISO grain off. */
export const MIN_GRAIN_ISO = 50;
export const MAX_GRAIN_ISO = 409600;

interface SyntheticGrainSettings {
	filmGrainSyntheticMode?: "strength" | "iso";
	filmGrainSyntheticStrength?: number;
	filmGrainSyntheticIso?: number;
}

/** An ISO regrain accepts, or 0 for none. Values below the lowest ISO turn the grain off. */
export function grainIso(value: number): number {
	return Number.isFinite(value) && value >= MIN_GRAIN_ISO ? Math.min(MAX_GRAIN_ISO, Math.round(value)) : 0;
}

/** Settings saved before ISO grain have no mode, and their strength still applies. */
export function syntheticGrainMode(settings: SyntheticGrainSettings): "strength" | "iso" {
	return settings.filmGrainSyntheticMode ?? ((settings.filmGrainSyntheticStrength ?? 0) > 0 ? "strength" : "iso");
}

/** Whether the settings add synthetic grain, in the mode they are in. */
export function syntheticGrainActive(settings: SyntheticGrainSettings): boolean {
	return syntheticGrainMode(settings) === "iso" ? grainIso(settings.filmGrainSyntheticIso ?? 0) > 0 : (settings.filmGrainSyntheticStrength ?? 0) > 0;
}

/**
 * The picture size ISO grain is for. regrain spreads a 36 by 24 mm sensor over the picture's pixels, so black bars
 * cut from a frame would count as larger pixels with less noise. The whole 16:9 frame around the picture is used instead.
 */
export function isoResolution(width: number, height: number): { width: number; height: number } {
	const frameWidth = Math.max(width, Math.round((height * 16) / 9));
	return { width: frameWidth, height: Math.round((frameWidth * 9) / 16) };
}
