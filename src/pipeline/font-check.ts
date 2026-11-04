import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { basename, join } from "path";
import { randomUUID } from "crypto";
import { mapPool } from "../core/concurrency";
import { CancelledError, run } from "../core/process";
import type { FontCheckFile, FontCheckJobRequest, FontCheckMissing, FontCheckResult, RepairPlan, SubtitleAddFont, SubtitleFileFontSource } from "../core/types";
import { extractUsedFonts, normalizeFontName } from "../subtitles/ass-classifier";
import { auditTrack, identifyMatroska, sanitizeRepairPlan } from "./repair";
import { readInputFonts } from "./repair-fonts";
import { assFontSpellings, isWindowsFont } from "./subtitle-files";

const isAssCodec = (codecId: string | undefined) => codecId === "S_TEXT/ASS" || codecId === "S_TEXT/SSA";

/** The fonts one video's ASS tracks use that it does not carry, read from its whole subtitle text. */
export async function checkFileFonts(path: string, tempDir: string, signal?: AbortSignal): Promise<{ file: FontCheckFile; spellings: Map<string, string> }> {
	const identified = await identifyMatroska(path, signal);
	const tracks = (identified.tracks ?? []).filter((t) => t.type === "audio" || t.type === "subtitles");
	const file: FontCheckFile = { path, fileName: basename(path), families: [], missing: [], tracks: tracks.map(auditTrack) };
	const spellings = new Map<string, string>();
	const ass = tracks.filter((t) => t.type === "subtitles" && isAssCodec(t.properties.codec_id));
	if (!ass.length) return { file, spellings };

	const dir = join(tempDir, randomUUID());
	mkdirSync(dir, { recursive: true });
	try {
		const fonts = await readInputFonts(path, -1, join(dir, "fonts"), signal);
		file.families = [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
		const attached = new Set(fonts.flatMap((f) => f.names));
		// One mkvextract pass reads every ASS track, as the file is read through once either way.
		const outOf = (id: number) => join(dir, `track_${id}.ass`);
		const extract = await run(["mkvextract", path, "tracks", ...ass.map((t) => `${t.id}:${outOf(t.id)}`)], { signal });
		if (signal?.aborted) throw new CancelledError();
		if (extract.code !== 0 && extract.code !== 1) {
			file.error = `Could not read its subtitles: ${(extract.stderr || extract.stdout).trim().slice(-200)}`;
			return { file, spellings };
		}
		const used = new Set<string>();
		for (const track of ass) {
			if (!existsSync(outOf(track.id))) continue;
			const text = readFileSync(outOf(track.id), "utf-8");
			for (const name of extractUsedFonts(text)) used.add(name);
			for (const [key, name] of assFontSpellings(text)) if (!spellings.has(key)) spellings.set(key, name);
		}
		file.missing = [...used].filter((name) => !attached.has(name)).sort();
		return { file, spellings };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Checks every video, two at a time as each is read through from disk. */
export async function checkFolderFonts(
	folder: string,
	paths: string[],
	tempDir: string,
	onProgress: (done: number, current: string) => void,
	signal?: AbortSignal,
): Promise<FontCheckResult> {
	let done = 0;
	const spellings = new Map<string, string>();
	const files = await mapPool(paths, 2, async (path) => {
		onProgress(done, basename(path));
		let checked: FontCheckFile;
		try {
			const result = await checkFileFonts(path, tempDir, signal);
			for (const [key, name] of result.spellings) if (!spellings.has(key)) spellings.set(key, name);
			checked = result.file;
		} catch (error) {
			if (error instanceof CancelledError || signal?.aborted) throw new CancelledError();
			checked = { path, fileName: basename(path), families: [], missing: [], tracks: [], error: error instanceof Error ? error.message : String(error) };
		}
		onProgress(++done, basename(path));
		return checked;
	});
	return summarizeFontCheck(folder, files, spellings);
}

export function summarizeFontCheck(folder: string, files: FontCheckFile[], spellings: Map<string, string>): FontCheckResult {
	const missing = new Map<string, FontCheckMissing>();
	for (const file of files) {
		for (const key of file.missing) {
			const entry = missing.get(key) ?? { key, name: spellings.get(key) ?? key, files: 0, ...(isWindowsFont(key) ? { windows: true } : {}) };
			entry.files++;
			missing.set(key, entry);
		}
	}
	const families = new Map<string, number>();
	for (const file of files) for (const family of file.families) families.set(family, (families.get(family) ?? 0) + 1);
	return {
		folder,
		files,
		missing: [...missing.values()].sort((a, b) => b.files - a.files || a.name.localeCompare(b.name)),
		families: [...families].map(([family, count]) => ({ family, files: count })).sort((a, b) => b.files - a.files || a.family.localeCompare(b.family)),
	};
}

export interface FontCheckUpload extends SubtitleFileFontSource {
	key: string;
}

/**
 * One repair per video that a chosen fix applies to. An uploaded font is
 * attached to the videos missing its font. A mapping points the subtitles at
 * a family the video carries, or at an uploaded font, which is then attached
 * too. Videos a fix cannot reach are left as they are.
 */
export function buildFontCheckPlans(
	result: FontCheckResult,
	request: Pick<FontCheckJobRequest, "maps" | "replaceTarget">,
	uploads: FontCheckUpload[],
	workRoot: string,
): { plans: RepairPlan[]; unreachable: { fileName: string; font: string; to: string }[] } {
	const nameOf = new Map(result.missing.map((m) => [m.key, m.name]));
	const uploadByKey = new Map(uploads.map((u) => [u.key, u]));
	const uploadByFamily = new Map(uploads.map((u) => [normalizeFontName(u.family), u]));
	const plans: RepairPlan[] = [];
	const unreachable: { fileName: string; font: string; to: string }[] = [];
	for (const file of result.files) {
		if (file.error || !file.missing.length) continue;
		const attach = new Map<string, FontCheckUpload>();
		const maps: { from: string; to: string }[] = [];
		for (const key of file.missing) {
			const upload = uploadByKey.get(key);
			if (upload) {
				attach.set(upload.path, upload);
				continue;
			}
			const map = request.maps.find((m) => m.key === key);
			if (!map) continue;
			const carried = file.families.find((family) => normalizeFontName(family) === normalizeFontName(map.to));
			const uploaded = uploadByFamily.get(normalizeFontName(map.to));
			if (carried) maps.push({ from: nameOf.get(key) ?? key, to: carried });
			else if (uploaded) {
				maps.push({ from: nameOf.get(key) ?? key, to: uploaded.family });
				attach.set(uploaded.path, uploaded);
			} else unreachable.push({ fileName: file.fileName, font: nameOf.get(key) ?? key, to: map.to });
		}
		if (!maps.length && !attach.size) continue;

		const workDir = join(workRoot, randomUUID());
		mkdirSync(workDir, { recursive: true });
		const taken = new Set<string>();
		const attachments: SubtitleAddFont[] = [...attach.values()].map((font) => {
			let fileName = font.fileName;
			for (let n = 2; taken.has(fileName.toLowerCase()); n++) fileName = fileName.replace(/(\.[^.]+)$/, `_${n}$1`);
			taken.add(fileName.toLowerCase());
			const copy = join(workDir, fileName);
			copyFileSync(font.path, copy);
			return { file: copy, fileName, names: font.names };
		});
		plans.push(
			sanitizeRepairPlan({
				targetPath: file.path,
				replaceTarget: request.replaceTarget,
				tracks: file.tracks
					.filter((track) => track.type === "subtitles")
					.map((track, order) => ({
						source: "target",
						trackId: track.id,
						mode: "copy",
						order,
						title: track.title,
						language: track.language,
						compression: "preserve",
						isDefault: track.isDefault,
						isForced: track.isForced,
						isEnabled: track.isEnabled,
						isHearingImpaired: track.isHearingImpaired,
						isOriginal: track.isOriginal,
						isCommentary: track.isCommentary,
					})),
				fontFix: { maps, attachments, workDir },
			}),
		);
	}
	return { plans, unreachable };
}
