import { existsSync, readFileSync, writeFileSync } from "fs";
import { basename, extname, join } from "path";
import { Logger } from "../core/logger";
import { run } from "../core/process";
import type { JobSettings } from "../core/types";
import { FONT_EXTS, fontRegistry, listMkvAttachments, scanFontNames, type ResolvedFace } from "../fonts/fonts";
import { createFaceMaterializer, type FaceMaterializer } from "../fonts/inject";
import { fontAttachmentFileName } from "../fonts/font-instance";
import { normalizeFontName } from "./ass-classifier";
import { restyleAssDialogueFont } from "./ass-style";
import { zlibWorthIt } from "./zlib-probe";

/** A subtitle track Rabbit adds to a file, translated or downloaded. */
export interface AddedTrack {
	file: string;
	format: "ass" | "srt";
	/** MKV language tag, which picks the face for its script. */
	language: string;
	/** Its dialogue uses the font group. */
	restyle?: boolean;
}

/**
 * Gives every added track that uses the font group its final face: the
 * group's face for the track's language, with the group's look, under the
 * family name the materializer found free. Rewrites `file` in place and
 * returns the faces to attach.
 */
export async function finishAddedTracks(tracks: AddedTrack[], settings: JobSettings, tempDir: string, materialize: FaceMaterializer): Promise<ResolvedFace[]> {
	const faces = new Map<string, ResolvedFace>();
	for (const [i, track] of tracks.entries()) {
		if (!track.restyle || track.format !== "ass" || !existsSync(track.file)) continue;
		const raw = readFileSync(track.file, "utf-8");
		const { face: baseFace, appearance } = fontRegistry.resolveFaceAndStyle(settings.fontGroup, track.language, raw);
		const face = await materialize(baseFace, appearance);
		const styled = restyleAssDialogueFont(raw, { ...appearance, fontName: face?.family || settings.fontGroup }, true);
		if (styled !== raw) {
			const file = join(tempDir, `added_${i}.final.ass`);
			writeFileSync(file, styled, "utf-8");
			track.file = file;
		}
		// Styled earlier with the same family, the text may not change here, but the face is still needed.
		if (face) faces.set(face.path, face);
		else Logger.warn(`[fonts] No face in group "${settings.fontGroup}" for the added ${track.language} subtitle`);
	}
	return [...faces.values()];
}

export interface FontReservations {
	/** Font names taken by attachments the remux keeps. */
	occupied: Set<string>;
	/** Attachment file names already in the file, lower case. */
	attachedFiles: Set<string>;
}

/** Family without the " 2" Rabbit adds when the plain name was taken. */
function baseFamily(family: string): string {
	return family.replace(/ \d+$/, "");
}

/**
 * Font names a remux must not reuse, as the file keeps all its attachments.
 * A face Rabbit attached in an earlier pass is recognised by its file name,
 * such as noto_sans.ttf for "Noto Sans", and left free so it is reused rather
 * than attached again under a new name.
 */
export async function remuxFontReservations(mkvPath: string, settings: JobSettings, tempDir: string, signal?: AbortSignal): Promise<FontReservations> {
	const occupied = new Set<string>();
	const attachedFiles = new Set<string>();
	const fonts = (await listMkvAttachments(mkvPath, signal)).filter((a) => FONT_EXTS.has(extname(a.fileName).toLowerCase()));
	for (const a of fonts) attachedFiles.add(a.fileName.toLowerCase());
	if (!fonts.length) return { occupied, attachedFiles };

	const groupFamilies = new Set((fontRegistry.findFamily(settings.fontGroup)?.faces ?? []).map((f) => normalizeFontName(f.family)));
	const outById = new Map(fonts.map((a) => [a.id, join(tempDir, `remux_font_${a.id}${extname(a.fileName).toLowerCase()}`)]));
	const extracted = await run(["mkvextract", mkvPath, "attachments", ...fonts.map((a) => `${a.id}:${outById.get(a.id)}`)], { signal });
	if (extracted.code !== 0) Logger.warn(`[fonts] Could not read the fonts attached to ${basename(mkvPath)}. Reserving their file names only.`);

	for (const a of fonts) {
		const out = outById.get(a.id)!;
		const { family, names } = existsSync(out) ? await scanFontNames(out, signal) : { family: "", names: [] };
		const ext = extname(a.fileName).toLowerCase();
		const ours = !!family && groupFamilies.has(normalizeFontName(baseFamily(family))) && a.fileName.toLowerCase() === fontAttachmentFileName(family, ext);
		if (ours) continue;
		if (names.length) for (const name of names) occupied.add(name);
		else occupied.add(normalizeFontName(basename(a.fileName, extname(a.fileName))));
	}
	return { occupied, attachedFiles };
}

/** mkvmerge arguments attaching the faces the file does not have yet. */
export function addedFontArgs(faces: ResolvedFace[], attachedFiles: Set<string>): string[] {
	const args: string[] = [];
	for (const face of faces) {
		if (attachedFiles.has(face.fileName.toLowerCase())) continue;
		attachedFiles.add(face.fileName.toLowerCase());
		args.push("--attachment-mime-type", face.mime || "font/ttf", "--attachment-name", face.fileName, "--attach-file", face.path);
	}
	return args;
}

export interface RemuxAddition {
	/** Attachment arguments for the fonts the added tracks need. */
	fontArgs: string[];
	/** Per-track mkvmerge compression arguments, empty when compression is off. */
	compressionArgs: Map<string, string[]>;
}

/**
 * Prepares tracks appended to an existing file without re-encoding: their
 * final font, the attachments that font needs, and compression when it pays.
 */
export async function prepareRemuxAddition(
	mkvPath: string,
	tracks: AddedTrack[],
	settings: JobSettings,
	tempDir: string,
	signal?: AbortSignal,
): Promise<RemuxAddition> {
	let fontArgs: string[] = [];
	if (tracks.some((t) => t.restyle && t.format === "ass")) {
		const reservations = await remuxFontReservations(mkvPath, settings, tempDir, signal);
		const materialize = createFaceMaterializer({ tempDir, occupiedNames: reservations.occupied, signal });
		const faces = await finishAddedTracks(tracks, settings, tempDir, materialize);
		fontArgs = addedFontArgs(faces, reservations.attachedFiles);
		if (fontArgs.length) Logger.info(`[fonts] Attaching ${faces.map((f) => f.fileName).join(", ")} for the added subtitles`);
	}
	const compressionArgs = new Map<string, string[]>();
	if (settings.compressSubtitles) {
		const minSavings = settings.compressSubtitlesMinSavings ?? 10;
		for (const track of tracks) {
			const worth = existsSync(track.file) && (await zlibWorthIt(track.file, tempDir, minSavings, signal));
			compressionArgs.set(track.file, ["--compression", worth ? "0:zlib" : "0:none"]);
		}
	}
	return { fontArgs, compressionArgs };
}
