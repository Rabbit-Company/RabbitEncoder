/**
 * An original that is a range of a Blu-ray playlist rather than a file, as
 * the path of the playlist with the range after it in the style of a media
 * fragment: ".../BDMV/PLAYLIST/00002.mpls#t=0,1420.42". Shared by the server
 * and the dashboard.
 */

export interface DiscRange {
	/** The folder that holds BDMV. */
	discPath: string;
	/** Playlist number, "00002". */
	playlist: string;
	/** Range on the playlist's timeline in seconds. */
	start: number;
	end: number;
}

/** Where on a disc an encode came from, kept in its tags so another system can find the range again in its own copy of the disc. */
export interface DiscOrigin {
	/** The disc's folder name, which tells discs of a set apart. */
	label: string;
	playlist: string;
	start: number;
	end: number;
	/** Seconds the whole playlist plays, which tells it apart from a playlist of the same number on another disc. */
	length: number;
}

const SOURCE = /^(.+)\/BDMV\/PLAYLIST\/(\d{5})\.mpls#t=(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/;

export function discSourcePath(range: DiscRange): string {
	return `${range.discPath}/BDMV/PLAYLIST/${range.playlist}.mpls#t=${range.start},${range.end}`;
}

export function parseDiscSource(path: string): DiscRange | null {
	const match = SOURCE.exec(path);
	if (!match) return null;
	const start = Number(match[3]);
	const end = Number(match[4]);
	if (!(end > start)) return null;
	return { discPath: match[1]!, playlist: match[2]!, start, end };
}

export const isDiscSource = (path: string | undefined | null): boolean => !!path && parseDiscSource(path) !== null;

/** Folders some rips put between a disc's own folder and BDMV, such as "Disc 1/BD_VIDEO/BDMV". */
const WRAPPER = /^(?:BD_?VIDEO|BD-?ROM|BDROM)$/i;

/** The name of the folder that stands for a disc. */
export function discLabel(discPath: string): string {
	const parts = discPath.split("/").filter(Boolean);
	const last = parts.pop() ?? discPath;
	return WRAPPER.test(last) && parts.length ? parts.pop()! : last;
}

export function clock(seconds: number): string {
	const s = Math.round(seconds);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const mmss = `${String(m).padStart(h ? 2 : 1, "0")}:${String(s % 60).padStart(2, "0")}`;
	return h ? `${h}:${mmss}` : mmss;
}

/** "Disc 1, playlist 00002, 0:00 to 23:40", or the path itself when it is a file. */
export function originalName(path: string): string {
	const range = parseDiscSource(path);
	if (!range) return path.slice(path.lastIndexOf("/") + 1) || path;
	return `${discLabel(range.discPath)}, playlist ${range.playlist}, ${clock(range.start)} to ${clock(range.end)}`;
}
