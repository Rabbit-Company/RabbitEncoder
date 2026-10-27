import { mkdirSync } from "fs";
import { Logger } from "../core/logger";
import { CancelledError } from "../core/process";
import type { JobSettings, ProbeResult } from "../core/types";
import { accountFrom, searchSubtitles } from "./search";

export interface DownloadedSubtitle {
	/** Language tag as requested, used for the MKV track. */
	language: string;
	/** Synced file, ready to mux. */
	file: string;
	format: "srt" | "ass";
	hearingImpaired: boolean;
	rating: number;
	release: string;
	uploader: string;
	fileName: string;
	/** One of the most used languages added on top of the target languages. */
	extra?: boolean;
}

/** Downloading before translating is on and OpenSubtitles is set up. */
export function subtitleDownloadEnabled(settings: JobSettings): boolean {
	return settings.subtitleDownloadBeforeTranslate !== false && !!accountFrom(settings);
}

export interface DownloadMissingParams {
	/** File to analyse, possibly a staged copy. */
	inputPath: string;
	/** The video's place in the library, for its name and .nfo files. */
	identityPath: string;
	probe: ProbeResult;
	languages: string[];
	settings: JobSettings;
	/** App temp folder, where downloads are cached across jobs. */
	cacheDir: string;
	workDir: string;
	signal?: AbortSignal;
	onStatus?: (message: string) => void;
	/** Most used languages to add on top, one try each while enough quota is left. */
	extraLanguages?: string[];
}

/**
 * Finds a synced subtitle for every language it can. Any failure, such as an
 * unknown title or a used up quota, leaves the languages to the AI provider
 * rather than failing the job.
 */
export async function downloadMissingSubtitles(p: DownloadMissingParams): Promise<DownloadedSubtitle[]> {
	if (!p.languages.length && !p.extraLanguages?.length) return [];
	mkdirSync(p.workDir, { recursive: true });
	try {
		const result = await searchSubtitles({
			inputPath: p.inputPath,
			identityPath: p.identityPath,
			probe: p.probe,
			languages: p.languages,
			settings: p.settings,
			cacheDir: p.cacheDir,
			workDir: p.workDir,
			signal: p.signal,
			onProgress: p.onStatus,
			extraLanguages: p.extraLanguages,
		});
		for (const note of result.notes) Logger.warn(`[subsearch] ${note}`);
		const found: DownloadedSubtitle[] = [];
		for (const lang of result.languages) {
			const best = lang.candidates.find((c) => c.key === lang.bestKey);
			if (!best?.syncedPath || !best.format) {
				Logger.info(`[subsearch] No ${lang.name} subtitle to use: ${lang.note ?? "none rated high enough"}`);
				continue;
			}
			Logger.info(`[subsearch] Using ${lang.name} subtitle ${best.release || best.fileName} (rating ${best.rating})`);
			found.push({
				language: lang.language,
				file: best.syncedPath,
				format: best.format,
				hearingImpaired: best.hearingImpaired,
				rating: best.rating!,
				release: best.release,
				uploader: best.uploader,
				fileName: best.fileName,
				...(lang.extra ? { extra: true } : {}),
			});
		}
		return found;
	} catch (error) {
		if (error instanceof CancelledError || p.signal?.aborted) throw new CancelledError();
		Logger.warn(`[subsearch] Subtitle download skipped: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
}
