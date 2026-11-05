/**
 * How stills are made. "standard" follows the thewiki.moe comparison guide,
 * the convention comparisons on slow.pics are judged by. "mpv" matches an
 * mpv screenshot taken with mpv's default settings.
 */
export type StillStyle = "standard" | "mpv";

export const STILL_STYLES: readonly StillStyle[] = ["standard", "mpv"];
export const DEFAULT_STILL_STYLE: StillStyle = "standard";

export const STILL_STYLE_LABELS: Record<StillStyle, string> = {
	standard: "Comparison standard (thewiki.moe guide)",
	mpv: "Match mpv screenshots",
};

export function isStillStyle(v: unknown): v is StillStyle {
	return typeof v === "string" && (STILL_STYLES as readonly string[]).includes(v);
}
