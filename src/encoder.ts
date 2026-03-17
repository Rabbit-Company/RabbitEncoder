import { existsSync, mkdirSync, statSync, unlinkSync, rmSync } from "fs";
import { join, parse as parsePath } from "path";
import type { Job, JobStep, AppConfig, ProbeResult } from "./types";
import { probeFile, getOpusBitrateForLayout, getAudioReplacementLabel, normalizeLayout } from "./probe";
import { Logger } from "./logger";

async function run(cmd: string[], opts?: { cwd?: string }): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(cmd, {
		stdout: "pipe",
		stderr: "pipe",
		cwd: opts?.cwd,
	});
	const stdoutText = await new Response(proc.stdout).text();
	const stderrText = await new Response(proc.stderr).text();
	const code = await proc.exited;
	return { code, stdout: stdoutText.trim(), stderr: stderrText.trim() };
}

function humanSize(bytes: number): string {
	const units = ["B", "KiB", "MiB", "GiB", "TiB"];
	let i = 0;
	let val = bytes;
	while (val >= 1024 && i < units.length - 1) {
		val /= 1024;
		i++;
	}
	return `${val.toFixed(2)} ${units[i]}`;
}

function fmtFrames(current: number, total: number): string {
	return `${current.toLocaleString()} / ${total.toLocaleString()} frames`;
}

function pct2(current: number, total: number): number {
	if (total <= 0) return 0;
	return Math.round((current / total) * 10000) / 100;
}

const S_PROBE = 0;
const S_PREPARE = 1;
const S_FAST = 2;
const S_METRICS = 3;
const S_SCENES = 4;
const S_ZONES = 5;
const S_FINAL = 6;
const S_AUDIO = 7;
const S_MUX = 8;

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
		{ label: "Mux & Finish", status: "pending", progress: 0 },
	];
}

