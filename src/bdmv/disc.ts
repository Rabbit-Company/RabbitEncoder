import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, dirname, join } from "path";
import { parseMpls } from "./mpls";
import type { DiscPlaylist } from "./classify";

export interface DiscFolder {
	/** The folder that holds BDMV. */
	path: string;
	label: string;
	playlists: DiscPlaylist[];
	/** Bytes of all the disc's clips, which grows while the disc is still being copied. */
	streamBytes: number;
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

/** Folders some rips put between a disc's own folder and BDMV, such as "Disc 1/BD_VIDEO/BDMV". */
const WRAPPER = /^(?:BD_?VIDEO|BD-?ROM|BDROM)$/i;

/** The folder that stands for a disc, which is above a wrapper such as BD_VIDEO. */
export function discHome(disc: string): string {
	return WRAPPER.test(basename(disc)) ? dirname(disc) : disc;
}

/** mkvmerge finds a disc's clips through its index.bdmv, so a folder without one cannot be read. */
export function isDiscFolder(path: string): boolean {
	return ["index.bdmv", "PLAYLIST", "STREAM"].every((name) => existsSync(join(path, "BDMV", name)));
}

/**
 * Disc folders at or under `root`, in disc order. Choosing the BDMV folder
 * itself means its disc. BDMV folders are not searched further.
 */
export function findDiscFolders(root: string, maxDepth = 4): string[] {
	if (basename(root).toUpperCase() === "BDMV" && isDiscFolder(dirname(root))) return [dirname(root)];
	const found: string[] = [];
	const visit = (dir: string, depth: number) => {
		if (isDiscFolder(dir)) {
			found.push(dir);
			return;
		}
		if (depth >= maxDepth) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries.sort((a, b) => byName(a.name, b.name))) {
			if (entry.isDirectory() && !entry.name.startsWith(".")) visit(join(dir, entry.name), depth + 1);
		}
	};
	visit(root, 0);
	return found;
}

/**
 * Disc sets in a folder: the discs that share a parent folder belong together.
 * Discs right inside one of `roots`, such as the input folder, are each a set
 * of their own, since unrelated discs are copied there side by side.
 */
export function groupDiscSets(discs: string[], roots: string[] = []): { path: string; discs: string[] }[] {
	const sets = new Map<string, string[]>();
	for (const disc of discs) {
		const home = discHome(disc);
		const parent = roots.includes(dirname(home)) || roots.includes(home) ? home : dirname(home);
		sets.set(parent, [...(sets.get(parent) ?? []), disc]);
	}
	return [...sets.entries()].map(([path, list]) => ({ path, discs: list.sort(byName) }));
}

export function streamBytes(disc: string): number {
	const dir = join(disc, "BDMV", "STREAM");
	let total = 0;
	try {
		for (const name of readdirSync(dir)) {
			try {
				total += statSync(join(dir, name)).size;
			} catch {}
		}
	} catch {}
	return total;
}

/**
 * Every playlist of a disc whose clips are all there. Playlists for 3D or
 * BD-J players name clips that are not plain M2TS files, and are left out.
 */
export function readDisc(path: string): DiscFolder {
	const dir = join(path, "BDMV", "PLAYLIST");
	const playlists: DiscPlaylist[] = [];
	for (const file of readdirSync(dir)
		.filter((name) => /^\d{5}\.mpls$/i.test(name))
		.sort(byName)) {
		try {
			const mpls = parseMpls(readFileSync(join(dir, file)));
			if (!mpls.items.length) continue;
			if (!mpls.items.every((item) => existsSync(join(path, "BDMV", "STREAM", `${item.clip}.m2ts`)))) continue;
			playlists.push({ name: file.slice(0, 5), mpls });
		} catch {}
	}
	return { path, label: basename(discHome(path)), playlists, streamBytes: streamBytes(path) };
}

const YEAR = /(?<![\d])(?:19|20)\d{2}(?![\d])/g;
/** Only the last one is the release year, so "Blade Runner 2049 2017" keeps its 2049. */
const LAST_YEAR = /(?<![\d])(?:19|20)\d{2}(?![\d])(?!.*(?<![\d])(?:19|20)\d{2}(?![\d]))/;

/** A release year in the set's or a disc's folder name, as in "Your Name (2016)". */
export function guessDiscYear(setPath: string, discs: string[]): number | undefined {
	for (const name of [basename(setPath), ...discs.map((d) => basename(discHome(d)))]) {
		const found = [...name.replace(/\b(?:1080|2160|720)p\b/gi, " ").matchAll(YEAR)].pop();
		if (found) return Number(found[0]);
	}
	return undefined;
}

const NOISE =
	/\b(?:bdmv|blu-?ray|bd(?:rip|box)?|remux|uhd|4k|2160p|1080p|1080i|720p|avc|hevc|vc-?1|flac|truehd|dts(?:-?hd)?(?:\s*ma)?|lpcm|jpn|eng|disc\s*\d+|vol(?:ume)?\.?\s*\d+)\b/gi;

/**
 * A title to search for, from the set's folder name, or from the disc's when
 * the set is one disc. Folders named like catalogue codes say nothing.
 */
export function guessDiscTitle(setPath: string, discs: string[]): string {
	const candidates = [basename(setPath), ...discs.map((d) => basename(discHome(d)))];
	for (const name of candidates) {
		const title = name
			.replace(/\[[^\]]*\]|\{[^}]*\}|\([^)]*\)/g, " ")
			.replace(/[._]+/g, " ")
			.replace(NOISE, " ")
			.replace(LAST_YEAR, " ")
			.replace(/\s+-\s*$/, "")
			.replace(/\s+/g, " ")
			.trim();
		const catalogueCode = !/\s/.test(name) && /^[A-Z0-9 -]+$/.test(title);
		if (title && /\p{L}/u.test(title) && !catalogueCode) return title;
	}
	return "";
}
