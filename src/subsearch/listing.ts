export type SubtitleProvider = "opensubtitles" | "subdl";

export const PROVIDER_NAMES: Record<SubtitleProvider, string> = {
	opensubtitles: "OpenSubtitles",
	subdl: "SubDL",
};

/** One subtitle file as a provider lists it. */
export interface SubtitleListing {
	provider: SubtitleProvider;
	/** Stable key for caching and choosing, unique across providers. */
	key: string;
	/** OpenSubtitles file ID, 0 for SubDL. */
	fileId: number;
	/** SubDL download path, such as "/subtitle/3197651-3213944.zip". */
	downloadPath?: string;
	/** The season and episode it was searched for, to pick the file from an archive of several. */
	season?: number;
	episode?: number;
	fileName: string;
	/** The provider's language code, such as "sl" or "pt-br" on OpenSubtitles and "SL" or "BR_PT" on SubDL. */
	language: string;
	release: string;
	downloads: number;
	hearingImpaired: boolean;
	machineTranslated: boolean;
	foreignPartsOnly: boolean;
	trustedUploader: boolean;
	hashMatch: boolean;
	fps: number;
	uploader: string;
	url: string;
	featureTitle: string;
}

export interface DownloadedFile {
	fileName: string;
	bytes: Uint8Array;
	/** True when it came from the cache and used no quota. */
	cached: boolean;
	/** Downloads left today, when the provider said. */
	remaining?: number;
}