export async function encodeJob(job: Job, config: AppConfig, updateJob: (partial: Partial<Job>) => void): Promise<void> {
	const tempDir = join(config.tempDir, job.id);
	mkdirSync(tempDir, { recursive: true });

	const stem = parsePath(job.filename).name;
	const baseTitle = stem.replace(/\s*[\-–—]*\s*\[.*/, "").trim();

	const steps = makeSteps();

	function setStep(idx: number, partial: Partial<JobStep>) {
		Object.assign(steps[idx]!, partial);
		const overall = steps.reduce((sum, s) => sum + s.progress, 0) / steps.length;
		const activeStep = steps.find((s) => s.status === "active");

		updateJob({
			steps: [...steps],
			progress: Math.round(overall * 100) / 100,
			currentStage: activeStep?.label || job.currentStage,
		});
	}

	try {
		// Probe
		setStep(S_PROBE, { status: "active", progress: 0 });
		updateJob({ status: "probing" });

		const probe = await probeFile(job.inputPath);
		updateJob({ probe });

		setStep(S_PROBE, { status: "done", progress: 100 });

		// Prepare
		setStep(S_PREPARE, { status: "active", progress: 0 });

		const preparedVideo = join(tempDir, "source_video.mkv");
		const extractRes = await run(["ffmpeg", "-y", "-i", job.inputPath, "-map", "0:v:0", "-c:v", "copy", "-an", "-sn", preparedVideo]);

		if (extractRes.code !== 0) {
			throw new Error(`Failed to extract video stream: ${extractRes.stderr}`);
		}

		setStep(S_PREPARE, { status: "done", progress: 100 });

		// ABE (scenes + fast + metrics + zones + final)
		updateJob({ status: "encoding_video" });

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
			"--json-stream",
		];

		const abeProc = Bun.spawn(abeArgs, {
			stdout: "pipe",
			stderr: "pipe",
			cwd: tempDir,
		});

		const abeStageToStep: Record<number, number> = {
			0: S_FAST,
			1: S_METRICS,
			2: S_SCENES,
			3: S_ZONES,
			4: S_FINAL,
		};

		let abeStderr = "";

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
				setStep(si, {
					progress: pct2(evt.current, evt.total),
					detail: evt.total ? fmtFrames(evt.current, evt.total) : undefined,
				});
				return;
			}

			if (evt.event === "stage_complete" && si !== undefined) {
				setStep(si, {
					status: "done",
					progress: 100,
					detail: evt.total_frames ? fmtFrames(evt.total_frames, evt.total_frames) : steps[si]!.detail,
				});
				return;
			}

			if (evt.event === "error") {
				Logger.error("[ABE error]", { message: evt.message });
			}
		};

		const stdoutTask = (async () => {
			if (!abeProc.stdout) return;

			const reader = abeProc.stdout.getReader();
			const decoder = new TextDecoder();
			let buffer = "";

			while (true) {
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
		})();

		const stderrTask = (async () => {
			if (!abeProc.stderr) return;

			const reader = abeProc.stderr.getReader();
			const decoder = new TextDecoder();

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				const chunk = decoder.decode(value, { stream: true });
				abeStderr += chunk;

				if (chunk.trim()) {
					Logger.error("[ABE stderr]", { error: chunk.trimEnd() });
				}
			}

			abeStderr += decoder.decode();
		})();

		const [abeCode] = await Promise.all([abeProc.exited, stdoutTask, stderrTask]);

		if (abeCode !== 0) {
			throw new Error(`Auto-Boost-Essential failed (exit ${abeCode}): ${abeStderr.slice(-500)}`);
		}

		const ivfFile = join(tempDir, "source_video.ivf");
		if (!existsSync(ivfFile)) {
			throw new Error("ABE did not produce output .ivf file");
		}

		const videoMkv = join(tempDir, "video_only.mkv");
		const muxVidRes = await run(["mkvmerge", "-o", videoMkv, ivfFile]);
		if (muxVidRes.code !== 0 && muxVidRes.code !== 1) {
			throw new Error(`mkvmerge video: ${muxVidRes.stderr}`);
		}
		updateJob({ encodedVideoSize: humanSize(statSync(videoMkv).size) });

		// Audio
		setStep(S_AUDIO, { status: "active", progress: 0 });
		updateJob({ status: "encoding_audio" });

		const audioStreams = probe.audioStreams || [];
		const encodedAudioFiles: string[] = [];

		if (audioStreams.length === 0) {
			setStep(S_AUDIO, { status: "done", progress: 100, detail: "No audio streams" });
		} else {
			setStep(S_AUDIO, { progress: 10, detail: `Encoding ${audioStreams.length} audio stream(s)` });

			const delayStr = await run(["mediainfo", "--Inform=Audio;%Delay%", job.inputPath]).then((r) => r.stdout.split(" ")[0] || "0");
			const delayMs = parseFloat(delayStr) || 0;
			const delaySec = delayMs / 1000;

			for (let i = 0; i < audioStreams.length; i++) {
				const stream = audioStreams[i]!;
				const opusFile = join(tempDir, `audio_${i}.opus`);
				encodedAudioFiles.push(opusFile);

				const layout = normalizeLayout(stream.channelLayout);
				const bitrate = getOpusBitrateForLayout(layout, job.settings.audioBitrates);

				const ffArgs = ["ffmpeg", "-i", job.inputPath, "-y", "-map", `0:${stream.index}`, "-vn", "-sn", "-c:a", "flac"];

				if (delaySec < 0) {
					ffArgs.push("-af", `atrim=start=${Math.abs(delaySec)}`);
				} else if (delaySec > 0) {
					ffArgs.push("-af", `adelay=${delayMs}:all=1`);
				}
				ffArgs.push("-f", "flac", "-");

				const opusArgs = [
					"opusenc",
					"--bitrate",
					String(bitrate),
					"--title",
					stream.title || stream.language || `Stream ${i + 1}`,
					"--comment",
					"ORGANIZATION=RabbitCompany",
					"--comment",
					"CONTACT=https://rabbit-company.com",
					"--discard-comments",
					"--discard-pictures",
					"-",
					opusFile,
				];

				const ffProc = Bun.spawn(ffArgs, { stdout: "pipe", stderr: "pipe" });
				const opusProc = Bun.spawn(opusArgs, {
					stdin: ffProc.stdout,
					stdout: "pipe",
					stderr: "pipe",
				});

				const [ffCode, opusCode] = await Promise.all([ffProc.exited, opusProc.exited]);

				if (ffCode !== 0) {
					const ffErr = await new Response(ffProc.stderr).text();
					throw new Error(`FFmpeg audio extraction failed for stream ${i}: ${ffErr}`);
				}
				if (opusCode !== 0) {
					const opusErr = await new Response(opusProc.stderr).text();
					throw new Error(`Audio encoding failed for stream ${i}: ${opusErr}`);
				}

				setStep(S_AUDIO, { progress: 10 + Math.round(((i + 1) / audioStreams.length) * 80) });
			}

			setStep(S_AUDIO, { status: "done", progress: 100 });
		}

		// Mux & Finish
		setStep(S_MUX, { status: "active", progress: 0, detail: "Merging MKV" });
		updateJob({ status: "muxing" });

		const audioLabel = audioStreams.length > 1 ? "Multi Opus" : getAudioReplacementLabel(probe.audioLayout);
		const resTag = probe.width >= 3840 ? "2160p" : probe.height >= 1080 ? "1080p" : "720p";
		const outputFilename = `${baseTitle} - [Bluray-${resTag}][${audioLabel}][AV1]-RabbitCompany.mkv`;
		const finalOutput = join(tempDir, "final.mkv");

		const xmlTags = [
			'<?xml version="1.0" encoding="UTF-8"?>',
			"<Tags><Tag>",
			"<Targets><TargetTypeValue>50</TargetTypeValue></Targets>",
			`<Simple><Name>Title</Name><String>${escapeXml(baseTitle)}</String></Simple>`,
			"<Simple><Name>Organization</Name><String>RabbitCompany</String></Simple>",
			"<Simple><Name>Contact</Name><String>https://rabbit-company.com</String></Simple>",
			`<Simple><Name>Encoder</Name><String>${escapeXml(config.encoderVersion)}</String></Simple>`,
			`<Simple><Name>Encoder Settings</Name><String>Quality ${job.settings.quality}, Speed ${job.settings.finalSpeed}</String></Simple>`,
			`<Simple><Name>Encoded date</Name><String>${new Date().toISOString()}</String></Simple>`,
			"</Tag></Tags>",
		].join("\n");

		const xmlPath = join(tempDir, "tags.xml");
		await Bun.write(xmlPath, xmlTags);

		setStep(S_MUX, { progress: 30, detail: "Merging MKV" });

		const mkvArgs = ["mkvmerge", "-o", finalOutput, "--title", baseTitle, "--global-tags", xmlPath, "--no-audio", "--no-subtitles", videoMkv];

		for (let i = 0; i < audioStreams.length; i++) {
			const stream = audioStreams[i]!;
			if (stream.language) {
				mkvArgs.push("--language", `0:${stream.language}`);
			}
			if (stream.title) {
				mkvArgs.push("--track-name", `0:${stream.title}`);
			}
			mkvArgs.push(encodedAudioFiles[i]!);
		}

		mkvArgs.push("--no-video", "--no-audio", job.inputPath);

		const mergeRes = await run(mkvArgs);
		if (mergeRes.code !== 0 && mergeRes.code !== 1) {
			throw new Error(`mkvmerge failed: ${mergeRes.stderr}`);
		}

		if (probe.isHDR) {
			setStep(S_MUX, { progress: 60, detail: "Applying HDR metadata" });
			await applyHDRMetadata(finalOutput, probe);
		}

		setStep(S_MUX, { progress: 80, detail: "Moving to output" });

		const outputPath = join(config.outputDir, outputFilename);
		const moveRes = await run(["mv", finalOutput, outputPath]);

		if (moveRes.code !== 0) {
			await run(["cp", finalOutput, outputPath]);
			unlinkSync(finalOutput);
		}

		setStep(S_MUX, { status: "done", progress: 100 });

		updateJob({
			status: "done",
			currentStage: "Complete",
			progress: 100,
			outputFilename,
			encodedFileSize: humanSize(statSync(outputPath).size),
			finishedAt: Date.now(),
		});

		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {}

		try {
			unlinkSync(job.inputPath);
		} catch {}
	} catch (err: any) {
		const activeIdx = steps.findIndex((s) => s.status === "active");
		if (activeIdx >= 0) steps[activeIdx]!.status = "error";

		updateJob({
			status: "error",
			currentStage: "Failed",
			steps: [...steps],
			error: err?.message || String(err),
		});

		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	}
}

