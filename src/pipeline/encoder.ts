import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, unlinkSync, rmSync, readdirSync, symlinkSync, renameSync } from "fs";
import { join, parse as parsePath, dirname, extname, basename, resolve } from "path";
import type { Job, JobStep, AppConfig, EncodeJobOptions, SubtitleBurnMode, AudioStreamInfo, SubtitleStreamInfo } from "../core/types";
import { probeFile, getOpusBitrateForLayout, getAudioReplacementLabel, normalizeLayout } from "./probe";
import { Logger } from "../core/logger";
import { CancelledError, run, humanSize, fmtFrames, pct2, escapeXml, describeExitCode, isTimecodesVFR, computeFps } from "../core/process";
import {
	detectAudioTrackType,
	sortAudioStreams,
	deduplicateAudioStreams,
	detectSubtitleTrackType,
	buildSubtitleTrackName,
	sortSubtitleStreams,
	analyzeSubtitleStreams,
	normalizeLanguageGroup,
	deduplicateSubtitleStreams,
	filterStreamsByLanguage,
	sanitizeLanguageTag,
	filterSubtitleTypes,
	filterAudioTypes,
	buildAudioTrackName,
	isTextSubtitleCodec,
	DEFAULT_IGNORE_KEYWORD,
	filterIgnoredTracks,
	computeSubtitleDefaultIndexByLang,
} from "../tracks/tracks";
import { styleSrtAss, restyleAssDialogueFont } from "../subtitles/ass-style";
import { extractUsedFonts, normalizeFontName } from "../subtitles/ass-classifier";
import { fontRegistry, buildKeptAttachmentArgs, scanMkvAttachmentFontNames, type ResolvedFace } from "../fonts/fonts";
import { detectSourceTag, detectReleaseGroup, getResolutionTag, extractBaseTitle, inferSourceFromStream } from "../core/naming";
import pkg from "../../package.json";
import { buildPrepareFilterConfig } from "../video/filters";
import { FFV1_ENCODE_ARGS, runAnalysisPass, runSegmentedAutoDenoiseGpu, type DenoisePlan } from "../video/auto-denoise";
import { formatVsProgressDetail, runVsPass, vsRegistry } from "../video/vs-filters";
import { applyColorMetadata, svtColorParamsFromProbe } from "../video/color-metadata";
import { combineCumulativeSettings, encodeSettingsCode } from "../settings/settings-code";
import { decodePriorSettings } from "../core/mkv-tags";
import { cpus } from "os";
import { getEncoder } from "../core/encoders";
import { axisSuffix, chooseAvailableFontFamily, fontAttachmentFileName, instancedFontNames, instanceFont } from "../fonts/font-instance";
import { DEFAULT_STYLE_APPEARANCE, type StyleAppearance } from "../subtitles/subtitle-style";
import { runTranslateStep, orderOutputSubtitles, type TranslatedTrack } from "../translate/translate-step";
import { cleanupAssociatedFiles, resolveUniqueOutputPath } from "./output";
import { computeDisplayDimensions, isPlausibleDar, resolveSourceSar } from "../video/aspect";

export { CancelledError } from "../core/process";

const S_PROBE = 0;
const S_PREPARE = 1;
const S_FAST = 2;
const S_METRICS = 3;
const S_SCENES = 4;
const S_ZONES = 5;
const S_FINAL = 6;
const S_AUDIO = 7;
const S_TRANSLATE = 8;
const S_SUBS = 9;
const S_MUX = 10;

function makeSteps(): JobStep[] {
	return [
		{ label: "Analyze", status: "pending", progress: 0 },
		{ label: "Prepare", status: "pending", progress: 0 },
		{ label: "Fast Pass", status: "pending", progress: 0 },
		{ label: "Metrics", status: "pending", progress: 0 },
		{ label: "Scenes", status: "pending", progress: 0 },
		{ label: "Zones", status: "pending", progress: 0 },
		{ label: "Final Encode", status: "pending", progress: 0 },
		{ label: "Audio", status: "pending", progress: 0 },
		{ label: "Translate", status: "pending", progress: 0 },
		{ label: "Subtitles", status: "pending", progress: 0 },
		{ label: "Mux & Finish", status: "pending", progress: 0 },
	];
}

const stripAnsiAndControls = (s: string) =>
	s
		// CSI sequences: ESC [ ... command
		.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
		// OSC sequences: ESC ] ... BEL or ST
		.replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
		// Other ESC sequences
		.replace(/\x1B[@-_][0-?]*[ -/]*[@-~]/g, "")
		// Remaining non-printing controls except \r and \n
		.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

function fmtFramesWithFps(current: number, total: number, startedAt: number | undefined, estVideoSize?: string, estTotalSize?: string): string {
	const base = fmtFrames(current, total);
	const fps = computeFps(current, startedAt);
	const fpsStr = fps ? ` (${fps} fps)` : "";
	const estStr = estVideoSize && estTotalSize ? ` — Video: ~${estVideoSize} · Total: ~${estTotalSize}` : "";
	return `${base}${fpsStr}${estStr}`;
}

/** Burn mode for the first subtitle of a file: libass for text, overlay for bitmap. */
function burnModeForFirstSub(streams: { codec: string }[] | undefined): SubtitleBurnMode {
	const first = streams?.[0];
	if (!first) return "none";
	return isTextSubtitleCodec(first.codec) ? "text" : "bitmap";
}

interface AssMaterializeResult {
	ok: boolean;
	empty: boolean;
	detail: string;
}

/**
 * Materialize one ASS/SSA subtitle as a plain .ass file for style/font
 * inspection. The normal FFmpeg demux path is fast, but some Matroska ASS
 * tracks fail that second remux even though the track itself is valid. Fall
 * back to mkvextract against the already-isolated one-track MKV before giving
 * up and disabling unused-font cleanup for safety.
 */
async function materializeAssForInspection(
	sourcePath: string,
	sourceStreamIndex: number,
	isolatedTrackPath: string,
	outPath: string,
	signal?: AbortSignal,
): Promise<AssMaterializeResult> {
	const usable = (): boolean => {
		try {
			return existsSync(outPath) && statSync(outPath).size > 0;
		} catch {
			return false;
		}
	};

	const resetOutput = () => {
		try {
			unlinkSync(outPath);
		} catch {}
	};

	const errors: string[] = [];

	// First try the original source directly. This avoids depending on the
	// intermediate one-track MKV when its subtitle metadata is unusual.
	resetOutput();
	const direct = await run(
		[
			"ffmpeg",
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-i",
			sourcePath,
			"-map",
			`0:${sourceStreamIndex}`,
			"-c:s",
			"copy",
			"-vn",
			"-an",
			"-map_chapters",
			"-1",
			"-map_metadata",
			"-1",
			outPath,
		],
		{ signal },
	);
	if ((direct.code === 0 || direct.code === 1) && usable()) {
		return { ok: true, empty: false, detail: "" };
	}
	errors.push(`direct ffmpeg: ${direct.stderr || direct.stdout || `exit ${direct.code}`}`);

	// Then try FFmpeg against the isolated subtitle MKV.
	resetOutput();
	const isolated = await run(
		[
			"ffmpeg",
			"-hide_banner",
			"-loglevel",
			"error",
			"-y",
			"-i",
			isolatedTrackPath,
			"-map",
			"0:s:0",
			"-c:s",
			"copy",
			"-vn",
			"-an",
			"-map_chapters",
			"-1",
			"-map_metadata",
			"-1",
			outPath,
		],
		{ signal },
	);
	if ((isolated.code === 0 || isolated.code === 1) && usable()) {
		return { ok: true, empty: false, detail: "" };
	}
	errors.push(`isolated ffmpeg: ${isolated.stderr || isolated.stdout || `exit ${isolated.code}`}`);

	// mkvextract preserves the ASS codec-private header and packets verbatim.
	// Query the isolated file instead of assuming its Matroska track id is 0.
	resetOutput();
	const identify = await run(["mkvmerge", "-J", isolatedTrackPath], { signal });
	if (identify.code === 0) {
		try {
			const json = JSON.parse(identify.stdout) as { tracks?: Array<{ id?: number; type?: string }> };
			const subtitleTrack = json.tracks?.find((track) => track.type === "subtitles" && Number.isInteger(track.id));
			if (subtitleTrack?.id !== undefined) {
				const extracted = await run(["mkvextract", isolatedTrackPath, "tracks", `${subtitleTrack.id}:${outPath}`], { signal });
				if ((extracted.code === 0 || extracted.code === 1) && usable()) {
					return { ok: true, empty: false, detail: "" };
				}
				errors.push(`mkvextract: ${extracted.stderr || extracted.stdout || `exit ${extracted.code}`}`);
			} else {
				errors.push("mkvextract: isolated file contains no identifiable subtitle track");
			}
		} catch (err) {
			errors.push(`mkvmerge JSON: ${err instanceof Error ? err.message : String(err)}`);
		}
	} else {
		errors.push(`mkvmerge identify: ${identify.stderr || identify.stdout || `exit ${identify.code}`}`);
	}

	// A short preview clip can legitimately contain an ASS stream with zero
	// packets. Such a track cannot render anything in this output and therefore
	// contributes no used fonts. Do not disable cleanup for the whole mux.
	const packetProbe = await run(
		[
			"ffprobe",
			"-v",
			"error",
			"-select_streams",
			"s:0",
			"-count_packets",
			"-show_entries",
			"stream=nb_read_packets",
			"-of",
			"default=noprint_wrappers=1:nokey=1",
			isolatedTrackPath,
		],
		{ signal },
	);
	if (packetProbe.code === 0) {
		const count = Number(packetProbe.stdout.trim());
		if (Number.isFinite(count) && count === 0) {
			resetOutput();
			return { ok: false, empty: true, detail: "track contains no subtitle packets" };
		}
	}

	resetOutput();
	return { ok: false, empty: false, detail: errors.map((e) => e.slice(-300)).join(" | ") };
}

/**
 * Trial-mux `file` with and without zlib and report whether compression
 * shrinks the muxed track by at least `minSavingsPct` percent. Matroska zlib
 * is applied per block, so short subtitle events often *grow* — measuring
 * real mkvmerge output is the only exact way to know. Any probe failure
 * returns false (leave the track uncompressed).
 */
