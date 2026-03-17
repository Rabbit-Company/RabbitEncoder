import { watch, readdirSync, existsSync, statSync } from "fs";
import { join, extname } from "path";
import { addJob } from "./store";
import { Logger } from "./logger";

const MEDIA_EXTENSIONS = new Set([".mp4", ".mkv", ".avi", ".webm", ".flv", ".ts", ".mov"]);

const COOLDOWN_SEC = parseInt(process.env.FILE_COOLDOWN || "300");
const POLL_INTERVAL = 10;

const knownFiles = new Set<string>();

export function startWatcher(inputDir: string) {
	if (existsSync(inputDir)) {
		scanDirectory(inputDir);
	}

	try {
		const watcher = watch(inputDir, { recursive: false }, (event, filename) => {
			if (!filename) return;
			const ext = extname(filename).toLowerCase();
			if (!MEDIA_EXTENSIONS.has(ext)) return;

			const fullPath = join(inputDir, filename);
			if (knownFiles.has(fullPath)) return;

			waitForFile(fullPath, filename);
		});

		setInterval(() => scanDirectory(inputDir), 10_000);

		Logger.info(`[watcher] Watching ${inputDir} for media files (cooldown: ${COOLDOWN_SEC}s)`);
	} catch (err: any) {
		Logger.error(`[watcher] Error starting watcher:`, { "error.message": err?.message });
		setInterval(() => scanDirectory(inputDir), 10_000);
		Logger.info(`[watcher] Polling ${inputDir} for media files (cooldown: ${COOLDOWN_SEC}s, fallback mode)`);
	}
}

function scanDirectory(dir: string) {
	try {
		const files = readdirSync(dir);
		for (const file of files) {
			const ext = extname(file).toLowerCase();
			if (!MEDIA_EXTENSIONS.has(ext)) continue;

			const fullPath = join(dir, file);
			if (knownFiles.has(fullPath)) continue;

			waitForFile(fullPath, file);
		}
	} catch {}
}

async function waitForFile(fullPath: string, filename: string) {
	if (knownFiles.has(fullPath)) return;
	knownFiles.add(fullPath);

	const requiredStableChecks = Math.ceil(COOLDOWN_SEC / POLL_INTERVAL);
	let lastSize = -1;
	let stableCount = 0;

	Logger.info(`[watcher] Detected ${filename}, waiting ${COOLDOWN_SEC}s for file to stabilize...`);

	while (stableCount < requiredStableChecks) {
		await new Promise((r) => setTimeout(r, POLL_INTERVAL * 1000));

		try {
			const stat = statSync(fullPath);
			if (stat.size === lastSize && stat.size > 0) {
				stableCount++;
			} else {
				if (stableCount > 0) {
					Logger.info(`[watcher] ${filename} still changing, resetting cooldown...`);
				}
				stableCount = 0;
				lastSize = stat.size;
			}
		} catch {
			Logger.info(`[watcher] ${filename} was removed, skipping`);
			knownFiles.delete(fullPath);
			return;
		}
	}

	Logger.info(`[watcher] ${filename} stable for ${COOLDOWN_SEC}s, queuing for encode`);
	addJob(filename, fullPath);
}