async function applyHDRMetadata(mkvPath: string, probe: ProbeResult) {
	const cmd: string[] = ["mkvpropedit", mkvPath, "--edit", "track:v1"];
	cmd.push("--set", "colour-transfer-characteristics=16");
	if (probe.colorPrimaries === "BT.2020") cmd.push("--set", "colour-primaries=9");
	if (probe.matrixCoefficients === "BT.2020 non-constant") cmd.push("--set", "color-matrix-coefficients=9");
	if (probe.colorRange === "Limited") cmd.push("--set", "colour-range=1");
	if (/^\d+$/.test(probe.maxCLL) && /^\d+$/.test(probe.maxFALL)) {
		cmd.push("--set", `max-content-light=${probe.maxCLL}`, "--set", `max-frame-light=${probe.maxFALL}`);
	}
	if (probe.masteringDisplay && probe.masteringLuminance) {
		let RX: string, RY: string, GX: string, GY: string, BX: string, BY: string;
		if (probe.masteringDisplay === "Display P3") {
			[RX, RY, GX, GY, BX, BY] = ["0.6800", "0.3200", "0.2650", "0.6900", "0.1500", "0.0600"];
		} else {
			[RX, RY, GX, GY, BX, BY] = ["0.7080", "0.2920", "0.1700", "0.7970", "0.1310", "0.0460"];
		}
		const maxLum = probe.masteringLuminance.match(/max:\s*([0-9.]+)/)?.[1];
		const minLum = probe.masteringLuminance.match(/min:\s*([0-9.]+)/)?.[1];
		if (maxLum && minLum) {
			cmd.push(
				"--set",
				`chromaticity-coordinates-red-x=${RX}`,
				"--set",
				`chromaticity-coordinates-red-y=${RY}`,
				"--set",
				`chromaticity-coordinates-green-x=${GX}`,
				"--set",
				`chromaticity-coordinates-green-y=${GY}`,
				"--set",
				`chromaticity-coordinates-blue-x=${BX}`,
				"--set",
				`chromaticity-coordinates-blue-y=${BY}`,
				"--set",
				"white-coordinates-x=0.3127",
				"--set",
				"white-coordinates-y=0.3290",
				"--set",
				`max-luminance=${maxLum}`,
				"--set",
				`min-luminance=${minLum}`,
			);
		}
	}
	await run(cmd);
}

function escapeXml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
