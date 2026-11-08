import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "fs";
import { join, dirname, basename } from "path";
import type { Web } from "@rabbit-company/web";
import {
	FILM_GRAIN_RANGES,
	FILM_GRAIN_SAMPLINGS,
	type AppConfig,
	type BitrateAnalysisResult,
	type EncodeMetric,
	type Job,
	type FilmGrainRange,
	type FilmGrainSampling,
	type JobLiveView,
	type JobSettings,
} from "../core/types";
import {
	cancelFilmGrainRun,
	cancelJob,
	getAllJobs,
	getFilmGrainRun,
	getJob,
	moveJob,
	removeJob,
	reorderJobs,
	retryJob,
	startFilmGrainRun,
	updateJobSettings,
} from "../queue/store";
import { probeFile } from "../pipeline/probe";
import { previewAudio } from "../audio/audio-step";
import { detectSubtitleTrackType, isTextSubtitleCodec, languageToFlag, previewSubtitles } from "../tracks/tracks";
import { decodeSettingsCode, SettingsCodeError } from "../settings/settings-code";
import { sampleBitrateOverTime } from "../video/bitrate-sample";
import { detectSceneCuts, groupSamplesByScene, groupScenesByBitrate, runNoiseSceneAnalysis } from "../video/auto-denoise";
import { resolveAllowedMediaFile } from "./repair";
import { getTelemetry } from "../pipeline/telemetry";
import { cancelEncodeMeasurement, getEncodeMeasurement, startEncodeMeasurement } from "../pipeline/encode-measure";

/**
 * Completed bitrate-analysis results, keyed by `${jobId}:${mode}[:${metric}]`.
 * The raw scene/bitrate data for a given (job, mode, metric) never changes -
 * thresholds are applied client-side, so re-opening the modal should just
 * show what was already computed instead of re-running ffmpeg. Cleared when
 * a job is removed; otherwise lives for the server process's lifetime.
 */
const bitrateAnalysisCache = new Map<string, BitrateAnalysisResult>();

const ENCODE_METRICS: EncodeMetric[] = ["ssimulacra2", "xpsnr", "vmaf"];

function encodedOutputPath(job: Job, config: AppConfig): string | null {
	if (!job.outputFilename) return null;
	return job.replaceSource ? join(dirname(job.inputPath), basename(job.outputFilename)) : join(config.outputDir, job.outputFilename);
}

/** The source is still there and is not the encode itself, which a job that replaces its source can leave. */
function measurableSource(job: Job, outPath: string | null): boolean {
	if (!outPath || !existsSync(outPath) || !existsSync(job.inputPath)) return false;
	try {
		return realpathSync(job.inputPath) !== realpathSync(outPath);
	} catch {
		return false;
	}
}

/** Scene CRFs, the measurement and whether the encode can be measured change after the bitrate is cached, so they are added fresh. */
function withEncodeData(job: Job, result: BitrateAnalysisResult, outPath: string): BitrateAnalysisResult {
	return {
		...result,
		telemetry: getTelemetry(job.id),
		measurement: getEncodeMeasurement(job.id),
		canMeasure: measurableSource(job, outPath),
	};
}

function clearBitrateAnalysisCache(jobId: string): void {
	for (const key of bitrateAnalysisCache.keys()) {
		if (key === jobId || key.startsWith(`${jobId}:`)) bitrateAnalysisCache.delete(key);
	}
}

