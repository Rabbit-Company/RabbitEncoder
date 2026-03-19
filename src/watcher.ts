import { watch, readdirSync, existsSync, statSync } from "fs";
import { join, extname, relative, dirname } from "path";
import { addJob } from "./store";
import { Logger } from "./logger";

const MEDIA_EXTENSIONS = new Set([".mp4", ".mkv", ".avi", ".webm", ".flv", ".ts", ".mov"]);

const COOLDOWN_SEC = parseInt(process.env.FILE_COOLDOWN || "300");
const POLL_INTERVAL = 10;

const knownFiles = new Set<string>();

export function startWatcher(inputDir: string) {
	if (existsSync(inputDir)) {
		scanDirectory(inputDir, inputDir);
	}

	try {
		const watcher = watch(inputDir, { recursive: true }, (event, filename) => {
			if (!filename) return;
			const ext = extname(filename).toLowerCase();
			if (!MEDIA_EXTENSIONS.has(ext)) return;

			const fullPath = join(inputDir, filename);
			if (knownFiles.has(fullPath)) return;

			const relativePath = dirname(filename);
			waitForFile(fullPath, filename, relativePath === "." ? "" : relativePath);
		});

		setInterval(() => scanDirectory(inputDir, inputDir), 10_000);

		Logger.info(`[watcher] Watching ${inputDir} recursively for media files (cooldown: ${COOLDOWN_SEC}s)`);
	} catch (err: any) {
		Logger.error(`[watcher] Error starting watcher:`, { "error.message": err?.message });
		setInterval(() => scanDirectory(inputDir, inputDir), 10_000);
		Logger.info(`[watcher] Polling ${inputDir} recursively for media files (cooldown: ${COOLDOWN_SEC}s, fallback mode)`);
	}
}

function scanDirectory(dir: string, inputRoot: string) {
	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);

			if (entry.isDirectory()) {
				scanDirectory(fullPath, inputRoot);
				continue;
			}

			const ext = extname(entry.name).toLowerCase();
			if (!MEDIA_EXTENSIONS.has(ext)) continue;

			if (knownFiles.has(fullPath)) continue;

			const rel = relative(inputRoot, dir);
			waitForFile(fullPath, entry.name, rel === "." ? "" : rel);
		}
	} catch {}
}

async function waitForFile(fullPath: string, filename: string, relativePath: string) {
	if (knownFiles.has(fullPath)) return;
	knownFiles.add(fullPath);

	const requiredStableChecks = Math.ceil(COOLDOWN_SEC / POLL_INTERVAL);
	let lastSize = -1;
	let stableCount = 0;

	const displayName = relativePath ? `${relativePath}/${filename}` : filename;
	Logger.info(`[watcher] Detected ${displayName}, waiting ${COOLDOWN_SEC}s for file to stabilize...`);

	while (stableCount < requiredStableChecks) {
		await new Promise((r) => setTimeout(r, POLL_INTERVAL * 1000));

		try {
			const stat = statSync(fullPath);
			if (stat.size === lastSize && stat.size > 0) {
				stableCount++;
			} else {
				if (stableCount > 0) {
					Logger.info(`[watcher] ${displayName} still changing, resetting cooldown...`);
				}
				stableCount = 0;
				lastSize = stat.size;
			}
		} catch {
			Logger.info(`[watcher] ${displayName} was removed, skipping`);
			knownFiles.delete(fullPath);
			return;
		}
	}

	Logger.info(`[watcher] ${displayName} stable for ${COOLDOWN_SEC}s, queuing for encode`);
	addJob(filename, fullPath, relativePath);
}
