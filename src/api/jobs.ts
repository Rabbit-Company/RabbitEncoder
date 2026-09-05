import { existsSync, mkdtempSync, rmSync } from "fs";
import { join, dirname, basename } from "path";
import type { Web } from "@rabbit-company/web";
import type { AppConfig, BitrateAnalysisResult, JobSettings } from "../core/types";
import { cancelJob, getAllJobs, getJob, moveJob, removeJob, reorderJobs, retryJob, updateJobSettings } from "../queue/store";
import { probeFile } from "../pipeline/probe";
import { detectSubtitleTrackType, isTextSubtitleCodec, languageToFlag, previewAudio, previewSubtitles } from "../tracks/tracks";
import { decodeSettingsCode, SettingsCodeError } from "../settings/settings-code";
import { sampleBitrateOverTime } from "../video/bitrate-sample";
import { detectSceneCuts, groupSamplesByScene, groupScenesByBitrate, runNoiseSceneAnalysis } from "../video/auto-denoise";

/**
 * Completed bitrate-analysis results, keyed by `${jobId}:${mode}[:${metric}]`.
 * The raw scene/bitrate data for a given (job, mode, metric) never changes -
 * thresholds are applied client-side, so re-opening the modal should just
 * show what was already computed instead of re-running ffmpeg. Cleared when
 * a job is removed; otherwise lives for the server process's lifetime.
 */
const bitrateAnalysisCache = new Map<string, BitrateAnalysisResult>();

function clearBitrateAnalysisCache(jobId: string): void {
	for (const key of bitrateAnalysisCache.keys()) {
		if (key === jobId || key.startsWith(`${jobId}:`)) bitrateAnalysisCache.delete(key);
	}
}

export function registerJobRoutes(app: Web, config: AppConfig): void {
	app.get("/api/jobs", (c) => {
		return c.json(getAllJobs());
	});

	app.get("/api/jobs/:id", (c) => {
		const job = getJob(c.params.id!);
		if (!job) return c.json({ error: "Job not found" }, 404);
		return c.json(job);
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
			const result = previewAudio(audioStreams, job.settings.audioBitrates, {
				languages: job.settings.audioLanguages || [],
				languagePriority: job.settings.audioLanguagePriority,
				collapseChannels: job.settings.keepBestAudioChannelsOnly,
				dedupe: job.settings.dedupeAudio,
				removeCommentary: job.settings.removeCommentaryAudio,
				removeDescriptive: job.settings.removeDescriptiveAudio,
				removeKaraoke: job.settings.removeKaraokeAudio,
				dropCompatibility: job.settings.dropCompatibilityAudio,
				codecPriority: job.settings.audioCodecPriority,
				preferUncensored: job.settings.preferUncensoredAudio,
				renameTracks: job.settings.renameAudioTracks,
				detect: {
					commentary: job.settings.detectCommentaryAudio,
					descriptive: job.settings.detectDescriptiveAudio,
					karaoke: job.settings.detectKaraokeAudio,
				},
			});
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
				const cached = !forceRefresh && bitrateAnalysisCache.get(cacheKey);
				if (cached) return c.json(cached);

				if (!job.outputFilename) return c.json({ error: "Output file not available" }, 400);

				const outPath = job.replaceSource ? join(dirname(job.inputPath), basename(job.outputFilename)) : join(config.outputDir, job.outputFilename);

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
				return c.json(result);
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
