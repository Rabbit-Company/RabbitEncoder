import { basename, extname } from "path";
import { parseEpisodeKey } from "../pipeline/repair-pairing";

export interface SourcePair {
	targetPath: string;
	sourcePath: string;
	method: "episode" | "filename" | "single" | "none";
}

const episodeId = (path: string): string | null => {
	const key = parseEpisodeKey(path);
	return key ? `${key.season}:${key.episode}` : null;
};

const filenameId = (path: string): string =>
	basename(path, extname(path))
		.toLowerCase()
		.replace(/(?:[\s._-]+(?:denois(?:ed|e)|clean(?:ed)?|original|source))+$/g, "")
		.replace(/[\s._-]+/g, " ")
		.trim();

/** Match only unique episode numbers or unique names. An uncertain pair stays empty. */
export function pairOriginalSources(targets: string[], sources: string[]): SourcePair[] {
	const uniqueTargets = [...new Set(targets)];
	const uniqueSources = [...new Set(sources)];
	if (uniqueTargets.length === 1 && uniqueSources.length === 1 && uniqueTargets[0] !== uniqueSources[0]) {
		return [{ targetPath: uniqueTargets[0]!, sourcePath: uniqueSources[0]!, method: "single" }];
	}
	const count = (paths: string[], key: (path: string) => string | null): Map<string, string[]> => {
		const out = new Map<string, string[]>();
		for (const path of paths) {
			const id = key(path);
			if (id) out.set(id, [...(out.get(id) ?? []), path]);
		}
		return out;
	};
	const sourceEpisodes = count(uniqueSources, episodeId);
	const targetEpisodes = count(uniqueTargets, episodeId);
	const sourceNames = count(uniqueSources, filenameId);
	const targetNames = count(uniqueTargets, filenameId);
	return uniqueTargets.map((targetPath) => {
		const ep = episodeId(targetPath);
		if (ep && targetEpisodes.get(ep)?.length === 1 && sourceEpisodes.get(ep)?.length === 1) {
			const sourcePath = sourceEpisodes.get(ep)![0]!;
			if (sourcePath !== targetPath) return { targetPath, sourcePath, method: "episode" };
		}
		const name = filenameId(targetPath);
		if (name && targetNames.get(name)?.length === 1 && sourceNames.get(name)?.length === 1) {
			const sourcePath = sourceNames.get(name)![0]!;
			if (sourcePath !== targetPath) return { targetPath, sourcePath, method: "filename" };
		}
		return { targetPath, sourcePath: "", method: "none" };
	});
}
