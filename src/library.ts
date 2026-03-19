import { readdirSync, statSync, existsSync } from "fs";
import { join, resolve, extname, parse as parsePath } from "path";
import { MEDIA_EXTENSIONS } from "./types";

export interface LibraryEntry {
	name: string;
	path: string;
	type: "directory" | "file";
	size?: number;
	videoCount?: number;
	encodedCount?: number;
	encoded?: boolean;
}

/**
 * Check if a video file was already encoded by this tool.
 * Matches filenames ending with -{ORGANIZATION}.ext ("-RabbitCompany.mkv")
 */
export function isAlreadyEncoded(filename: string, organization: string): boolean {
	const stem = parsePath(filename).name;
	return stem.endsWith(`-${organization}`);
}

/**
 * Validate that the requested path is within one of the allowed library dirs.
 */
export function isPathAllowed(requestedPath: string, libraryDirs: string[]): boolean {
	const resolved = resolve(requestedPath);
	return libraryDirs.some((dir) => {
		const resolvedDir = resolve(dir);
		return resolved === resolvedDir || resolved.startsWith(resolvedDir + "/");
	});
}

/**
 * List the contents of a directory within a library path.
 * Returns folders and video files, marking already-encoded files.
 */
export function browseFolder(folderPath: string, organization: string): LibraryEntry[] {
	const resolved = resolve(folderPath);
	if (!existsSync(resolved)) return [];

	const entries: LibraryEntry[] = [];

	try {
		const dirEntries = readdirSync(resolved, { withFileTypes: true });

		for (const entry of dirEntries) {
			// Skip hidden files/folders
			if (entry.name.startsWith(".")) continue;

			const fullPath = join(resolved, entry.name);

			if (entry.isDirectory()) {
				const counts = countVideosRecursive(fullPath, organization);
				entries.push({
					name: entry.name,
					path: fullPath,
					type: "directory",
					videoCount: counts.total,
					encodedCount: counts.encoded,
				});
			} else {
				const ext = extname(entry.name).toLowerCase();
				if (MEDIA_EXTENSIONS.has(ext)) {
					const encoded = isAlreadyEncoded(entry.name, organization);
					try {
						const stat = statSync(fullPath);
						entries.push({
							name: entry.name,
							path: fullPath,
							type: "file",
							size: stat.size,
							encoded,
						});
					} catch {
						entries.push({
							name: entry.name,
							path: fullPath,
							type: "file",
							encoded,
						});
					}
				}
			}
		}
	} catch {}

	entries.sort((a, b) => {
		if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
		return a.name.localeCompare(b.name, undefined, { numeric: true });
	});

	return entries;
}

/**
 * Count video files recursively inside a folder.
 * Returns total count and already-encoded count.
 */
function countVideosRecursive(dir: string, organization: string): { total: number; encoded: number } {
	let total = 0;
	let encoded = 0;
	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				const sub = countVideosRecursive(fullPath, organization);
				total += sub.total;
				encoded += sub.encoded;
			} else {
				const ext = extname(entry.name).toLowerCase();
				if (MEDIA_EXTENSIONS.has(ext)) {
					total++;
					if (isAlreadyEncoded(entry.name, organization)) {
						encoded++;
					}
				}
			}
		}
	} catch {}
	return { total, encoded };
}