async function zlibWorthIt(file: string, tempDir: string, minSavingsPct: number, signal?: AbortSignal): Promise<boolean> {
	const tag = basename(file).replace(/[^\w.-]/g, "_");
	const outNone = join(tempDir, `zprobe_none_${tag}.mkv`);
	const outZlib = join(tempDir, `zprobe_zlib_${tag}.mkv`);
	try {
		const rn = await run(["mkvmerge", "-o", outNone, "--compression", "0:none", file], { signal });
		if (rn.code > 1) return false; // mkvmerge exit 1 = warnings only
		const rz = await run(["mkvmerge", "-o", outZlib, "--compression", "0:zlib", file], { signal });
		if (rz.code > 1) return false;
		const noneSize = statSync(outNone).size;
		const zlibSize = statSync(outZlib).size;
		if (noneSize <= 0) return false;
		const savings = ((noneSize - zlibSize) / noneSize) * 100;
		Logger.info(`[subtitle] zlib probe ${tag}: ${noneSize} -> ${zlibSize} B (${savings.toFixed(1)}% savings, threshold ${minSavingsPct}%)`);
		return savings >= minSavingsPct;
	} catch (err) {
		// Cancellation is not a failed compression experiment. Propagate it so a
		// sibling stage failure immediately tears down subtitle preparation.
		if (signal?.aborted) {
			const reason = (signal as AbortSignal & { reason?: unknown }).reason;
			if (reason instanceof Error) throw reason;
			throw new CancelledError();
		}
		Logger.warn(`[subtitle] zlib probe failed for ${tag}; leaving uncompressed: ${err}`);
		return false;
	} finally {
		for (const f of [outNone, outZlib]) {
			try {
				unlinkSync(f);
			} catch {}
		}
	}
}

/**
 * Ground-truth dimensions of the encoded video. Must be measured, not derived:
 * crop, downscale, and VapourSynth passes can all change the frame, and only
 * the finished file knows the result.
 */
async function probeVideoDimensions(path: string, signal?: AbortSignal): Promise<{ width: number; height: number } | null> {
	const res = await run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", path], { signal });
	if (res.code !== 0) return null;
	try {
		const s = JSON.parse(res.stdout)?.streams?.[0];
		if (s?.width > 0 && s?.height > 0) return { width: s.width, height: s.height };
	} catch {}
	return null;
}

