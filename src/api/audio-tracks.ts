import type { Web } from "@rabbit-company/web";
import { basename } from "path";
import type { AppConfig } from "../core/types";
import { buildAudioTracksPlan, inspectAudioTracksFile, planAudioTracks, scanAudioTracks, type AudioTrackChoice } from "../pipeline/audio-tracks";
import { mkvFilesIn } from "../pipeline/release-subs";
import { addAudioTracksJob, getAllJobs } from "../queue/store";
import { resolveAllowedDirectory, resolveAllowedMkv } from "./repair";

const MAX_FILES = 500;
const CHOICES: AudioTrackChoice[] = ["auto", "copy", "encode", "remove"];

function resolveTargets(raw: { targets?: unknown; targetDir?: unknown }, config: AppConfig): string[] {
	const targets = Array.isArray(raw.targets)
		? raw.targets.map((path) => resolveAllowedMkv(path, config, "Video"))
		: mkvFilesIn(resolveAllowedDirectory(raw.targetDir, config));
	if (!targets.length) throw new Error("Choose at least one MKV");
	if (targets.length > MAX_FILES) throw new Error(`Audio tracks can be changed in at most ${MAX_FILES} files at once`);
	return [...new Set(targets)];
}

/** A choice per kind of track: copy, encode, remove, or what the settings say. */
function resolveChoices(raw: unknown): Record<string, AudioTrackChoice> {
	if (raw === undefined || raw === null) return {};
	if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid audio choices");
	const out: Record<string, AudioTrackChoice> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(0, 200)) {
		if (key.length > 200 || !CHOICES.includes(value as AudioTrackChoice)) throw new Error("Invalid audio choice");
		out[key] = value as AudioTrackChoice;
	}
	return out;
}

export function registerAudioTracksRoutes(app: Web, config: AppConfig): void {
	app.post("/api/audio-tracks/scan", async (c) => {
		try {
			const raw = (await c.req.json()) as { targets?: unknown; targetDir?: unknown; choices?: unknown };
			return c.json(await scanAudioTracks(resolveTargets(raw, config), config.defaults, resolveChoices(raw.choices), c.req.signal));
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});

	app.post("/api/audio-tracks/jobs", async (c) => {
		try {
			const raw = (await c.req.json()) as { targets?: unknown; choices?: unknown; replaceTarget?: unknown };
			if (!Array.isArray(raw.targets)) throw new Error("Choose at least one video");
			const targets = resolveTargets(raw, config);
			const choices = resolveChoices(raw.choices);
			const busy = getAllJobs().find((job) => targets.includes(job.inputPath) && !["done", "error", "cancelled"].includes(job.status));
			if (busy) throw new Error(`${basename(busy.inputPath)} already has an unfinished job. Finish or remove it first.`);
			const jobIds: string[] = [];
			let unchanged = 0;
			for (const path of targets) {
				const file = await inspectAudioTracksFile(path, config.defaults, c.req.signal);
				const plan = buildAudioTracksPlan(planAudioTracks(file, config.defaults, choices), file, raw.replaceTarget !== false);
				if (plan) jobIds.push(addAudioTracksJob(plan).id);
				else unchanged++;
			}
			return c.json({ jobIds, unchanged }, 201);
		} catch (error: any) {
			return c.json({ error: error?.message || String(error) }, 400);
		}
	});
}
