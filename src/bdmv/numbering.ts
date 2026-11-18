import type { TvdbSeries } from "./metadata";
import type { DiscOutputKind } from "./naming";

const pad = (n: number) => String(n).padStart(2, "0");
export const episodeTag = (season: number, episode: number) => `S${pad(season)}E${pad(episode)}`;

export interface NumberedRow {
	kind: DiscOutputKind;
	disc: number;
	start: number;
	end: number;
	season?: number;
	episode?: number;
	title: string;
	edition?: string;
	warning?: string;
}

const minutes = (s: number) => {
	const whole = Math.round(s);
	return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};

/**
 * Numbers the episodes in disc order from `firstEpisode`, and specials from
 * S00E01, with their TVDB titles. Each length is checked against TVDB's.
 * Extras keep the names they have and movies are not numbered. Returns
 * warnings about the whole set.
 */
export function numberRows(rows: NumberedRow[], season: number, firstEpisode: number, series?: TvdbSeries): string[] {
	let next = firstEpisode;
	let special = 1;
	let extra = 0;
	for (const row of rows) {
		row.warning = undefined;
		if (row.kind === "extra") {
			extra++;
			row.season = undefined;
			row.episode = undefined;
			row.title ||= `Disc ${row.disc + 1} Extra ${extra}`;
			continue;
		}
		if (row.kind === "movie") {
			row.season = undefined;
			row.episode = undefined;
			continue;
		}
		row.season = row.kind === "special" ? 0 : season;
		row.episode = row.kind === "special" ? special++ : next++;
		const tvdb = series?.episodes?.find((e) => e.season === row.season && e.episode === row.episode);
		row.title = tvdb?.title ?? "";
		if (series?.episodes && !tvdb) {
			row.warning = `${episodeTag(row.season, row.episode)} is not on TVDB`;
			continue;
		}
		const runtime = (tvdb?.runtime ?? (row.kind === "special" ? 0 : series?.runtime) ?? 0) * 60;
		const length = row.end - row.start;
		if (runtime && Math.abs(length - runtime) > runtime * 0.25) row.warning = `${minutes(length)} long, TVDB says about ${runtime / 60} min`;
	}
	const warnings: string[] = [];
	const inSeason = series?.episodes?.filter((e) => e.season === season).length ?? 0;
	const found = rows.filter((r) => r.kind === "episode").length;
	if (inSeason && found && firstEpisode === 1 && found !== inSeason)
		warnings.push(`Found ${found} episodes, TVDB lists ${inSeason} in season ${season}. Check the episode count of each disc.`);
	return warnings;
}
