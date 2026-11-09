import { Logger } from "../core/logger";
import { CancelledError } from "../core/process";
import type { JobSettings } from "../core/types";
import type { MediaIdentity } from "./identify";
import { PROVIDER_NAMES, type DownloadedFile, type SubtitleListing } from "./listing";
import {
	downloadOpenSubtitles,
	isCachedOpenSubtitles,
	isOpenSubtitlesQuotaError,
	openSubtitlesApiKey,
	openSubtitlesLanguage,
	searchOpenSubtitles,
	type OpenSubtitlesAccount,
} from "./opensubtitles";
import { downloadSubdl, isCachedSubdl, isSubdlQuotaError, searchSubdl, subdlLanguage, type SubdlAccount } from "./subdl";

/** The subtitle sites that are set up. At least one is. */
export interface SubtitleAccounts {
	openSubtitles?: OpenSubtitlesAccount;
	subdl?: SubdlAccount;
}

export const LOGIN_NEEDED = "Log in with your OpenSubtitles.com account or enter a SubDL API key under Settings, Subtitle handling, Subtitle download first";

export function accountsFrom(settings: JobSettings): SubtitleAccounts | null {
	const out: SubtitleAccounts = {};
	const username = settings.openSubtitlesUsername?.trim();
	const password = settings.openSubtitlesPassword;
	if (username && password) out.openSubtitles = { apiKey: openSubtitlesApiKey(), username, password };
	const subdlKey = settings.subdlApiKey?.trim();
	if (subdlKey) out.subdl = { apiKey: subdlKey };
	return out.openSubtitles || out.subdl ? out : null;
}

/** Codes of a language tag on each provider that is set up and knows it. */
export interface ProviderLanguage {
	opensubtitles: string | null;
	subdl: string | null;
}

export function providerLanguage(tag: string, accounts: SubtitleAccounts): ProviderLanguage {
	return {
		opensubtitles: accounts.openSubtitles ? openSubtitlesLanguage(tag) : null,
		subdl: accounts.subdl ? subdlLanguage(tag) : null,
	};
}

export function listingMatches(l: SubtitleListing, language: ProviderLanguage): boolean {
	return l.language === language[l.provider];
}

/**
 * Searches every provider that is set up. One that fails is only noted while
 * another answered, and the search fails only when all of them did.
 */
export async function searchProviders(
	accounts: SubtitleAccounts,
	identity: MediaIdentity,
	languages: ProviderLanguage[],
	hash: string | null,
	signal?: AbortSignal,
	failures?: string[],
): Promise<SubtitleListing[]> {
	const codes = (provider: keyof ProviderLanguage) => [...new Set(languages.map((l) => l[provider]).filter((c): c is string => !!c))];
	const jobs: Array<{ name: string; run: () => Promise<SubtitleListing[]> }> = [];
	const os = accounts.openSubtitles;
	const sd = accounts.subdl;
	if (os && codes("opensubtitles").length)
		jobs.push({ name: PROVIDER_NAMES.opensubtitles, run: () => searchOpenSubtitles(os, identity, codes("opensubtitles"), hash, signal) });
	if (sd && codes("subdl").length) jobs.push({ name: PROVIDER_NAMES.subdl, run: () => searchSubdl(sd, identity, codes("subdl"), signal) });
	const settled = await Promise.allSettled(jobs.map((j) => j.run()));
	if (signal?.aborted) throw new CancelledError();
	const out: SubtitleListing[] = [];
	const errors: unknown[] = [];
	settled.forEach((s, i) => {
		if (s.status === "fulfilled") out.push(...s.value);
		else {
			errors.push(s.reason);
			const message = `${jobs[i]!.name} search failed: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`;
			Logger.warn(`[subsearch] ${message}`);
			failures?.push(message);
		}
	});
	if (errors.length && errors.length === jobs.length) throw errors[0];
	return out;
}

export function isQuotaError(error: unknown): error is Error {
	return isOpenSubtitlesQuotaError(error) || isSubdlQuotaError(error);
}

export function isCachedListing(l: SubtitleListing, tempDir: string): boolean {
	return l.provider === "subdl" ? isCachedSubdl(l, tempDir) : isCachedOpenSubtitles(l, tempDir);
}

export async function downloadListing(accounts: SubtitleAccounts, l: SubtitleListing, tempDir: string, signal?: AbortSignal): Promise<DownloadedFile> {
	if (l.provider === "subdl") {
		if (!accounts.subdl) throw new Error("SubDL is not set up");
		return downloadSubdl(accounts.subdl, l, tempDir, signal);
	}
	if (!accounts.openSubtitles) throw new Error("OpenSubtitles is not set up");
	return downloadOpenSubtitles(accounts.openSubtitles, l, tempDir, signal);
}