export async function encodeJob(
	job: Job,
	config: AppConfig,
	updateJob: (partial: Partial<Job>) => void,
	signal?: AbortSignal,
	opts: EncodeJobOptions = {},
): Promise<void> {
	const previewMode = opts.mode === "preview" || !!opts.preview;
	const sink = opts.preview ?? null;
	const tempDir = join(config.tempDir, job.id);
	mkdirSync(tempDir, { recursive: true });

	const stem = parsePath(job.filename).name;
	const releaseGroup = detectReleaseGroup(stem);
	const baseTitle = extractBaseTitle(stem);

	const steps = makeSteps();

	function setStep(idx: number, partial: Partial<JobStep>) {
		const step = steps[idx]!;

		if (partial.status === "active" && step.status !== "active") {
			step.startedAt = Date.now();
			step.finishedAt = undefined;
		}

		if ((partial.status === "done" || partial.status === "error") && step.status !== "done" && step.status !== "error") {
			step.finishedAt = Date.now();

			if (!step.startedAt) {
				step.startedAt = step.finishedAt;
			}
		}

		Object.assign(step, partial);
		const overall = steps.reduce((sum, s) => sum + s.progress, 0) / steps.length;
		const activeStep = steps.find((s) => s.status === "active");

		updateJob({
			steps: [...steps],
			progress: Math.round(overall * 100) / 100,
			currentStage: activeStep?.label || job.currentStage,
		});
	}

	function checkCancelled() {
		if (signal?.aborted) throw new CancelledError();
	}

	try {
		// Probe
		checkCancelled();
		setStep(S_PROBE, { status: "active", progress: 0 });
		updateJob({ status: "probing" });

		const probe = await probeFile(job.inputPath);
		updateJob({ probe });

		let sourceTag = detectSourceTag(stem);
		if (sourceTag === "Bluray") {
			const inferred = inferSourceFromStream(probe.videoCodec, probe.width, probe.height);
			if (inferred) {
				sourceTag = inferred;
				Logger.info(`[probe] Inferred source from stream: ${inferred} (${probe.videoCodec}, ${probe.width}x${probe.height})`);
			}
		}

		setStep(S_PROBE, { status: "done", progress: 100 });

		// Prepare
		checkCancelled();
		setStep(S_PREPARE, { status: "active", progress: 0 });

		const preparedVideo = join(tempDir, "source_video.mkv");
		const timecodesFile = join(tempDir, "timecodes_v2.txt");

		const tcRes = await run(["mkvextract", job.inputPath, "timestamps_v2", `${probe.videoStreamIndex}:${timecodesFile}`], { signal });
		if (tcRes.code !== 0) {
			Logger.warn(`[prepare] Timecodes extraction failed, will use default timing: ${tcRes.stderr || tcRes.stdout}`);
		}

		const extractRes = await run(["ffmpeg", "-y", "-i", job.inputPath, "-map", `0:v:0`, "-c:v", "copy", "-an", "-sn", preparedVideo], { signal });

		if (extractRes.code !== 0) {
			throw new Error(`Failed to extract video stream: ${extractRes.stderr || extractRes.stdout}`);
		}

		if (sink) {
			// Preview: source comparison still (raw clip, first subtitle burned in).
			await sink.capture(job.inputPath, "source.png", burnModeForFirstSub(probe.subtitleStreams));
		}

		// VapourSynth filter chain
		const activeVsEntries = (job.settings.vsFilters ?? []).filter((e) => e.level !== "off");

		if (activeVsEntries.length > 0) {
			const totalFrames = Math.round(probe.duration * probe.videoStreamFps);
			let currentInput = preparedVideo;

			for (let i = 0; i < activeVsEntries.length; i++) {
				checkCancelled();
				const entry = activeVsEntries[i]!;
				const manifest = vsRegistry.get(entry.presetId);
				if (!manifest) {
					Logger.warn(`[prepare] Skipping unknown VS preset: ${entry.presetId}`);
					continue;
				}

				const outPath = join(tempDir, `vs_${i}_${manifest.bareId}.mkv`);
				const label = `${manifest.name} (${entry.level})`;
				const passBaseProgress = (i / activeVsEntries.length) * 4.5;
				const passShare = 4.5 / activeVsEntries.length;

				setStep(S_PREPARE, { progress: passBaseProgress, detail: `${label} — ${fmtFrames(0, totalFrames)}` });
				Logger.info(`[prepare] VS pass ${i + 1}/${activeVsEntries.length}: ${manifest.id} level=${entry.level}`);

				await runVsPass({
					manifest,
					entry,
					inputPath: currentInput,
					outputPath: outPath,
					totalFrames,
					signal,
					onProgress: (current, fps) => {
						const passFrac = totalFrames > 0 ? current / totalFrames : 0;
						setStep(S_PREPARE, {
							progress: passBaseProgress + passShare * passFrac,
							detail: formatVsProgressDetail(manifest.name, entry.level, current, totalFrames, fps),
						});
					},
				});

				if (currentInput !== preparedVideo) {
					try {
						unlinkSync(currentInput);
					} catch {}
				}
				currentInput = outPath;
				if (sink) await sink.capture(outPath, `vs_${i}.png`, "none");
			}

			if (currentInput !== preparedVideo) {
				try {
					unlinkSync(preparedVideo);
				} catch {}
				renameSync(currentInput, preparedVideo);
			}

			Logger.info(`[prepare] VapourSynth chain complete (${activeVsEntries.length} pass(es))`);
		}

		// Prepare filter pass (downscale + deband + denoise)
		let autoPlan: DenoisePlan | null = null;
		if (job.settings.denoise === "auto") {
			checkCancelled();
			setStep(S_PREPARE, { progress: 4.7, detail: "Analyzing noise..." });
			try {
				const metric = job.settings.autoDenoiseMetric;
				const thresholds = metric === "bitrate" ? job.settings.autoDenoiseBitrateThresholds : job.settings.autoDenoiseThresholds;
				autoPlan = await runAnalysisPass(preparedVideo, tempDir, probe.duration, metric, thresholds, signal);
			} catch (err) {
				if (err instanceof CancelledError) throw err;
				Logger.warn(`[auto-denoise] Analysis failed, proceeding without denoise: ${err instanceof Error ? err.message : err}`);
				autoPlan = null;
			}
			updateJob({ autoDenoisePlan: autoPlan });
		}

		const prepareFilter = await buildPrepareFilterConfig({
			inputPath: job.inputPath,
			crop: job.settings.crop,
			cropLimit: job.settings.cropLimit,
			downscale: job.settings.downscale,
			sourceHeight: probe.height,
			sourceWidth: probe.width,
			denoise: job.settings.denoise,
			denoiseBackend: job.settings.denoiseBackend,
			deband: job.settings.deband,
			gpuDevice: job.settings.gpuDevice,
			nlmeansParams: job.settings.nlmeansParams,
			gradfunParams: job.settings.gradfunParams,
			autoPlan,
			totalDuration: probe.duration,
		});

		if (prepareFilter) {
			checkCancelled();

			const totalFrames = Math.round(probe.duration * probe.videoStreamFps);
			setStep(S_PREPARE, { progress: 5, detail: `${prepareFilter.label} — ${fmtFrames(0, totalFrames)}` });
			Logger.debug(`[prepare] Applying filters: ${prepareFilter.filter} (${totalFrames} frames)`);

			const filteredVideo = join(tempDir, "source_video_filtered.mkv");
			const filterStartedAt = Date.now();

			const filterArgs = ["ffmpeg", "-y", ...prepareFilter.preInputArgs, "-i", preparedVideo];
			if (prepareFilter.filter) {
				filterArgs.push("-vf", prepareFilter.filter);
			}
			filterArgs.push(...FFV1_ENCODE_ARGS, "-an", "-sn", filteredVideo);

			const filterProc = Bun.spawn(filterArgs, {
				stdout: "pipe",
				stderr: "pipe",
			});

			const onAbortFilter = () => {
				try {
					filterProc.kill("SIGTERM");
				} catch {}
				setTimeout(() => {
					try {
						filterProc.kill("SIGKILL");
					} catch {}
				}, 3000);
			};
			signal?.addEventListener("abort", onAbortFilter, { once: true });

			const stderrTask = (async () => {
				if (!filterProc.stderr) return "";

				try {
					const reader = filterProc.stderr.getReader();
					const decoder = new TextDecoder();
					let buffer = "";
					let lastUpdate = 0;
					const errLines: string[] = [];

					while (true) {
						try {
							const { done, value } = await reader.read();
							if (done) break;
							buffer += decoder.decode(value, { stream: true });
							const parts = buffer.split(/[\r\n]/);
							buffer = parts.pop() || "";

							for (const part of parts) {
								const frameMatch = part.match(/frame=\s*(\d+)/);
								if (frameMatch && totalFrames > 0) {
									const current = parseInt(frameMatch[1]!);
									const now = Date.now();
									if (now - lastUpdate >= 1000) {
										lastUpdate = now;
										const fps = computeFps(current, filterStartedAt);
										const fpsStr = fps ? ` (${fps} fps)` : "";
										setStep(S_PREPARE, {
											progress: 5 + pct2(current, totalFrames) * 0.95,
											detail: `${prepareFilter.label} — ${fmtFrames(current, totalFrames)}${fpsStr}`,
										});
									}
								} else if (part.trim()) {
									errLines.push(part);
									if (errLines.length > 200) errLines.shift();
								}
							}
						} catch {
							break;
						}
					}

					buffer += decoder.decode();
					if (buffer.trim()) errLines.push(buffer);
					return errLines.join("\n");
				} catch {}
			})();

			const stdoutTask = new Response(filterProc.stdout).text();

			const [filterCode, stderrTail] = await Promise.all([filterProc.exited, stderrTask, stdoutTask]);
			signal?.removeEventListener("abort", onAbortFilter);
			checkCancelled();

			if (filterCode !== 0) {
				throw new Error(`Prepare filter failed (exit ${filterCode}): ${stderrTail?.trim().slice(-500)}`);
			}

			unlinkSync(preparedVideo);
			renameSync(filteredVideo, preparedVideo);

			Logger.info(`[prepare] Filter pass complete`);
		}

		if (prepareFilter?.deferredAutoDenoise) {
			checkCancelled();
			const { plan, backend, gpuDevice, nlmeansParams } = prepareFilter.deferredAutoDenoise;
			const denoisedVideo = join(tempDir, "source_video_denoised.mkv");

			Logger.info(`[prepare] Running segmented GPU auto-denoise (${plan.length} ranges, ${backend} on device ${gpuDevice})`);

			await runSegmentedAutoDenoiseGpu(
				preparedVideo,
				denoisedVideo,
				plan,
				probe.duration,
				backend,
				gpuDevice,
				tempDir,
				nlmeansParams,
				(i, n, label) => {
					setStep(S_PREPARE, {
						progress: 5 + (95 * i) / n,
						detail: `Auto denoise GPU — segment ${i}/${n} (${label})`,
					});
				},
				signal,
			);

			unlinkSync(preparedVideo);
			renameSync(denoisedVideo, preparedVideo);

			Logger.info(`[prepare] Segmented GPU auto-denoise complete`);
		}

		if (sink) await sink.capture(preparedVideo, "prepare.png", "none");

		setStep(S_PREPARE, { status: "done", progress: 100 });

		const skipVideoEncode = job.settings.videoEncode === "off";
		const skipAudioEncode = job.settings.audioEncode === "copy";
		const skipSubtitleProcessing = job.settings.subtitleProcessing === "copy";
		const audioDetect = {
			commentary: job.settings.detectCommentaryAudio,
			descriptive: job.settings.detectDescriptiveAudio,
			karaoke: job.settings.detectKaraokeAudio,
		};

		const translateIsLocal = /(?:localhost|127\.0\.0\.1|\[?::1\]?)(?::|\/|$)/i.test(job.settings.translateBaseUrl ?? "");
		const overlapPolicy = job.settings.translateDuringEncode ?? "auto";
		const overlapTranslate = overlapPolicy === "always" || (overlapPolicy === "auto" && !translateIsLocal);

		const stageAbort = new AbortController();
		const stageSignal = stageAbort.signal;
		const onOuterAbort = () => stageAbort.abort((signal as any)?.reason ?? new CancelledError());
		if (signal) {
			if (signal.aborted) stageAbort.abort((signal as any).reason);
			else signal.addEventListener("abort", onOuterAbort, { once: true });
		}

		let videoMkv: string;
		let audioStreams: AudioStreamInfo[] = [];
		const encodedAudioFiles: string[] = [];
		let subtitleStreams: SubtitleStreamInfo[] = [];
		let translatedTracks: TranslatedTrack[] = [];

		interface PlannedSubtitle {
			stream: SubtitleStreamInfo;
			subFile: string;
			effectiveLang: string;
			trackName: string;
			trackType: string;
			flagArgs: string[];
		}

		// Subtitle preparation is completed during the parallel encode phase.
		// Mux only consumes these final files and their precomputed decisions.
		const plannedSubs: PlannedSubtitle[] = [];
		const zlibDecisions = new Map<string, boolean>();

		// Font state is populated by subtitle preparation and consumed by mux.
		const sourceExt = extname(job.inputPath).toLowerCase();
		const occupiedFontNames = new Set<string>();
		// Fonts still referenced by untouched source subtitle content after the
		// provisional restyle. Only this set may keep source font attachments.
		const sourceAttachmentUsedFonts = new Set<string>();
		let effectiveRemoveUnusedFonts = job.settings.removeUnusedFonts;
		const resolvedFaces = new Map<string, ResolvedFace>();
		const instanceCache = new Map<string, ResolvedFace>();

		function cleanAttachmentExtension(fileName: string): string {
			const extension = extname(fileName).toLowerCase();
			if (extension === ".otf") return ".otf";
			if (extension === ".ttc" || extension === ".otc") return extension;
			return ".ttf";
		}

		const applyAxes = async (face: ResolvedFace | null, appearance: StyleAppearance): Promise<ResolvedFace | null> => {
			if (!face) return null;
			const axes = face.axes ?? [];
			const { suffix: axisKey, coords } = axisSuffix(axes, appearance.fontAxes ?? {});
			const cacheKey = `${face.path}|${axisKey || "default"}|${appearance.bold ? "bold" : "regular"}`;
			const cached = instanceCache.get(cacheKey);
			if (cached) return cached;

			const family = chooseAvailableFontFamily(face.family, occupiedFontNames, appearance.bold);
			const familyChanged = family !== face.family;
			const needsMaterializedCopy = axisKey.length > 0 || familyChanged;
			const sourceFontExt = cleanAttachmentExtension(face.fileName);
			const materializedExt = sourceFontExt === ".otf" ? ".otf" : ".ttf";

			let resolved: ResolvedFace;
			if (needsMaterializedCopy) {
				const materializeKey = `${cacheKey}|${family}`;
				const out = join(tempDir, `inst_${Buffer.from(materializeKey).toString("base64url").slice(0, 40)}${materializedExt}`);
				const inst = await instanceFont(face.path, coords, family, appearance.bold, out, stageSignal);
				if (inst) {
					resolved = {
						...face,
						family: inst.family,
						path: inst.path,
						names: inst.names,
						fileName: fontAttachmentFileName(family, materializedExt),
						mime: fontRegistry.mime(inst.path),
					};
				} else {
					Logger.warn(`[fonts] Could not materialize ${face.fileName} as "${family}"; using the original face`);
					resolved = { ...face, fileName: fontAttachmentFileName(face.family, sourceFontExt) };
				}
			} else {
				resolved = { ...face, fileName: fontAttachmentFileName(family, sourceFontExt) };
			}

			for (const name of resolved.names.length > 0 ? resolved.names : instancedFontNames(resolved.family, false)) {
				occupiedFontNames.add(name);
			}
			instanceCache.set(cacheKey, resolved);
			return resolved;
		};

		const encodeVideo = async (): Promise<void> => {
			if (skipVideoEncode) {
				for (const si of [S_FAST, S_METRICS, S_SCENES, S_ZONES, S_FINAL]) {
					setStep(si, { status: "done", progress: 100, detail: "Skipped — video encoding off" });
				}
			}

			if (!skipVideoEncode) {
				// ABE or direct encode
				checkCancelled();
				updateJob({ status: "encoding_video" });

				const ivfFile = join(tempDir, "source_video.ivf");
				const inProgressIvf = join(tempDir, "abe_temp", "source_video.ivf");
				const enc = getEncoder(job.settings.encoder);

				const estimatedAudioStreams = (probe.audioStreams || []).filter((s) => !s.title || !/compatibility/i.test(s.title));
				const estimatedAudioBytes = Math.round(
					((estimatedAudioStreams.reduce((sum, s) => {
						const layout = normalizeLayout(s.channelLayout, s.channels);
						return sum + getOpusBitrateForLayout(layout, job.settings.audioBitrates);
					}, 0) *
						1000) /
						8) *
						probe.duration,
				);

				if (enc.usesAutoBoost) {
					const colorParams = svtColorParamsFromProbe(probe);
					const custom = job.settings.customEncoderParams?.trim() ?? "";
					const finalParams = custom ? `${colorParams} ${custom}` : colorParams;

					const abeArgs = [
						"python3",
						"-u",
						"/opt/Auto-Boost-Essential/Auto-Boost-Essential.py",
						"-i",
						preparedVideo,
						"-t",
						join(tempDir, "abe_temp"),
						"--quality",
						job.settings.quality,
						"--final-speed",
						job.settings.finalSpeed,
						"--fast-params",
						colorParams,
						"--final-params",
						finalParams,
						"--json-stream",
					];

					if (job.settings.skipBoosting) {
						abeArgs.push("-nb");
					}

					const abeProc = Bun.spawn(abeArgs, {
						stdout: "pipe",
						stderr: "pipe",
						cwd: tempDir,
					});

					const onAbortAbe = () => {
						try {
							abeProc.kill("SIGTERM");
						} catch {}
						setTimeout(() => {
							try {
								abeProc.kill("SIGKILL");
							} catch {}
						}, 3000);
					};
					stageSignal?.addEventListener("abort", onAbortAbe, { once: true });

					const abeStageToStep: Record<number, number> = {
						0: S_FAST,
						1: S_METRICS,
						2: S_SCENES,
						3: S_ZONES,
						4: S_FINAL,
					};

					let abeStderr = "";
					let abeLastError = "";

					const handleAbeEvent = (evt: any) => {
						const si = abeStageToStep[evt.stage];

						if (evt.event === "stage" && si !== undefined) {
							setStep(si, {
								status: "active",
								progress: 0,
								detail: evt.total_frames ? fmtFrames(0, evt.total_frames) : undefined,
							});
							return;
						}

						if (evt.event === "progress" && si !== undefined) {
							let estVideo: string | undefined;
							let estTotal: string | undefined;

							if (evt.stage === 4 && evt.current > 0 && evt.total > 0) {
								const frac = evt.current / evt.total;
								if (frac >= 0.02) {
									try {
										const curBytes = statSync(inProgressIvf).size;
										const estVideoBytes = curBytes / frac;
										const estTotalBytes = estVideoBytes + estimatedAudioBytes + 2 * 1024 * 1024;
										estVideo = humanSize(estVideoBytes);
										estTotal = humanSize(estTotalBytes);
										updateJob({
											estimatedVideoSize: estVideo,
											estimatedFinalSize: estTotal,
										});
									} catch {}
								}
							}

							setStep(si, {
								progress: pct2(evt.current, evt.total),
								detail: evt.total ? fmtFramesWithFps(evt.current, evt.total, steps[si]!.startedAt, estVideo, estTotal) : undefined,
							});
							return;
						}

						if (evt.event === "stage_complete" && si !== undefined) {
							setStep(si, {
								status: "done",
								progress: 100,
								detail: evt.total_frames ? fmtFramesWithFps(evt.total_frames, evt.total_frames, steps[si]!.startedAt) : steps[si]!.detail,
							});
							return;
						}

						if (evt.event === "error") {
							abeLastError = evt.message || "Unknown error";
							Logger.error("[ABE error]", { message: evt.message });
						}
					};

					const abeStdoutTask = (async () => {
						if (!abeProc.stdout) return;

						try {
							const reader = abeProc.stdout.getReader();
							const decoder = new TextDecoder();
							let buffer = "";

							while (true) {
								try {
									const { done, value } = await reader.read();
									if (done) break;

									buffer += decoder.decode(value, { stream: true });
									const lines = buffer.split("\n");
									buffer = lines.pop() || "";

									for (const rawLine of lines) {
										const line = rawLine.trim();
										if (!line) continue;

										try {
											const evt = JSON.parse(line);
											handleAbeEvent(evt);
										} catch {
											Logger.warn(`[ABE stdout non-json]`, { output: rawLine });
										}
									}
								} catch {
									break;
								}
							}

							buffer += decoder.decode();

							const trailing = buffer.trim();
							if (trailing) {
								try {
									const evt = JSON.parse(trailing);
									handleAbeEvent(evt);
								} catch {
									Logger.warn(`[ABE stdout trailing non-json]`, { output: trailing });
								}
							}
						} catch {}
					})();

					const abeStderrTask = (async () => {
						if (!abeProc.stderr) return;

						try {
							const reader = abeProc.stderr.getReader();
							const decoder = new TextDecoder();

							while (true) {
								try {
									const { done, value } = await reader.read();
									if (done) break;

									const chunk = decoder.decode(value, { stream: true });
									abeStderr += chunk;

									if (chunk.trim()) {
										Logger.error("[ABE stderr]", { error: chunk.trimEnd() });
									}
								} catch {
									break;
								}
							}

							abeStderr += decoder.decode();
						} catch {}
					})();

					const [abeCode] = await Promise.all([abeProc.exited, abeStdoutTask, abeStderrTask]);
					stageSignal?.removeEventListener("abort", onAbortAbe);
					checkCancelled();

					if (abeCode !== 0) {
						const exitSignal = abeCode > 128 ? describeExitCode(abeCode) : null;
						const detail = abeLastError || abeStderr.trim().slice(-500) || exitSignal || "No error details available";
						throw new Error(`Auto-Boost-Essential failed (exit ${abeCode}): ${detail}`);
					}

					if (job.settings.skipBoosting) {
						// Skip boosting: mark ABE-only steps as done (skipped)
						for (const si of [S_FAST, S_METRICS, S_SCENES, S_ZONES]) {
							setStep(si, { status: "done", progress: 100, detail: "Skipped" });
						}
					}
				} else {
					// DIRECT ENCODE
					// ABE-only steps don't apply (mark them skipped)
					for (const si of [S_FAST, S_METRICS, S_SCENES, S_ZONES]) {
						setStep(si, { status: "done", progress: 100, detail: `Skipped — ${enc.label}` });
					}

					setStep(S_FINAL, { status: "active", progress: 0 });

					const colorParams = svtColorParamsFromProbe(probe); // string of SVT --flags
					const totalFrames = Math.max(1, Math.round(probe.duration * probe.videoStreamFps));

					const customParams = (job.settings.customEncoderParams || "").trim();
					const customList = customParams.length > 0 ? customParams.split(/\s+/) : [];

					const y4mFifo = join(tempDir, "direct_y4m.fifo");
					try {
						unlinkSync(y4mFifo);
					} catch {}
					const mkfifoRes = await run(["mkfifo", y4mFifo], { signal: stageSignal });
					if (mkfifoRes.code !== 0) {
						throw new Error(`Failed to create encode FIFO: ${mkfifoRes.stderr || mkfifoRes.stdout}`);
					}

					const ffArgs = ["ffmpeg", "-nostdin", "-y", "-i", preparedVideo, "-f", "yuv4mpegpipe", "-strict", "-1", "-pix_fmt", "yuv420p10le", y4mFifo];
					const encArgs = [
						enc.binary,
						"-i",
						y4mFifo,
						"--progress",
						"2",
						...colorParams.split(/\s+/).filter(Boolean),
						"--crf",
						String(job.settings.manualCrf),
						"--preset",
						String(job.settings.manualPreset),
						...customList,
						"-b",
						inProgressIvf,
					];

					mkdirSync(join(tempDir, "abe_temp"), { recursive: true });

					const ffProc = Bun.spawn(ffArgs, { stdout: "ignore", stderr: "ignore", cwd: tempDir });
					const encProc = Bun.spawn(encArgs, {
						stdout: "ignore",
						stderr: "pipe",
						cwd: tempDir,
					});

					const onAbort = () => {
						for (const p of [ffProc, encProc]) {
							try {
								p.kill("SIGTERM");
							} catch {}
						}
						setTimeout(() => {
							for (const p of [ffProc, encProc]) {
								try {
									p.kill("SIGKILL");
								} catch {}
							}
						}, 3000);
					};
					stageSignal?.addEventListener("abort", onAbort, { once: true });

					// Parse SVT stderr/stdout progress for the current frame count.
					let encStderr = "";

					const stderrTask = (async () => {
						if (!encProc.stderr) return;

						const reader = encProc.stderr.getReader();
						const decoder = new TextDecoder();
						let buffer = "";

						const handleProgressLine = (rawLine: string) => {
							const line = stripAnsiAndControls(rawLine).trim();

							// Supports:
							//   Encoding frame   123
							//   Encoding:   123 Frames @ 8.67 fps | ...
							const m = line.match(/Encoding frame\s+(\d+)/i) || line.match(/Encoding:\s*(\d+)\s+Frames?\b/i);

							if (!m) return;

							const current = parseInt(m[1]!, 10);
							if (!Number.isFinite(current) || current <= 0) return;

							let estVideo: string | undefined;
							let estTotal: string | undefined;

							const frac = current / totalFrames;

							if (frac >= 0.02) {
								try {
									const curBytes = statSync(inProgressIvf).size;
									const estVideoBytes = curBytes / frac;
									const estTotalBytes = estVideoBytes + estimatedAudioBytes + 2 * 1024 * 1024;

									estVideo = humanSize(estVideoBytes);
									estTotal = humanSize(estTotalBytes);

									updateJob({
										estimatedVideoSize: estVideo,
										estimatedFinalSize: estTotal,
									});
								} catch {}
							}

							setStep(S_FINAL, {
								progress: pct2(current, totalFrames),
								detail: fmtFramesWithFps(current, totalFrames, steps[S_FINAL]!.startedAt, estVideo, estTotal),
							});
						};

						while (true) {
							let chunk;

							try {
								chunk = await reader.read();
							} catch {
								break;
							}

							if (chunk.done) break;

							const text = decoder.decode(chunk.value, { stream: true });
							encStderr += text;
							buffer += text;

							const lines = buffer.split(/\r|\n/);
							buffer = lines.pop() || "";

							for (const line of lines) {
								handleProgressLine(line);
							}
						}

						if (buffer.trim()) {
							handleProgressLine(buffer);
						}
					})();

					const encCode = await encProc.exited;

					try {
						ffProc.kill("SIGTERM");
					} catch {}
					await ffProc.exited;
					await stderrTask;

					stageSignal?.removeEventListener("abort", onAbort);

					try {
						unlinkSync(y4mFifo);
					} catch {}

					checkCancelled();

					if (encCode !== 0) {
						const detail = encStderr.trim().slice(-500) || describeExitCode(encCode);
						throw new Error(`${enc.label} failed (exit ${encCode}): ${detail}`);
					}

					setStep(S_FINAL, { status: "done", progress: 100 });

					if (existsSync(inProgressIvf)) renameSync(inProgressIvf, ivfFile);
				}

				if (!existsSync(ivfFile)) {
					throw new Error("Encoder did not produce output .ivf file");
				}

				videoMkv = join(tempDir, "video_only.mkv");
				const muxVidRes = await run(["mkvmerge", "-o", videoMkv, ivfFile], { signal: stageSignal });
				if (muxVidRes.code !== 0 && muxVidRes.code !== 1) {
					throw new Error(`mkvmerge video: ${muxVidRes.stderr || muxVidRes.stdout}`);
				}
				updateJob({ encodedVideoSize: humanSize(statSync(videoMkv).size) });
			} else {
				// FFV1 prepared video is the final video track.
				videoMkv = preparedVideo;
				setStep(S_FINAL, { status: "done", progress: 100, detail: "Skipped — video encoding off" });
			}
		};

		const doAudio = async (): Promise<void> => {
			checkCancelled();
			setStep(S_AUDIO, { status: "active", progress: 0 });
			updateJob({ status: "encoding_audio" });

			const allAudioStreams = filterIgnoredTracks(probe.audioStreams || [], DEFAULT_IGNORE_KEYWORD, "audio");

			if (opts.precomputed) {
				// Preview: reuse the whole-source audio selection so every clip keeps identical ordering/naming.
				audioStreams = opts.precomputed.audioStreams;
			} else {
				const allowedAudioLangs = job.settings.audioLanguages || [];
				const langFiltered = filterStreamsByLanguage(allAudioStreams, allowedAudioLangs, "audio");
				const skippedLang = allAudioStreams.length - langFiltered.length;
				if (skippedLang > 0) Logger.info(`[audio] Filtered ${skippedLang} track(s) not in [${allowedAudioLangs.join(", ")}]`);

				const typeFiltered = filterAudioTypes(
					langFiltered,
					{
						removeCommentary: job.settings.removeCommentaryAudio,
						removeDescriptive: job.settings.removeDescriptiveAudio,
						removeKaraoke: job.settings.removeKaraokeAudio,
						dropCompatibility: job.settings.dropCompatibilityAudio,
					},
					audioDetect,
				);
				const droppedByType = langFiltered.length - typeFiltered.length;
				if (droppedByType > 0) Logger.info(`[audio] Dropped ${droppedByType} track(s) by type/compatibility filters`);

				const sorted = sortAudioStreams(typeFiltered, {
					languagePriority: job.settings.audioLanguagePriority,
					preferUncensored: job.settings.preferUncensoredAudio,
					detect: audioDetect,
				});

				audioStreams = job.settings.dedupeAudio
					? deduplicateAudioStreams(sorted, {
							collapseChannels: job.settings.keepBestAudioChannelsOnly,
							codecPriority: job.settings.audioCodecPriority,
							preferUncensored: job.settings.preferUncensoredAudio,
							detect: audioDetect,
						})
					: sorted;

				if (job.settings.dedupeAudio && sorted.length !== audioStreams.length) {
					Logger.info(`[audio] Deduplicated ${sorted.length - audioStreams.length} redundant track(s)`);
				}
			}

			const sortedTypes = audioStreams.map((s) => `${s.language || "und"}:${detectAudioTrackType(s, audioDetect)}:${s.channels || "?"}ch`);
			Logger.info(`[audio] Track order: ${sortedTypes.join(", ")}`);

			if (skipAudioEncode) {
				setStep(S_AUDIO, {
					status: "done",
					progress: 100,
					detail: "Skipped — audio copied from source",
				});
			} else if (audioStreams.length === 0) {
				setStep(S_AUDIO, { status: "done", progress: 100, detail: "No audio streams" });
			} else {
				setStep(S_AUDIO, { progress: 5, detail: `Extracting ${audioStreams.length} audio stream(s)` });

				interface AudioEncodeJob {
					index: number;
					flacFile: string;
					opusFile: string;
					bitrate: number;
					copy: boolean;
				}

				const audioJobs: AudioEncodeJob[] = [];

				for (let i = 0; i < audioStreams.length; i++) {
					checkCancelled();

					const stream = audioStreams[i]!;
					const flacFile = join(tempDir, `audio_${i}.flac`);
					const opusFile = join(tempDir, `audio_${i}.opus`);
					encodedAudioFiles.push(opusFile);

					const layout = normalizeLayout(stream.channelLayout, stream.channels);
					const bitrate = getOpusBitrateForLayout(layout, job.settings.audioBitrates);

					const delayMs = stream.delayMs;
					const delaySec = delayMs / 1000;

					const isOpusSource = (stream.codec || "").toLowerCase() === "opus";
					const sourceKbps = stream.bitrate ? stream.bitrate / 1000 : undefined;
					const canCopy = isOpusSource && delayMs === 0 && sourceKbps !== undefined && sourceKbps <= bitrate;

					if (canCopy) {
						const copyArgs = [
							"ffmpeg",
							"-y",
							"-i",
							job.inputPath,
							"-map",
							`0:${stream.index}`,
							"-vn",
							"-sn",
							"-dn",
							"-map_metadata",
							"-1",
							"-map_chapters",
							"-1",
							"-c:a",
							"copy",
							opusFile,
						];
						const copyRes = await run(copyArgs, { signal: stageSignal });
						if (copyRes.code !== 0) {
							throw new Error(`FFmpeg audio copy failed for stream ${i}: ${copyRes.stderr || copyRes.stdout}`);
						}

						audioJobs.push({ index: i, flacFile, opusFile, bitrate, copy: true });
						Logger.info(`[audio] Stream ${i} already Opus @ ~${Math.round(sourceKbps)}kbps (<= ${bitrate}kbps target) — copying without re-encode`);

						setStep(S_AUDIO, {
							progress: 5 + Math.round(((i + 1) / audioStreams.length) * 35),
							detail: `Copying audio (${i + 1}/${audioStreams.length})`,
						});
						continue;
					}

					const ffArgs = ["ffmpeg", "-y", "-i", job.inputPath, "-map", `0:${stream.index}`, "-vn", "-sn", "-dn", "-c:a", "flac"];

					if (delaySec < 0) {
						ffArgs.push("-af", `atrim=start=${Math.abs(delaySec)}`);
					} else if (delaySec > 0) {
						ffArgs.push("-af", `adelay=${delayMs}:all=1`);
					}

					ffArgs.push(flacFile);

					const ffRes = await run(ffArgs, { signal: stageSignal });
					if (ffRes.code !== 0) {
						throw new Error(`FFmpeg audio extraction failed for stream ${i}: ${ffRes.stderr || ffRes.stdout}`);
					}

					audioJobs.push({ index: i, flacFile, opusFile, bitrate, copy: false });

					setStep(S_AUDIO, {
						progress: 5 + Math.round(((i + 1) / audioStreams.length) * 35),
						detail: `Extracting audio (${i + 1}/${audioStreams.length})`,
					});
				}

				setStep(S_AUDIO, { progress: 40, detail: `Encoding ${audioJobs.length} audio stream(s)` });

				const concurrency = Math.max(1, Math.min(audioJobs.length, cpus().length));
				let nextJob = 0;
				let completed = 0;
				let failed = false;

				const encodeWorker = async (): Promise<void> => {
					while (!failed) {
						const jobIdx = nextJob++;
						if (jobIdx >= audioJobs.length) return;

						try {
							checkCancelled();

							const aj = audioJobs[jobIdx]!;

							if (aj.copy) {
								completed++;
								setStep(S_AUDIO, {
									progress: 40 + Math.round((completed / audioJobs.length) * 60),
									detail: `Encoding audio (${completed}/${audioJobs.length})`,
								});
								continue;
							}

							const opusArgs = ["opusenc", "--bitrate", String(aj.bitrate)];
							if (job.settings.noPhaseInv) {
								opusArgs.push("--no-phase-inv");
							}
							opusArgs.push("--discard-comments");
							opusArgs.push("--discard-pictures");
							opusArgs.push(aj.flacFile, aj.opusFile);

							const opusRes = await run(opusArgs, { signal: stageSignal });
							if (opusRes.code !== 0) {
								throw new Error(`Audio encoding failed for stream ${aj.index}: ${opusRes.stderr || opusRes.stdout}`);
							}

							completed++;
							setStep(S_AUDIO, {
								progress: 40 + Math.round((completed / audioJobs.length) * 60),
								detail: `Encoding audio (${completed}/${audioJobs.length})`,
							});
						} catch (err) {
							failed = true;
							throw err;
						}
					}
				};

				await Promise.all(Array.from({ length: concurrency }, () => encodeWorker()));

				setStep(S_AUDIO, { status: "done", progress: 100 });
			}
		};

		const doSubtitleAnalysis = async (): Promise<void> => {
			if (skipSubtitleProcessing) return;

			checkCancelled();
			setStep(S_SUBS, { status: "active", progress: 0, detail: "Analyzing subtitle tracks" });

			try {
				if (opts.precomputed) {
					// Preview: reuse the whole-source subtitle selection.
					subtitleStreams = opts.precomputed.subtitleStreams;
				} else {
					const allSubtitleStreams = filterIgnoredTracks(probe.subtitleStreams || [], DEFAULT_IGNORE_KEYWORD, "subtitle");
					await analyzeSubtitleStreams(
						allSubtitleStreams,
						job.inputPath,
						tempDir,
						{
							langDetect: job.settings.subtitleLangDetect,
							langDetectConfidence: job.settings.subtitleLangDetectConfidence,
							detectSignsSongs: job.settings.detectSignsSongs,
							detectSDH: job.settings.detectSDH,
							detectHonorifics: job.settings.detectHonorifics,
							signsSongsStyleRatio: job.settings.signsSongsStyleRatio,
							signsSongsLineRatio: job.settings.signsSongsLineRatio,
							sdhRatioThreshold: job.settings.sdhRatioThreshold,
							sdhMinLines: job.settings.sdhMinLines,
							honorificsMinCount: job.settings.honorificsMinCount,
							honorificsRatio: job.settings.honorificsRatio,
							assumeMislabeled: job.settings.assumeMislabeledTracks,
						},
						stageSignal,
					);

					const sortedSubtitleStreams = sortSubtitleStreams(allSubtitleStreams, {
						sourcePriority: job.settings.subtitleSourcePriority,
						fansubTiebreak: job.settings.subtitleFansubTiebreak,
						formatPriority: job.settings.subtitleFormatPriority,
						languagePriority: job.settings.subtitleLanguagePriority,
					});

					const allowedSubLangs = job.settings.subtitleLanguages || [];
					const langFilteredSubs = filterStreamsByLanguage(sortedSubtitleStreams, allowedSubLangs, "subtitle");
					const skippedSubLang = sortedSubtitleStreams.length - langFilteredSubs.length;
					if (skippedSubLang > 0) {
						Logger.info(`[subtitle] Filtered ${skippedSubLang} track(s) not in [${allowedSubLangs.join(", ")}]`);
					}

					const typeFilteredSubs = filterSubtitleTypes(langFilteredSubs, {
						removeSDH: job.settings.removeSDHSubtitles,
						removeCommentary: job.settings.removeCommentarySubtitles,
						removeForcedSignsSongs: job.settings.removeForcedSignsSongs,
						removeStoryboard: job.settings.removeStoryboardSubtitles,
						removeHonorifics: job.settings.removeHonorificsSubtitles,
						dropPicture: job.settings.dropPictureSubtitles,
					});
					const droppedByTypeSubs = langFilteredSubs.length - typeFilteredSubs.length;
					if (droppedByTypeSubs > 0) {
						Logger.info(`[subtitle] Dropped ${droppedByTypeSubs} track(s) by type/format filters`);
					}

					subtitleStreams = job.settings.dedupeSubtitles
						? deduplicateSubtitleStreams(typeFilteredSubs, { acrossFormat: job.settings.dedupeAcrossFormat })
						: typeFilteredSubs;

					if (job.settings.dedupeSubtitles && typeFilteredSubs.length !== subtitleStreams.length) {
						Logger.info(`[subtitle] Deduplicated ${typeFilteredSubs.length - subtitleStreams.length} redundant track(s)`);
					}
				}

				setStep(S_SUBS, {
					progress: 10,
					detail: subtitleStreams.length ? `Selected ${subtitleStreams.length} subtitle track(s)` : "No subtitle streams",
				});
			} catch (err) {
				setStep(S_SUBS, { status: "error", progress: 100 });
				throw err;
			}
		};

		const doTranslate = async (): Promise<void> => {
			checkCancelled();
			setStep(S_TRANSLATE, { status: "active", progress: 0 });
			if (!skipSubtitleProcessing && job.settings.translateSubtitles && !previewMode && subtitleStreams.length > 0) {
				try {
					translatedTracks = await runTranslateStep({
						subtitleStreams,
						inputPath: job.inputPath,
						tempDir,
						settings: job.settings,
						subtitleStyle: { ...DEFAULT_STYLE_APPEARANCE, fontName: job.settings.fontGroup },
						organization: config.organization,
						signal: stageSignal,
						onProgress: ({ done, total }) => {
							const overall = total > 0 ? Math.round((done / total) * 100) : 0;
							setStep(S_TRANSLATE, { progress: overall, detail: `Translating ${done}/${total} lines` });
						},
					});
					setStep(S_TRANSLATE, {
						status: "done",
						progress: 100,
						detail: translatedTracks.length ? `Added ${translatedTracks.length} track(s)` : "Nothing to translate",
					});
				} catch (err) {
					setStep(S_TRANSLATE, { status: "error", progress: 100 });
					throw err;
				}
			} else {
				setStep(S_TRANSLATE, { status: "done", progress: 100, detail: "Skipped" });
			}
		};

		const updateSubtitlePrepSummary = (): void => {
			if (skipSubtitleProcessing) return;

			const readyFiles = [...plannedSubs.map((planned) => planned.subFile), ...translatedTracks.map((track) => track.file)].filter((file) => existsSync(file));
			const compressedCount = readyFiles.reduce((count, file) => count + (zlibDecisions.get(file) ? 1 : 0), 0);

			setStep(S_SUBS, {
				status: "done",
				progress: 100,
				detail: job.settings.compressSubtitles ? `${compressedCount} of ${readyFiles.length} track(s) compressed` : `${readyFiles.length} track(s) ready`,
			});
		};

		const doSubtitlePrep = async (): Promise<void> => {
			checkCancelled();
			setStep(S_SUBS, { status: "active", progress: Math.max(steps[S_SUBS]!.progress, 10), detail: "Planning subtitle tracks" });

			if (skipSubtitleProcessing) {
				setStep(S_SUBS, { status: "done", progress: 100, detail: "Skipped — subtitles copied from source" });
				return;
			}
			if (subtitleStreams.length === 0) {
				Logger.info("[subtitle] No subtitle streams found");
				setStep(S_SUBS, { status: "done", progress: 100, detail: "No subtitle streams" });
				return;
			}

			try {
				const subSortedTypes = subtitleStreams.map((stream) => `${stream.language || "und"}:${detectSubtitleTrackType(stream)}`);
				Logger.info(`[subtitle] Track order: ${subSortedTypes.join(", ")}`);

				const subForcedAssigned = new Set<string>();
				const subDefaultIndexByLang = computeSubtitleDefaultIndexByLang(subtitleStreams);

				for (const stream of subtitleStreams) {
					const trackType = detectSubtitleTrackType(stream);
					const lang = stream.language || "und";
					const langGroup = normalizeLanguageGroup(lang);
					const trackName = job.settings.renameSubtitleTracks
						? buildSubtitleTrackName(trackType, stream.title)
						: stream.title || buildSubtitleTrackName(trackType, stream.title);

					let effectiveLang = lang;
					if (trackType === "honorifics") {
						effectiveLang = "en-JP";
					}

					const flagArgs: string[] = [];
					const isDefault = subDefaultIndexByLang.get(langGroup) === stream.index;

					switch (trackType) {
						case "full": {
							flagArgs.push("--default-track-flag", `0:${isDefault ? "1" : "0"}`);
							flagArgs.push("--forced-display-flag", "0:0");
							flagArgs.push("--hearing-impaired-flag", "0:0");
							flagArgs.push("--commentary-flag", "0:0");
							flagArgs.push("--original-flag", `0:${stream.isOriginal ? "1" : "0"}`);
							break;
						}
						case "forced": {
							if (subForcedAssigned.has(langGroup)) {
								Logger.warn(`[subtitle] Duplicate forced track for ${lang}, skipping index ${stream.index}`);
								continue;
							}
							subForcedAssigned.add(langGroup);
							flagArgs.push("--default-track-flag", "0:0");
							flagArgs.push("--forced-display-flag", "0:1");
							flagArgs.push("--hearing-impaired-flag", "0:0");
							flagArgs.push("--commentary-flag", "0:0");
							flagArgs.push("--original-flag", `0:${stream.isOriginal ? "1" : "0"}`);
							break;
						}
						case "honorifics": {
							flagArgs.push("--default-track-flag", "0:1");
							flagArgs.push("--forced-display-flag", "0:0");
							flagArgs.push("--hearing-impaired-flag", "0:0");
							flagArgs.push("--commentary-flag", "0:0");
							flagArgs.push("--original-flag", `0:${stream.isOriginal ? "1" : "0"}`);
							break;
						}
						case "sdh": {
							flagArgs.push("--default-track-flag", `0:${isDefault ? "1" : "0"}`);
							flagArgs.push("--forced-display-flag", "0:0");
							flagArgs.push("--hearing-impaired-flag", "0:1");
							flagArgs.push("--commentary-flag", "0:0");
							flagArgs.push("--original-flag", `0:${stream.isOriginal ? "1" : "0"}`);
							break;
						}
						case "commentary": {
							flagArgs.push("--default-track-flag", "0:0");
							flagArgs.push("--forced-display-flag", "0:0");
							flagArgs.push("--hearing-impaired-flag", "0:0");
							flagArgs.push("--commentary-flag", "0:1");
							flagArgs.push("--original-flag", `0:${stream.isOriginal ? "1" : "0"}`);
							break;
						}
					}

					plannedSubs.push({
						stream,
						subFile: join(tempDir, `sub_${stream.index}.mkv`),
						effectiveLang,
						trackName,
						trackType,
						flagArgs,
					});
				}

				setStep(S_SUBS, { progress: 15, detail: `Planned ${plannedSubs.length} subtitle track(s)` });

				if (plannedSubs.length > 0) {
					checkCancelled();
					setStep(S_SUBS, { progress: 20, detail: `Extracting ${plannedSubs.length} subtitle track(s)` });

					const extractArgs: string[] = ["ffmpeg", "-y", "-i", job.inputPath];
					for (const planned of plannedSubs) {
						extractArgs.push("-map", `0:${planned.stream.index}`, "-c:s", "copy", "-vn", "-an", "-map_chapters", "-1", "-map_metadata", "-1", planned.subFile);
					}

					const extractRes = await run(extractArgs, { signal: stageSignal });
					checkCancelled();

					if (extractRes.code !== 0) {
						// One bad track fails the whole batch. Fall back to per-track
						// extraction so every other valid track can still be kept.
						Logger.warn(`[subtitle] Single-pass extraction failed, falling back to per-track: ${extractRes.stderr || extractRes.stdout}`);
						for (let i = 0; i < plannedSubs.length; i++) {
							checkCancelled();
							const planned = plannedSubs[i]!;
							const res = await run(
								[
									"ffmpeg",
									"-y",
									"-i",
									job.inputPath,
									"-map",
									`0:${planned.stream.index}`,
									"-c:s",
									"copy",
									"-vn",
									"-an",
									"-map_chapters",
									"-1",
									"-map_metadata",
									"-1",
									planned.subFile,
								],
								{ signal: stageSignal },
							);
							if (res.code !== 0) {
								Logger.warn(`[subtitle] Failed to extract track ${planned.stream.index}, skipping: ${res.stderr || res.stdout}`);
							}
							setStep(S_SUBS, {
								progress: 20 + Math.round(((i + 1) / plannedSubs.length) * 40),
								detail: `Extracting subtitles (${i + 1}/${plannedSubs.length})`,
							});
						}
					}

					setStep(S_SUBS, { progress: 60, detail: `Extracted ${plannedSubs.length} subtitle track(s)` });
				}

				// Subtitle styling - SRT->ASS conversion and/or ASS dialogue-font restyle.
				if (job.settings.convertSrtToAss || job.settings.restyleAssFont || job.settings.removeUnusedFonts) {
					setStep(S_SUBS, { progress: 65, detail: "Preparing subtitle styles and fonts" });

					const targets = new Set(job.settings.assRestyleTargets);
					const probeFamily = "__RabbitEncoderInjectedFontProbe_4F3A8B__";
					const probeFamilyNormalized = normalizeFontName(probeFamily);

					interface PreparedAss {
						rawPath: string;
						rawText: string;
						kind: "converted-srt" | "ass";
						restyle: boolean;
					}

					const preparedAss = new Map<number, PreparedAss>();

					// Pass 1: materialize every subtitle we may need to inspect as ASS.
					// No injected family is chosen yet.
					for (const planned of plannedSubs) {
						if (!existsSync(planned.subFile)) continue;
						const codec = planned.stream.codec.toLowerCase();
						const isSrt = codec === "subrip" || codec === "srt";
						const isAss = codec === "ass" || codec === "ssa";

						if (job.settings.convertSrtToAss && isSrt) {
							const rawPath = join(tempDir, `sub_${planned.stream.index}.conv.ass`);
							const result = await run(["ffmpeg", "-y", "-i", planned.subFile, "-map", "0:s:0", "-c:s", "ass", rawPath], {
								signal: stageSignal,
							});
							if (result.code === 0 && existsSync(rawPath)) {
								preparedAss.set(planned.stream.index, {
									rawPath,
									rawText: readFileSync(rawPath, "utf-8"),
									kind: "converted-srt",
									restyle: true,
								});
							} else {
								Logger.warn(`[subtitle] SRT→ASS conversion failed for track ${planned.stream.index}; keeping original`);
							}
						} else if (isAss) {
							const rawPath = join(tempDir, `sub_${planned.stream.index}.raw.ass`);
							const materialized = await materializeAssForInspection(job.inputPath, planned.stream.index, planned.subFile, rawPath, stageSignal);
							if (materialized.ok) {
								preparedAss.set(planned.stream.index, {
									rawPath,
									rawText: readFileSync(rawPath, "utf-8"),
									kind: "ass",
									restyle: job.settings.restyleAssFont && targets.has(planned.trackType),
								});
							} else if (materialized.empty) {
								Logger.debug(`[fonts] ASS track ${planned.stream.index} has no subtitle packets; ` + "it contributes no used fonts");
							} else {
								effectiveRemoveUnusedFonts = false;
								Logger.warn(
									`[fonts] Could not inspect ASS track ${planned.stream.index}; ` +
										`preserving all source font attachments for safety (${materialized.detail})`,
								);
							}
						}
					}

					// Pass 2: determine which *source* font families remain referenced after
					// the intended restyle. A private placeholder stands in for Rabbit's
					// injected face, so a restyled dialogue reference is not mistaken for a
					// reason to retain a same-named source attachment. Untouched signs,
					// songs, inline \fn overrides, and non-targeted styles remain visible.
					sourceAttachmentUsedFonts.clear();
					for (const prepared of preparedAss.values()) {
						let probeText = prepared.rawText;
						if (prepared.kind === "converted-srt") {
							probeText = styleSrtAss(prepared.rawText, { ...DEFAULT_STYLE_APPEARANCE, fontName: probeFamily });
						} else if (prepared.restyle) {
							probeText = restyleAssDialogueFont(prepared.rawText, { ...DEFAULT_STYLE_APPEARANCE, fontName: probeFamily }, true);
						}
						for (const font of extractUsedFonts(probeText)) {
							if (font !== probeFamilyNormalized) sourceAttachmentUsedFonts.add(font);
						}
					}

					// Only source fonts which will survive the unused-font pass reserve a
					// family identity. Therefore an unused Noto Sans does not force
					// "Noto Sans 2", while a Noto Sans still used by signs does.
					if (sourceExt === ".mkv" || sourceExt === ".mks") {
						const sourceNames = await scanMkvAttachmentFontNames(job.inputPath, tempDir, sourceAttachmentUsedFonts, effectiveRemoveUnusedFonts, stageSignal);
						if (sourceNames) {
							for (const name of sourceNames) occupiedFontNames.add(name);
						} else {
							effectiveRemoveUnusedFonts = false;
							Logger.warn("[fonts] Source font collision scan failed; preserving source attachments and using best-effort numbering");
						}
					}

					// Pass 3: perform the real transform using the final collision-free
					// family selected from the retained source-font inventory.
					for (const planned of plannedSubs) {
						const prepared = preparedAss.get(planned.stream.index);
						if (!prepared) continue;

						if (prepared.kind === "converted-srt") {
							const { face: baseFace, appearance } = fontRegistry.resolveFaceAndStyle(job.settings.fontGroup, planned.effectiveLang, prepared.rawText);
							const face = await applyAxes(baseFace, appearance);
							const family = face?.family ?? job.settings.fontGroup;
							const outAss = join(tempDir, `sub_${planned.stream.index}.styled.ass`);
							writeFileSync(outAss, styleSrtAss(prepared.rawText, { ...appearance, fontName: family }), "utf-8");
							planned.subFile = outAss;
							if (face) resolvedFaces.set(face.path, face);
							if (!face) Logger.warn(`[fonts] No face for group "${job.settings.fontGroup}" (track ${planned.stream.index})`);
						} else if (prepared.restyle) {
							const { face: baseFace, appearance } = fontRegistry.resolveFaceAndStyle(job.settings.fontGroup, planned.effectiveLang, prepared.rawText);
							const face = await applyAxes(baseFace, appearance);
							const family = face?.family ?? job.settings.fontGroup;
							const outAss = join(tempDir, `sub_${planned.stream.index}.styled.ass`);
							writeFileSync(outAss, restyleAssDialogueFont(prepared.rawText, { ...appearance, fontName: family }, true), "utf-8");
							planned.subFile = outAss;
							if (face) resolvedFaces.set(face.path, face);
						}
					}
				}

				setStep(S_SUBS, { progress: 85, detail: "Subtitle tracks prepared" });

				if (job.settings.compressSubtitles) {
					const minSavings = job.settings.compressSubtitlesMinSavings ?? 10;
					const readyPlannedSubs = plannedSubs.filter((planned) => existsSync(planned.subFile));

					for (let i = 0; i < readyPlannedSubs.length; i++) {
						checkCancelled();
						const planned = readyPlannedSubs[i]!;
						setStep(S_SUBS, {
							progress: 85 + Math.round((i / Math.max(1, readyPlannedSubs.length)) * 15),
							detail: `Probing subtitle compression (${i + 1}/${readyPlannedSubs.length})`,
						});
						zlibDecisions.set(planned.subFile, await zlibWorthIt(planned.subFile, tempDir, minSavings, stageSignal));
					}
				}

				updateSubtitlePrepSummary();
			} catch (err) {
				setStep(S_SUBS, { status: "error", progress: 100 });
				throw err;
			}
		};

		// Translated files do not exist until doTranslate completes, so their
		// compression probes form a tiny trailing step after both parallel jobs.
		const probeTranslatedCompression = async (): Promise<void> => {
			if (skipSubtitleProcessing) return;

			if (job.settings.compressSubtitles && translatedTracks.length > 0) {
				const minSavings = job.settings.compressSubtitlesMinSavings ?? 10;
				for (const track of translatedTracks) {
					checkCancelled();
					if (!existsSync(track.file)) continue;
					zlibDecisions.set(track.file, await zlibWorthIt(track.file, tempDir, minSavings, stageSignal));
				}
			}

			updateSubtitlePrepSummary();
		};

		try {
			if (overlapTranslate) {
				// Source subtitle preparation and translation both depend only
				// on analysis, so they can run together alongside video/audio.
				const subsPipeline = doSubtitleAnalysis().then(async () => {
					await Promise.all([doTranslate(), doSubtitlePrep()]);
					await probeTranslatedCompression();
				});
				await Promise.all([encodeVideo(), doAudio(), subsPipeline]);
			} else {
				// Keep a local LLM off the video encode, while still overlapping
				// source-only subtitle preparation with video and audio.
				await Promise.all([encodeVideo(), doAudio(), doSubtitleAnalysis().then(doSubtitlePrep)]);
				await doTranslate();
				await probeTranslatedCompression();
			}
		} catch (err) {
			stageAbort.abort(err);
			throw err;
		} finally {
			signal?.removeEventListener("abort", onOuterAbort);
		}

		checkCancelled();
		setStep(S_MUX, { status: "active", progress: 0, detail: "Merging MKV" });
		updateJob({ status: "muxing" });

		const shouldDownscale = job.settings.downscale && probe.height > 1080;
		const encodedDims = (await probeVideoDimensions(videoMkv!, signal)) || {
			width: shouldDownscale ? Math.round((probe.width * 1080) / probe.height / 2) * 2 : probe.width,
			height: shouldDownscale ? 1080 : probe.height,
		};

		const firstSortedLayout = audioStreams.length > 0 ? normalizeLayout(audioStreams[0]!.channelLayout, audioStreams[0]!.channels) : probe.audioLayout;
		const audioLabel = getAudioReplacementLabel(firstSortedLayout);
		const resTag = getResolutionTag(encodedDims.width, encodedDims.height);
		const videoCodecTag = skipVideoEncode ? "FFV1" : "AV1";
		const audioCodecTag = skipAudioEncode ? "Source" : audioLabel;
		const outputFilename = `${baseTitle} [${sourceTag}-${resTag}][${audioCodecTag}][${videoCodecTag}]-${config.organization}.mkv`;
		const finalOutput = join(tempDir, "final.mkv");

		const effectiveSourceTag = probe.priorSource ?? releaseGroup;

		const priorSettings = decodePriorSettings(probe.priorRabbitSettings);
		const cumulativeSettings = combineCumulativeSettings(priorSettings, job.settings);
		const settingsCode = encodeSettingsCode(cumulativeSettings);

		const xmlTags = [
			'<?xml version="1.0" encoding="UTF-8"?>',
			"<Tags><Tag>",
			"<Targets><TargetTypeValue>50</TargetTypeValue></Targets>",
			//`<Simple><Name>TITLE</Name><String>${escapeXml(baseTitle)}</String></Simple>`,
			`<Simple><Name>ENCODED_BY</Name><String>${escapeXml(config.organization)}</String></Simple>`,

			"<Simple>",
			"<Name>RABBIT_ENCODER</Name>",
			`<Simple><Name>VERSION</Name><String>v${escapeXml(pkg.version)}</String></Simple>`,
			`<Simple><Name>SETTINGS</Name><String>${escapeXml(settingsCode)}</String></Simple>`,
			"</Simple>",

			"<Simple>",
			"<Name>LANGUAGE_DETECTOR</Name>",
			`<Simple><Name>VERSION</Name><String>${escapeXml(config.languageDetector.version || "unknown")}</String></Simple>`,
			"</Simple>",

			...(effectiveSourceTag ? [`<Simple><Name>SOURCE</Name><String>${escapeXml(effectiveSourceTag)}</String></Simple>`] : []),
			"</Tag></Tags>",
		].join("\n");

		const xmlPath = join(tempDir, "tags.xml");
		await Bun.write(xmlPath, xmlTags);

		setStep(S_MUX, { progress: 5, detail: "Preparing tracks" });

		const mkvArgs = ["mkvmerge", "-o", finalOutput, "--title", baseTitle, "--global-tags", xmlPath, "--no-audio", "--no-subtitles"];

		if (existsSync(timecodesFile) && isTimecodesVFR(timecodesFile)) {
			mkvArgs.push("--timestamps", `0:${timecodesFile}`);
		}

		mkvArgs.push("--language", `0:${sanitizeLanguageTag(probe.videoLanguage, "video")}`);
		mkvArgs.push("--track-name", `0:${config.organization}`);
		mkvArgs.push("--original-flag", `0:${probe.videoOriginalFlag ? "1" : "0"}`);

		if (!encodedDims) {
			Logger.warn("[mux] Could not probe encoded dimensions — leaving display dimensions unset (players will assume square pixels)");
		} else {
			const sar = resolveSourceSar(probe);
			const disp = computeDisplayDimensions(encodedDims.width, encodedDims.height, sar);
			if (!isPlausibleDar(disp.width, disp.height)) {
				Logger.warn(`[mux] Implausible DAR from source SAR ${sar.num}:${sar.den} — falling back to square pixels`);
				mkvArgs.push("--display-dimensions", `0:${encodedDims.width}x${encodedDims.height}`);
			} else {
				mkvArgs.push("--display-dimensions", `0:${disp.width}x${disp.height}`);
				Logger.info(
					`[mux] Display dimensions ${disp.width}x${disp.height} ` + `(coded ${encodedDims.width}x${encodedDims.height}, source SAR ${sar.num}:${sar.den})`,
				);
			}
		}

		mkvArgs.push(videoMkv!);

		if (!skipAudioEncode) {
			// Audio tracks
			const defaultAssigned = new Set<string>();

			for (let i = 0; i < audioStreams.length; i++) {
				const stream = audioStreams[i]!;
				const trackType = detectAudioTrackType(stream, audioDetect);
				const lang = stream.language || "und";
				const langGroup = normalizeLanguageGroup(lang);

				const isDefault = trackType === "main" && !defaultAssigned.has(langGroup);
				if (isDefault) defaultAssigned.add(langGroup);

				if (stream.language) {
					mkvArgs.push("--language", `0:${sanitizeLanguageTag(stream.language, `audio idx ${stream.index}`)}`);
				}

				const audioName = buildAudioTrackName(trackType, stream.title);
				mkvArgs.push("--track-name", `0:${audioName}`);
				mkvArgs.push("--default-track-flag", `0:${isDefault ? "1" : "0"}`);
				mkvArgs.push("--forced-display-flag", "0:0");
				mkvArgs.push("--original-flag", `0:${stream.isOriginal ? "1" : "0"}`);
				if (trackType === "commentary") mkvArgs.push("--commentary-flag", "0:1");
				if (trackType === "descriptive") mkvArgs.push("--visual-impaired-flag", "0:1");

				mkvArgs.push(encodedAudioFiles[i]!);
			}
		}

		if (!skipSubtitleProcessing) {
			if (subtitleStreams.length > 0) {
				const orderedSubs = orderOutputSubtitles(
					plannedSubs.map((planned) => ({
						stream: planned.stream,
						emit: {
							language: planned.effectiveLang,
							trackName: planned.trackName,
							flagArgs: planned.flagArgs,
							file: planned.subFile,
						},
					})),
					translatedTracks.map((track) => ({
						sourceIndex: track.sourceIndex,
						emit: {
							language: track.language,
							trackName: track.trackName,
							flagArgs: track.flagArgs,
							file: track.file,
						},
					})),
					subtitleStreams,
					(streams) =>
						sortSubtitleStreams(streams, {
							sourcePriority: job.settings.subtitleSourcePriority,
							fansubTiebreak: job.settings.subtitleFansubTiebreak,
							formatPriority: job.settings.subtitleFormatPriority,
							languagePriority: job.settings.subtitleLanguagePriority,
						}),
				);

				for (const outputSubtitle of orderedSubs) {
					if (!existsSync(outputSubtitle.file)) {
						Logger.warn(`[subtitle] Output file missing, skipping: ${outputSubtitle.file}`);
						continue;
					}

					mkvArgs.push("--language", `0:${sanitizeLanguageTag(outputSubtitle.language, `sub ${outputSubtitle.language}`)}`);
					mkvArgs.push("--track-name", `0:${outputSubtitle.trackName}`);
					mkvArgs.push(...outputSubtitle.flagArgs);

					if (job.settings.compressSubtitles) {
						// Be explicit in both directions so mkvmerge defaults cannot
						// override the threshold decision made during preparation.
						mkvArgs.push("--compression", zlibDecisions.get(outputSubtitle.file) ? "0:zlib" : "0:none");
					}

					mkvArgs.push(outputSubtitle.file);
				}
			} else {
				Logger.info("[subtitle] No subtitle streams found");
			}
		} else {
			Logger.info("[subtitle] subtitleProcessing=copy — including source subs verbatim via mkvmerge passthrough");
		}

		for (const face of resolvedFaces.values()) {
			mkvArgs.push("--attachment-mime-type", face.mime, "--attachment-name", face.fileName, "--attach-file", face.path);
			Logger.info(`[fonts] Injecting ${face.fileName} (${face.family})`);
		}

		if (sourceExt === ".mkv" || sourceExt === ".mks") {
			const safeSourceLink = join(tempDir, `source_ref${sourceExt}`);
			try {
				unlinkSync(safeSourceLink);
			} catch {}
			symlinkSync(job.inputPath, safeSourceLink);

			const refFlags = ["--no-video", "--no-global-tags", "--no-track-tags"];
			if (!skipAudioEncode) refFlags.push("--no-audio");
			if (!skipSubtitleProcessing) refFlags.push("--no-subtitles");

			let attachmentsHandled = false;
			const shouldRewriteAttachments = !skipSubtitleProcessing && effectiveRemoveUnusedFonts;
			if (shouldRewriteAttachments) {
				const keptArgs = await buildKeptAttachmentArgs(safeSourceLink, sourceAttachmentUsedFonts, tempDir, effectiveRemoveUnusedFonts, signal);
				if (keptArgs !== null) {
					mkvArgs.push(...keptArgs);
					refFlags.push("--no-attachments");
					attachmentsHandled = true;
					const kept = keptArgs.filter((a) => a === "--attach-file").length;
					Logger.info(`[fonts] Re-attached ${kept} used attachment(s) from source; dropped the rest`);
				}
			}

			mkvArgs.push(...refFlags, safeSourceLink);

			const passes: string[] = ["chapters"];
			if (!attachmentsHandled) passes.push("fonts");
			if (skipAudioEncode) passes.push("audio");
			if (skipSubtitleProcessing) passes.push("subtitles");
			Logger.info(`[mux] Passthrough from source: ${passes.join(", ")}`);
		} else if (skipAudioEncode || skipSubtitleProcessing) {
			// mkvmerge can't reliably demux every container we accept as input
			// (flv/ts in particular), so route the requested streams through an
			// ffmpeg stream-copy into small intermediate MKVs first, then let
			// mkvmerge pull tracks from those the same way it would for a native
			// MKV source. Audio and subtitles are remuxed independently so an
			// unsupported subtitle codec (example mp4's mov_text has no Matroska
			// CodecID) can't also take audio passthrough down with it.
			const passes: string[] = [];

			if (skipAudioEncode) {
				const audioRef = join(tempDir, "source_ref_audio.mkv");
				const remuxRes = await run(
					["ffmpeg", "-y", "-i", job.inputPath, "-map", "0:a?", "-map_metadata", "-1", "-map_chapters", "-1", "-c", "copy", audioRef],
					{ signal: stageSignal },
				);
				if (remuxRes.code === 0 && existsSync(audioRef)) {
					mkvArgs.push("--no-video", "--no-subtitles", "--no-chapters", "--no-global-tags", "--no-track-tags", audioRef);
					passes.push("audio");
				} else {
					Logger.warn(`[mux] Could not copy audio from ${sourceExt} source: ${remuxRes.stderr || remuxRes.stdout}`);
				}
			}

			if (skipSubtitleProcessing) {
				const subsRef = join(tempDir, "source_ref_subs.mkv");
				const remuxRes = await run(["ffmpeg", "-y", "-i", job.inputPath, "-map", "0:s?", "-map_metadata", "-1", "-map_chapters", "-1", "-c", "copy", subsRef], {
					signal: stageSignal,
				});
				if (remuxRes.code === 0 && existsSync(subsRef)) {
					mkvArgs.push("--no-video", "--no-audio", "--no-chapters", "--no-global-tags", "--no-track-tags", subsRef);
					passes.push("subtitles");
				} else {
					Logger.warn(
						`[mux] Could not copy subtitles from ${sourceExt} source (subtitle codec may be unsupported by Matroska): ` +
							`${remuxRes.stderr || remuxRes.stdout}`,
					);
				}
			}

			if (passes.length > 0) {
				Logger.info(`[mux] Passthrough from ${sourceExt} source via ffmpeg remux: ${passes.join(", ")}`);
			}
		}

		setStep(S_MUX, { progress: 50, detail: `Merging MKV` });

		const mergeRes = await run(mkvArgs, { signal });
		if (mergeRes.code !== 0 && mergeRes.code !== 1) {
			throw new Error(`mkvmerge failed: ${mergeRes.stderr || mergeRes.stdout}`);
		}

		setStep(S_MUX, { progress: 75, detail: "Applying color metadata" });
		await applyColorMetadata(finalOutput, probe, signal);

		if (previewMode && sink) {
			const encodedClip = join(sink.dir, "encoded.mkv");
			const cp = await run(["cp", finalOutput, encodedClip], { signal });
			if (cp.code !== 0) throw new Error(`Preview clip copy failed: ${cp.stderr || cp.stdout}`);
			await sink.capture(encodedClip, "encode.png", burnModeForFirstSub(opts.precomputed?.subtitleStreams ?? probe.subtitleStreams));
			setStep(S_MUX, { status: "done", progress: 100 });
			try {
				rmSync(tempDir, { recursive: true, force: true });
			} catch {}
			return;
		}

		setStep(S_MUX, { progress: 85, detail: "Moving to output" });

		let outputPath: string;

		if (job.replaceSource) {
			const sourceDir = dirname(job.inputPath);
			outputPath = resolveUniqueOutputPath(sourceDir, outputFilename, job.inputPath);

			const moveRes = await run(["mv", finalOutput, outputPath], { signal });
			if (moveRes.code !== 0) {
				await run(["cp", finalOutput, outputPath], { signal });
				unlinkSync(finalOutput);
			}

			if (resolve(outputPath) !== resolve(job.inputPath)) {
				cleanupAssociatedFiles(job.inputPath);
				try {
					unlinkSync(job.inputPath);
					Logger.info(`[library] Removed source: ${job.filename}`);
				} catch (err: any) {
					Logger.warn(`[library] Failed to remove source ${job.filename}:`, { "error.message": err?.message });
				}
			}

			Logger.info(`[library] Replaced with: ${basename(outputPath)}`);
		} else {
			const outputSubDir = job.relativePath ? join(config.outputDir, job.relativePath) : config.outputDir;
			mkdirSync(outputSubDir, { recursive: true });
			outputPath = resolveUniqueOutputPath(outputSubDir, outputFilename);

			const moveRes = await run(["mv", finalOutput, outputPath], { signal });
			if (moveRes.code !== 0) {
				await run(["cp", finalOutput, outputPath], { signal });
				unlinkSync(finalOutput);
			}
		}

		const finalName = basename(outputPath);

		setStep(S_MUX, { status: "done", progress: 100 });

		updateJob({
			status: "done",
			currentStage: "Complete",
			progress: 100,
			outputFilename: job.replaceSource ? finalName : job.relativePath ? `${job.relativePath}/${finalName}` : finalName,
			encodedFileSize: humanSize(statSync(outputPath).size),
			finishedAt: Date.now(),
		});

		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {}

		if (!job.replaceSource) {
			try {
				unlinkSync(job.inputPath);
			} catch {}
		}
	} catch (err: any) {
		Logger.error(err?.message);
		const activeIdx = steps.findIndex((s) => s.status === "active");
		if (activeIdx >= 0) steps[activeIdx]!.status = "error";

		if (err instanceof CancelledError) {
			updateJob({
				status: "cancelled",
				currentStage: "Cancelled",
				steps: [...steps],
			});
		} else {
			updateJob({
				status: "error",
				currentStage: "Failed",
				steps: [...steps],
				error: err?.message || String(err),
			});
		}

		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {}

		if (err instanceof CancelledError) throw err;
	}
}
