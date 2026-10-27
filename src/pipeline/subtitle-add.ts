import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "fs";
import { basename, extname, join, parse as parsePath } from "path";
import type { AppConfig, Job, JobStep, SubtitleAddPlan, SubtitleAddTrack, SubtitleStreamInfo } from "../core/types";
import { Logger } from "../core/logger";
import { CancelledError, humanSize, run } from "../core/process";
import { buildSubtitleTrackName, detectSubtitleTrackType, sanitizeLanguageTag } from "../tracks/tracks";
import { ocrPgsTrack, PGS_CODEC, pictureTrackFlagArgs, unreadPictureTracks } from "../ocr/ocr";
import { resolveTranslateLang } from "../translate/translate-languages";
import { probeFile } from "./probe";
import { fitTimingToVideo } from "../ocr/fit-timing";
import { retimeDocument, type TimeMap } from "../subsearch/cues";
import { finalizeOutput } from "./output";
import { mkvtoolnixProgress } from "./prepare-progress";
import { identifyMatroska } from "./repair";
import { computeDownloadedFlagArgs, styleSource } from "../translate/translate-step";
import { DEFAULT_STYLE_APPEARANCE } from "../subtitles/subtitle-style";
import { prepareRemuxAddition, type AddedTrack } from "../subtitles/added-tracks";
import { orderTranslatedByPriority, planTrackOrder, type ExistingTrack } from "./translate-only";

export function describeSubtitleAddPlan(plan: SubtitleAddPlan): string {
	if (plan.ocr) {
		const which = plan.ocr.streams
			? `${plan.ocr.streams.length} picture subtitle track(s)`
			: `picture subtitles${plan.ocr.languages?.length ? ` in ${plan.ocr.languages.join(", ")}` : ""}`;
		return `Reading ${which} with OCR`;
	}
	return `Adding ${plan.tracks.map((t) => t.language).join(", ")} subtitles`;
}

/**
 * Reads the requested picture tracks into SRT files, as tracks to add. They
 * come from the video itself, or from its original, whose timing is then
 * checked against the video and corrected. A track that fails is skipped
 * with a warning.
 */