export function registerJobRoutes(app: Web, config: AppConfig): void {
	app.post("/api/jobs/:id/film-grain-table", async (c) => {
		const job = getJob(c.params.id!);
		if (!job) return c.json({ error: "Job not found" }, 404);
		if (!existsSync(job.inputPath)) return c.json({ error: "Job input is no longer accessible" }, 400);
		let body: { sourcePath?: unknown; noiseSampling?: unknown; range?: unknown; justEnough?: unknown };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Choose an original source video" }, 400);
		}
		const sampling = body.noiseSampling ?? job.settings.filmGrainSampling ?? "all";
		if (!FILM_GRAIN_SAMPLINGS.includes(sampling as FilmGrainSampling)) return c.json({ error: "Noise sampling must be all, half, quarter, or eighth" }, 400);
		const range = body.range ?? job.settings.filmGrainRange ?? "full";
		if (!FILM_GRAIN_RANGES.includes(range as FilmGrainRange)) return c.json({ error: "Measurement range must be representative or full" }, 400);
		const justEnough = body.justEnough ?? job.settings.filmGrainJustEnough ?? false;
		if (typeof justEnough !== "boolean") return c.json({ error: "justEnough must be a boolean" }, 400);
		let sourcePath: string;
		try {
			sourcePath = resolveAllowedMediaFile(body.sourcePath, config, "Original source");
		} catch (err) {
			return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
		}
		const result = startFilmGrainRun(job.id, sourcePath, sampling as FilmGrainSampling, range as FilmGrainRange, justEnough);
		if (!result.ok) return c.json({ error: result.error }, result.status);
		return c.json(result.run, 202);
	});

	app.get("/api/jobs/:id/film-grain-table", (c) => {
		return c.json(getFilmGrainRun(c.params.id!) ?? { status: "idle" });
	});

	app.delete("/api/jobs/:id/film-grain-table", (c) => {
		if (!cancelFilmGrainRun(c.params.id!)) return c.json({ error: "No film grain table is being generated for this job" }, 404);
		return c.json({ ok: true });
	});

	app.get("/api/jobs", (c) => {
		return c.json(getAllJobs());
	});

	app.get("/api/jobs/:id", (c) => {
		const job = getJob(c.params.id!);
		if (!job) return c.json({ error: "Job not found" }, 404);
		return c.json(job);
	});

	// The live view polls this while it is open. Telemetry is sent only when it changed since `version`.
	app.get("/api/jobs/:id/live", (c) => {
		const job = getJob(c.params.id!);
		if (!job) return c.json({ error: "Job not found" }, 404);
		const telemetry = getTelemetry(job.id);
		const known = Number(c.query().get("version") ?? 0);
		const view: JobLiveView = {
			filename: job.filename,
			status: job.status,
			progress: job.progress,
			currentStage: job.currentStage,
			steps: job.steps,
			startedAt: job.startedAt,
			finishedAt: job.finishedAt,
			estimatedFinalSize: job.estimatedFinalSize,
			encodedFileSize: job.encodedFileSize,
			error: job.error,
			telemetry: telemetry && telemetry.version !== known ? telemetry : null,
			telemetryVersion: telemetry?.version ?? 0,
		};
		return c.json(view);
	});

	app.patch("/api/jobs/:id", async (c) => {
		const body = (await c.req.json()) as Partial<JobSettings>;
		const job = updateJobSettings(c.params.id!, body);
		if (!job) return c.json({ error: "Job not found or not editable" }, 400);
		return c.json(job);
	});

	app.delete("/api/jobs/:id", (c) => {
		const ok = removeJob(c.params.id!);
		if (!ok) return c.json({ error: "Cannot remove active job" }, 400);
		clearBitrateAnalysisCache(c.params.id!);
		return c.json({ ok: true });
	});

	app.post("/api/jobs/:id/retry", (c) => {
		const job = retryJob(c.params.id!);
		if (!job) return c.json({ error: "Job not found or not retryable" }, 400);
		return c.json(job);
	});

	app.post("/api/jobs/:id/cancel", (c) => {
		const ok = cancelJob(c.params.id!);
		if (!ok) return c.json({ error: "Job not found or not currently encoding" }, 400);
		return c.json({ ok: true });
	});

	app.get("/api/jobs/:id/subtitle-preview", async (c) => {
		const job = getJob(c.params.id!);
		if (!job) return c.json({ error: "Job not found" }, 404);

		if (!existsSync(job.inputPath)) {
			return c.json({ error: "Source file no longer accessible" }, 400);
		}

		let probe = job.probe;
		if (!job.probe) {
			probe = await probeFile(job.inputPath);
		}

		const subtitleStreams = probe!.subtitleStreams || [];
		if (subtitleStreams.length === 0) {
			return c.json({ source: [], output: [] });
		}

		try {
			const tempDir = mkdtempSync(join(config.tempDir, "sub-preview-"));

			const result = await previewSubtitles(job.inputPath, subtitleStreams, tempDir, {
				dedupe: job.settings.dedupeSubtitles,
				languages: job.settings.subtitleLanguages || [],
				langDetect: job.settings.subtitleLangDetect,
				langDetectConfidence: job.settings.subtitleLangDetectConfidence,
				detectSignsSongs: job.settings.detectSignsSongs,
				detectSDH: job.settings.detectSDH,
				detectHonorifics: job.settings.detectHonorifics,
				// Source / format ordering
				sourcePriority: job.settings.subtitleSourcePriority,
				fansubTiebreak: job.settings.subtitleFansubTiebreak,
				formatPriority: job.settings.subtitleFormatPriority,
				// Drop filters
				dropPicture: job.settings.dropPictureSubtitles,
				removeSDH: job.settings.removeSDHSubtitles,
				removeCommentary: job.settings.removeCommentarySubtitles,
				removeForcedSignsSongs: job.settings.removeForcedSignsSongs,
				removeStoryboard: job.settings.removeStoryboardSubtitles,
				removeHonorifics: job.settings.removeHonorificsSubtitles,
				// Dedupe + naming
				dedupeAcrossFormat: job.settings.dedupeAcrossFormat,
				renameTracks: job.settings.renameSubtitleTracks,
				// Advanced detection tuning
				signsSongsStyleRatio: job.settings.signsSongsStyleRatio,
				signsSongsLineRatio: job.settings.signsSongsLineRatio,
				sdhRatioThreshold: job.settings.sdhRatioThreshold,
				sdhMinLines: job.settings.sdhMinLines,
				honorificsMinCount: job.settings.honorificsMinCount,
				honorificsRatio: job.settings.honorificsRatio,
				assumeMislabeled: job.settings.assumeMislabeledTracks,

				languagePriority: job.settings.subtitleLanguagePriority,
				translate: {
					enabled: !!job.settings.translateSubtitles,
					targetLanguages: job.settings.translateTargetLanguages || [],
					convertSrtToAss: job.settings.convertSrtToAss,
					organization: config.organization,
				},
			});

			try {
				rmSync(tempDir, { recursive: true, force: true });
			} catch {}

			return c.json(result);
		} catch (err: any) {
			return c.json({ error: `Preview failed: ${err.message || err}` }, 500);
		}
	});

	app.get("/api/jobs/:id/subtitle-tracks", async (c) => {
		const job = getJob(c.params.id!);
		if (!job) return c.json({ error: "Job not found" }, 404);

		if (!existsSync(job.inputPath)) {
			return c.json({ error: "Source file no longer accessible" }, 400);
		}

		let probe = job.probe;
		if (!probe) {
			probe = await probeFile(job.inputPath);
		}

		const tracks = (probe!.subtitleStreams || []).map((s) => ({
			index: s.index,
			codec: s.codec,
			language: s.language || "und",
			flag: languageToFlag(s.language || "und"),
			title: s.title || "",
			trackType: detectSubtitleTrackType(s),
			isText: isTextSubtitleCodec(s.codec),
		}));

		return c.json({ tracks });
	});

	app.get("/api/jobs/:id/audio-preview", async (c) => {
		const job = getJob(c.params.id!);
		if (!job) return c.json({ error: "Job not found" }, 404);

		if (!existsSync(job.inputPath)) {
			return c.json({ error: "Source file no longer accessible" }, 400);
		}

		let probe = job.probe;
		if (!probe) {
			probe = await probeFile(job.inputPath);
		}

		const audioStreams = probe.audioStreams || [];
		if (audioStreams.length === 0) {
			return c.json({ source: [], output: [] });
		}

		try {
			const result = previewAudio(audioStreams, job.settings);
			return c.json(result);
		} catch (err: any) {
			return c.json({ error: `Preview failed: ${err.message || err}` }, 500);
		}
	});

	app.get("/api/jobs/:id/mediainfo", async (c) => {
		const job = getJob(c.params.id!);
		if (!job) return c.json({ error: "Job not found" }, 404);

		if (!existsSync(job.inputPath)) {
			return c.json({ error: "Source file no longer accessible" }, 400);
		}

		try {
			const proc = Bun.spawn(["mediainfo", job.inputPath], { stdout: "pipe", stderr: "pipe" });
			const text = await new Response(proc.stdout).text();
			await proc.exited;
			return c.json({ filename: job.filename, text: text.trim() });
		} catch (err: any) {
			return c.json({ error: `mediainfo failed: ${err.message || err}` }, 500);
		}
	});

	app.get("/api/jobs/:id/bitrate-analysis", async (c) => {
		const job = getJob(c.params.id!);
		if (!job) return c.json({ error: "Job not found" }, 404);

		const forceRefresh = c.query().get("refresh") === "1";
		const signal = c.req.signal;

		try {
			if (job.status === "done") {
				const cacheKey = `${job.id}:encoded`;
				const outPath = encodedOutputPath(job, config);
				if (!outPath) return c.json({ error: "Output file not available" }, 400);
				const cached = !forceRefresh && bitrateAnalysisCache.get(cacheKey);
				if (cached) return c.json(withEncodeData(job, cached, outPath));

				if (!existsSync(outPath)) return c.json({ error: "Output file no longer accessible" }, 400);

				const probe = await probeFile(outPath);
				const bitrate = await sampleBitrateOverTime(outPath);
				if (signal.aborted) return c.json({ error: "Cancelled" }, 499);

				const result: BitrateAnalysisResult = {
					mode: "encoded",
					durationSec: probe.duration,
					bitrate,
					noise: null,
					appliedPlan: job.autoDenoisePlan ?? null,
				};
				bitrateAnalysisCache.set(cacheKey, result);
				return c.json(withEncodeData(job, result, outPath));
			}

			if (!existsSync(job.inputPath)) {
				return c.json({ error: "Source file no longer accessible" }, 400);
			}

			const metric = job.settings.autoDenoiseMetric;
			const cacheKey = `${job.id}:source:${metric}`;
			const cached = !forceRefresh && bitrateAnalysisCache.get(cacheKey);
			if (cached) return c.json(cached);

			const probe = job.probe ?? (await probeFile(job.inputPath));
			const bitrate = await sampleBitrateOverTime(job.inputPath);

			const tempDir = mkdtempSync(join(config.tempDir, "bitrate-analysis-"));
			let noise: BitrateAnalysisResult["noise"] = null;
			try {
				if (metric === "bitrate") {
					const cuts = await detectSceneCuts(job.inputPath, tempDir, signal);
					if (cuts) {
						noise = { samples: [], scenes: groupScenesByBitrate(bitrate, cuts, probe.duration), cuts };
					}
				} else {
					const raw = await runNoiseSceneAnalysis(job.inputPath, tempDir, probe.duration, signal);
					if (raw) {
						noise = {
							samples: raw.samples.map((s) => ({ t: s.time, y: s.y })),
							scenes: groupSamplesByScene(raw.samples, raw.cuts, probe.duration),
							cuts: raw.cuts,
						};
					}
				}
			} finally {
				try {
					rmSync(tempDir, { recursive: true, force: true });
				} catch {}
			}

			const result: BitrateAnalysisResult = {
				mode: "source",
				durationSec: probe.duration,
				bitrate,
				noise,
				metric,
				thresholds: metric === "bitrate" ? job.settings.autoDenoiseBitrateThresholds : job.settings.autoDenoiseThresholds,
			};
			bitrateAnalysisCache.set(cacheKey, result);
			return c.json(result);
		} catch (err: any) {
			if (err?.name === "CancelledError" || signal.aborted) return c.json({ error: "Cancelled" }, 499);
			return c.json({ error: `Bitrate analysis failed: ${err.message || err}` }, 500);
		}
	});

	app.get("/api/jobs/:id/measure", (c) => {
		const job = getJob(c.params.id!);
		if (!job) return c.json({ error: "Job not found" }, 404);
		return c.json({ measurement: getEncodeMeasurement(job.id) });
	});

	/** Scores the finished encode against its source over the whole video. */
	app.post("/api/jobs/:id/measure", async (c) => {
		const job = getJob(c.params.id!);
		if (!job) return c.json({ error: "Job not found" }, 404);
		try {
			if (job.status !== "done") throw new Error("Only a finished encode can be measured");
			const outPath = encodedOutputPath(job, config);
			if (!outPath || !existsSync(outPath)) throw new Error("The encoded file is no longer there");
			if (!measurableSource(job, outPath)) throw new Error("The source is no longer there to measure the encode against");
			const body = (await c.req.json().catch(() => ({}))) as { interval?: unknown; metrics?: unknown; withGrain?: unknown };
			const interval = body.interval === "frame" ? "frame" : Number(body.interval);
			if (interval !== "frame" && (!Number.isFinite(interval) || interval < 0.1 || interval > 60))
				throw new Error("Measure every frame, or every 0.1 to 60 seconds");
			const metrics = Array.isArray(body.metrics) ? ENCODE_METRICS.filter((m) => (body.metrics as unknown[]).includes(m)) : [];
			if (!metrics.length) throw new Error(`Choose at least one of ${ENCODE_METRICS.join(", ")}`);
			if (body.withGrain !== undefined && typeof body.withGrain !== "boolean") throw new Error("withGrain must be true or false");
			const measurement = startEncodeMeasurement({
				jobId: job.id,
				sourcePath: job.inputPath,
				encodedPath: outPath,
				crop: job.cropRect,
				interval,
				metrics,
				withGrain: body.withGrain ?? true,
			});
			return c.json({ measurement });
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
		}
	});

	app.delete("/api/jobs/:id/measure", (c) =>
		cancelEncodeMeasurement(c.params.id!) ? c.json({ ok: true }) : c.json({ error: "Nothing is being measured" }, 404),
	);

	/** The bitrate over time of any video in the media folders, for the Bitrate Analysis tool. */
	app.get("/api/bitrate-analysis", async (c) => {
		const signal = c.req.signal;
		try {
			const path = resolveAllowedMediaFile(c.query().get("path"), config, "Video");
			const { size, mtimeMs } = statSync(path);
			const cacheKey = `file:${path}:${size}:${mtimeMs}`;
			const cached = c.query().get("refresh") !== "1" && bitrateAnalysisCache.get(cacheKey);
			if (cached) return c.json({ ...cached, filename: basename(path) });

			const probe = await probeFile(path);
			const bitrate = await sampleBitrateOverTime(path);
			if (signal.aborted) return c.json({ error: "Cancelled" }, 499);

			const result: BitrateAnalysisResult = { mode: "file", durationSec: probe.duration, bitrate, noise: null };
			bitrateAnalysisCache.set(cacheKey, result);
			return c.json({ ...result, filename: basename(path) });
		} catch (err: any) {
			if (signal.aborted) return c.json({ error: "Cancelled" }, 499);
			return c.json({ error: `Bitrate analysis failed: ${err.message || err}` }, 400);
		}
	});

	app.post("/api/jobs/:id/move", async (c) => {
		const body = (await c.req.json()) as { direction?: string };
		const direction = body.direction;
		if (!direction || !["up", "down", "top", "bottom"].includes(direction)) {
			return c.json({ error: "Invalid direction. Use: up, down, top, bottom" }, 400);
		}
		const ok = moveJob(c.params.id!, direction as "up" | "down" | "top" | "bottom");
		if (!ok) return c.json({ error: "Job not found, not queued, or already at boundary" }, 400);
		return c.json({ ok: true });
	});

	app.post("/api/jobs/reorder", async (c) => {
		const body = (await c.req.json()) as { ids?: string[] };
		if (!body.ids || !Array.isArray(body.ids)) {
			return c.json({ error: "Missing 'ids' array in request body" }, 400);
		}
		reorderJobs(body.ids);
		return c.json({ ok: true });
	});

	app.post("/api/jobs/:id/import-code", async (c) => {
		const body = (await c.req.json()) as { code?: string };
		if (typeof body.code !== "string") return c.json({ error: "Missing 'code' string" }, 400);
		let partial;
		try {
			partial = decodeSettingsCode(body.code);
		} catch (err) {
			if (err instanceof SettingsCodeError) return c.json({ error: err.message }, 400);
			throw err;
		}
		const job = updateJobSettings(c.params.id!, partial);
		if (!job) return c.json({ error: "Job not found or not editable" }, 400);
		return c.json(job);
	});
}