async function readPictureTracks(
	plan: SubtitleAddPlan,
	job: Job,
	tempDir: string,
	signal: AbortSignal | undefined,
	onProgress: (progress: number, detail: string) => void,
): Promise<{ tracks: SubtitleAddTrack[]; read: SubtitleStreamInfo[]; warnings: string[]; note?: string }> {
	const request = plan.ocr!;
	const source = request.sourcePath ?? plan.targetPath;
	const targetProbe = await probeFile(plan.targetPath);
	const streams = source === plan.targetPath ? (targetProbe.subtitleStreams ?? []) : ((await probeFile(source)).subtitleStreams ?? []);
	const languages = new Set((request.languages ?? []).map((l) => resolveTranslateLang(l)?.code).filter(Boolean));
	const chosen = request.streams
		? streams.filter((s) => request.streams!.includes(s.index) && s.codec.toLowerCase() === PGS_CODEC)
		: unreadPictureTracks(streams, targetProbe.subtitleStreams ?? []).filter((s) => !languages.size || languages.has(resolveTranslateLang(s.language)?.code));
	const texts: Array<{ stream: SubtitleStreamInfo; srt: string }> = [];
	const warnings: string[] = [];
	for (const [n, stream] of chosen.entries()) {
		const label = `track ${stream.index} (${stream.language || "und"})`;
		try {
			const srt = await ocrPgsTrack({
				inputPath: source,
				stream,
				tempDir,
				settings: job.settings,
				signal,
				onProgress: (done, total) =>
					onProgress(Math.round(((n + done / Math.max(1, total)) / chosen.length) * 100), `Reading ${label}, ${done}/${total} pictures`),
			});
			if (srt.trim()) texts.push({ stream, srt });
			else warnings.push(`No text was read from ${label}`);
		} catch (error) {
			if (error instanceof CancelledError || signal?.aborted) throw new CancelledError();
			warnings.push(`OCR of ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// Tracks of one original share its timeline, so the longest one decides the time map for all.
	let map: TimeMap | null = null;
	let note: string | undefined;
	if (source !== plan.targetPath && texts.length) {
		onProgress(100, "Checking the timing against the video");
		const longest = [...texts].sort((a, b) => b.srt.length - a.srt.length)[0]!;
		const fit = await fitTimingToVideo(longest.srt, plan.targetPath, targetProbe, tempDir, signal);
		if (!fit.ok) return { tracks: [], read: [], warnings: [...warnings, `Not added: ${fit.error}`] };
		map = fit.map;
		note = fit.note;
	}

	const tracks: SubtitleAddTrack[] = [];
	for (const { stream, srt } of texts) {
		const type = detectSubtitleTrackType(stream);
		const file = join(plan.workDir, `ocr_${stream.index}.srt`);
		writeFileSync(file, map ? retimeDocument({ format: "srt", content: srt }, map).content : srt, "utf-8");
		tracks.push({
			file,
			language: stream.language || "und",
			trackName: buildSubtitleTrackName(type, stream.title, "OCR"),
			hearingImpaired: !!stream.isHearingImpaired || type === "sdh",
			trackType: type,
			fromPicture: true,
			forced: !!stream.isForced,
			original: !!stream.isOriginal,
		});
	}
	// Only the video's own picture tracks can be removed from it.
	return { tracks, read: source === plan.targetPath ? texts.map((t) => t.stream) : [], warnings, note };
}

/**
 * Appends downloaded subtitles to a video with mkvmerge, which copies every
 * other track, attachment, chapter and tag unchanged, then replaces the video.
 */
export async function runSubtitleAddJob(job: Job, config: AppConfig, updateJob: (partial: Partial<Job>) => void, signal?: AbortSignal): Promise<void> {
	const plan = job.subtitleAddPlan!;
	const tempDir = join(config.tempDir, job.id);
	mkdirSync(tempDir, { recursive: true });
	const steps: JobStep[] = [
		...(plan.ocr ? [{ label: "Read Subtitles", status: "pending" as const, progress: 0 }] : []),
		{ label: "Mux", status: "pending", progress: 0 },
		{ label: "Write Output", status: "pending", progress: 0 },
	];
	const S_READ = 0;
	const S_MUX = plan.ocr ? 1 : 0;
	const S_WRITE = S_MUX + 1;
	const setStep = (idx: number, partial: Partial<JobStep>) => {
		const step = steps[idx]!;
		if (partial.status === "active" && step.status !== "active") step.startedAt = Date.now();
		if ((partial.status === "done" || partial.status === "error") && !step.finishedAt) step.finishedAt = Date.now();
		Object.assign(step, partial);
		updateJob({
			steps: [...steps],
			progress: Math.round((steps.reduce((sum, s) => sum + s.progress, 0) / steps.length) * 100) / 100,
			currentStage: steps.find((s) => s.status === "active")?.label || job.currentStage,
		});
	};

	try {
		const missing = plan.tracks.filter((t) => !existsSync(t.file));
		if (missing.length) throw new Error("The downloaded subtitles are no longer available. Search again.");

		let tracks = plan.tracks;
		let removed: SubtitleStreamInfo[] = [];
		if (plan.ocr) {
			setStep(S_READ, { status: "active", progress: 0, detail: "Finding picture subtitles" });
			updateJob({ status: "encoding_video" });
			mkdirSync(plan.workDir, { recursive: true });
			const result = await readPictureTracks(plan, job, tempDir, signal, (progress, detail) => setStep(S_READ, { progress, detail }));
			for (const warning of result.warnings) Logger.warn(`[ocr] ${warning}`);
			if (result.warnings.length) updateJob({ warning: result.warnings.join(". ") });
			if (!result.tracks.length) {
				if (result.warnings.length) throw new Error(result.warnings.join(". "));
				// Nothing to read, so the file stays as it is.
				for (const idx of [S_READ, S_MUX, S_WRITE])
					setStep(idx, { status: "done", progress: 100, detail: idx === S_READ ? "No picture subtitles to read" : "Source unchanged" });
				updateJob({ status: "done", currentStage: "Complete", progress: 100, outputFilename: basename(plan.targetPath), finishedAt: Date.now() });
				return;
			}
			setStep(S_READ, { status: "done", progress: 100, detail: `Read ${result.tracks.length} track(s)${result.note ? `, ${result.note}` : ""}` });
			tracks = [...tracks, ...result.tracks];
			if (plan.ocr.removePictures) removed = result.read;
		}

		setStep(S_MUX, { status: "active", progress: 0, detail: "Styling subtitles" });
		updateJob({ status: "muxing" });
		// The same styling native tracks get: SRT to ASS and the dialogue font, per the settings.
		const styled: Array<SubtitleAddTrack & AddedTrack> = [];
		for (const [i, track] of tracks.entries()) {
			const ass = extname(track.file).toLowerCase() === ".ass";
			const style = { ...DEFAULT_STYLE_APPEARANCE, fontName: job.settings.fontGroup };
			const type = track.trackType ?? (track.hearingImpaired ? "sdh" : "full");
			const result = await styleSource(track.file, ass ? "ass" : "subrip", type, job.settings, style, tempDir, i, signal);
			const file = join(tempDir, `added_${i}.styled.${result.format}`);
			writeFileSync(file, result.content, "utf-8");
			styled.push({ ...track, file, format: result.format, restyle: result.styled });
		}
		const addition = await prepareRemuxAddition(plan.targetPath, styled, job.settings, tempDir, signal);
		if (signal?.aborted) throw new CancelledError();

		setStep(S_MUX, { progress: 5, detail: `Adding ${styled.map((t) => t.language).join(", ")} subtitles` });
		const ordered = orderTranslatedByPriority(styled, job.settings.subtitleLanguagePriority);
		const identified = await identifyMatroska(plan.targetPath, signal);
		// The n-th subtitle stream ffprobe lists is the n-th subtitle track mkvmerge lists.
		const probedSubs = removed.length ? ((await probeFile(plan.targetPath)).subtitleStreams ?? []) : [];
		const mkvSubs = (identified.tracks ?? []).filter((t) => t.type === "subtitles");
		const dropIds = new Set(removed.map((s) => mkvSubs[probedSubs.findIndex((p) => p.index === s.index)]?.id).filter((id): id is number => id !== undefined));
		const existing: ExistingTrack[] = (identified.tracks ?? [])
			.filter((t) => !dropIds.has(t.id))
			.map((t) => ({
				id: t.id,
				type: t.type,
				language: t.properties.language_ietf || t.properties.language,
			}));
		const finalOutput = join(tempDir, "final.mkv");
		const args = ["mkvmerge", "--gui-mode", "-o", finalOutput, ...(dropIds.size ? ["--subtitle-tracks", `!${[...dropIds].join(",")}`] : []), plan.targetPath];
		for (const track of ordered) {
			args.push("--language", `0:${sanitizeLanguageTag(track.language, `added ${track.language}`)}`);
			args.push("--track-name", `0:${track.trackName}`, "--sub-charset", "0:UTF-8");
			const flags = track.fromPicture
				? pictureTrackFlagArgs({ forced: track.forced, hearingImpaired: track.hearingImpaired, original: track.original }, track.trackType ?? "full")
				: computeDownloadedFlagArgs(track.hearingImpaired, !track.extra);
			args.push(...flags, ...(addition.compressionArgs.get(track.file) ?? []), track.file);
		}
		args.push(...addition.fontArgs);
		args.push(
			"--track-order",
			planTrackOrder(
				existing,
				ordered.map((t) => t.language),
				job.settings.subtitleLanguagePriority,
			),
		);
		Logger.info(`[subsearch] Muxing ${ordered.map((t) => t.language).join(", ")} into ${basename(plan.targetPath)}`);
		const res = await run(args, {
			signal,
			onStdoutLine: (line) => {
				const percent = mkvtoolnixProgress(line);
				if (percent !== null) setStep(S_MUX, { progress: percent });
			},
		});
		if (signal?.aborted) throw new CancelledError();
		if (res.code !== 0 && res.code !== 1) throw new Error(`mkvmerge failed (exit ${res.code}): ${(res.stderr || res.stdout).trim().slice(-500)}`);
		setStep(S_MUX, { status: "done", progress: 100 });

		setStep(S_WRITE, { status: "active", progress: 0, detail: "Writing output" });
		updateJob({ status: "writing_output" });
		const outputPath = await finalizeOutput(job, config, finalOutput, `${parsePath(plan.targetPath).name}.mkv`, signal, (progress, detail) =>
			setStep(S_WRITE, { progress, detail }),
		);
		setStep(S_WRITE, { status: "done", progress: 100 });
		updateJob({
			status: "done",
			currentStage: "Complete",
			progress: 100,
			outputFilename: basename(outputPath),
			encodedFileSize: humanSize(statSync(outputPath).size),
			finishedAt: Date.now(),
		});
	} catch (err: any) {
		const active = steps.findIndex((s) => s.status === "active");
		if (active >= 0) steps[active]!.status = "error";
		if (err instanceof CancelledError) {
			updateJob({ status: "cancelled", currentStage: "Cancelled", steps: [...steps] });
			throw err;
		}
		Logger.error(err?.message);
		updateJob({ status: "error", currentStage: "Failed", steps: [...steps], error: err?.message || String(err) });
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
		if (job.status === "done" || job.status === "cancelled") rmSync(plan.workDir, { recursive: true, force: true });
	}
}
