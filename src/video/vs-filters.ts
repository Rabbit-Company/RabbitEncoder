import { existsSync, readFileSync, readdirSync } from "fs";
import { join, parse as parsePath } from "path";
import { Logger } from "../core/logger";
import { CancelledError, computeFps, fmtFrames } from "../core/process";
import { FFV1_ENCODE_ARGS } from "./auto-denoise";
import type { VsFilterEntry, VsParamSpec, VsParamType, VsParamValue, VsPresetManifest, VsPresetSource } from "../core/types";

const STOCK_DIR_DEFAULT = "/app/vapoursynth/presets";
const USER_DIR_DEFAULT = "/config/vapoursynth/presets";
const RABBIT_VS_DIR_DEFAULT = "/app/vapoursynth";

class VsRegistry {
	private presets = new Map<string, VsPresetManifest>();
	private stockDir = STOCK_DIR_DEFAULT;
	private userDir = USER_DIR_DEFAULT;
	private rabbitVsDir = RABBIT_VS_DIR_DEFAULT;

	configure(stockDir: string, userDir: string, rabbitVsDir: string): void {
		this.stockDir = stockDir;
		this.userDir = userDir;
		this.rabbitVsDir = rabbitVsDir;
	}

	/** Path that must be on PYTHONPATH so `import rabbit_vs` resolves. */
	getRabbitVsDir(): string {
		return this.rabbitVsDir;
	}

	reload(): void {
		this.presets.clear();
		this.scanDir(this.stockDir, "stock");
		this.scanDir(this.userDir, "user");
		Logger.info(`[vs] Loaded ${this.presets.size} preset(s)`);
	}

	private scanDir(dir: string, source: VsPresetSource): void {
		if (!existsSync(dir)) {
			Logger.debug(`[vs] Preset dir does not exist: ${dir}`);
			return;
		}

		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch (err: any) {
			Logger.warn(`[vs] Failed to read preset dir ${dir}: ${err?.message || err}`);
			return;
		}

		for (const entry of entries) {
			if (!entry.endsWith(".json")) continue;

			const manifestPath = join(dir, entry);
			const stem = parsePath(entry).name;
			const scriptPath = join(dir, `${stem}.vpy`);

			if (!existsSync(scriptPath)) {
				Logger.warn(`[vs] Manifest ${manifestPath} has no matching .vpy script. Skipping.`);
				continue;
			}

			try {
				const raw = readFileSync(manifestPath, "utf-8");
				const parsed = JSON.parse(raw);
				const manifest = validateManifest(parsed, source, scriptPath, manifestPath);
				if (this.presets.has(manifest.id)) {
					Logger.warn(`[vs] Duplicate preset id ${manifest.id}. Keeping first definition.`);
					continue;
				}
				this.presets.set(manifest.id, manifest);
				Logger.debug(`[vs] Registered ${manifest.id} (${manifest.params.length} params, levels: ${manifest.levels.join(",")})`);
			} catch (err: any) {
				Logger.warn(`[vs] Failed to load preset ${manifestPath}: ${err?.message || err}`);
			}
		}
	}

	get(id: string): VsPresetManifest | undefined {
		return this.presets.get(id);
	}

	list(): VsPresetManifest[] {
		return Array.from(this.presets.values()).sort((a, b) => {
			// stock first, then user; alphabetical within each group
			if (a.source !== b.source) return a.source === "stock" ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
	}
}

export const vsRegistry = new VsRegistry();

function validateManifest(raw: any, source: VsPresetSource, scriptPath: string, manifestPath: string): VsPresetManifest {
	const where = `manifest ${manifestPath}`;

	if (typeof raw?.id !== "string" || !/^[a-z0-9_-]+$/i.test(raw.id)) {
		throw new Error(`${where}: invalid or missing "id" (must be [a-z0-9_-]+)`);
	}
	if (typeof raw?.name !== "string") throw new Error(`${where}: missing "name"`);
	if (!Array.isArray(raw?.levels) || raw.levels.length === 0) {
		throw new Error(`${where}: "levels" must be a non-empty array of strings`);
	}
	const levels: string[] = raw.levels.map((l: any) => String(l));
	const levelSet = new Set(levels);
	if (levelSet.size !== levels.length) {
		throw new Error(`${where}: duplicate level names`);
	}

	if (!Array.isArray(raw?.params)) throw new Error(`${where}: "params" must be an array`);
	const params: VsParamSpec[] = raw.params.map((p: any, i: number) => validateParam(p, levels, `${where} params[${i}]`));

	const seenKeys = new Set<string>();
	for (const p of params) {
		if (seenKeys.has(p.key)) throw new Error(`${where}: duplicate param key "${p.key}"`);
		seenKeys.add(p.key);
	}

	const supports = {
		bitDepth: Array.isArray(raw?.supports?.bitDepth)
			? raw.supports.bitDepth.map((n: any) => Number(n)).filter((n: number) => Number.isInteger(n))
			: [8, 10, 16],
		hdr: !!raw?.supports?.hdr,
	};

	const bareId = String(raw.id);

	return {
		id: `${source}:${bareId}`,
		bareId,
		name: String(raw.name),
		description: typeof raw.description === "string" ? raw.description : "",
		category: typeof raw.category === "string" ? raw.category : undefined,
		supports,
		levels,
		params,
		source,
		scriptPath,
		manifestPath,
	};
}

function validateParam(raw: any, levels: string[], where: string): VsParamSpec {
	if (typeof raw?.key !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(raw.key)) {
		throw new Error(`${where}: invalid or missing "key"`);
	}
	const type: VsParamType = raw.type;
	if (!["float", "int", "bool", "enum"].includes(type)) {
		throw new Error(`${where}: "type" must be one of float|int|bool|enum`);
	}

	if (type === "enum" && (!Array.isArray(raw.enum) || raw.enum.length === 0)) {
		throw new Error(`${where}: enum param requires a non-empty "enum" array`);
	}

	if (typeof raw?.defaults !== "object" || raw.defaults === null) {
		throw new Error(`${where}: "defaults" must be an object keyed by level name`);
	}
	const defaults: Record<string, VsParamValue> = {};
	for (const lvl of levels) {
		if (!(lvl in raw.defaults)) {
			throw new Error(`${where}: missing default for level "${lvl}"`);
		}
		defaults[lvl] = coerceValue(raw.defaults[lvl], type, raw.enum);
	}

	return {
		key: raw.key,
		label: typeof raw.label === "string" ? raw.label : raw.key,
		type,
		min: typeof raw.min === "number" ? raw.min : undefined,
		max: typeof raw.max === "number" ? raw.max : undefined,
		step: typeof raw.step === "number" ? raw.step : undefined,
		enum: type === "enum" ? raw.enum.map((s: any) => String(s)) : undefined,
		help: typeof raw.help === "string" ? raw.help : undefined,
		defaults,
	};
}

function coerceValue(v: unknown, type: VsParamType, enumValues?: string[]): VsParamValue {
	if (type === "bool") return !!v;
	if (type === "int") {
		const n = Number(v);
		if (!Number.isFinite(n)) throw new Error(`expected int, got ${JSON.stringify(v)}`);
		return Math.round(n);
	}
	if (type === "float") {
		const n = Number(v);
		if (!Number.isFinite(n)) throw new Error(`expected float, got ${JSON.stringify(v)}`);
		return n;
	}
	// enum
	const s = String(v);
	if (enumValues && !enumValues.includes(s)) {
		throw new Error(`enum value "${s}" not in [${enumValues.join(", ")}]`);
	}
	return s;
}

function clampNum(v: number, min?: number, max?: number): number {
	if (typeof min === "number" && v < min) v = min;
	if (typeof max === "number" && v > max) v = max;
	return v;
}

function normalizeOne(raw: unknown, spec: VsParamSpec): VsParamValue {
	switch (spec.type) {
		case "bool":
			return typeof raw === "boolean" ? raw : raw === "true" || raw === 1;
		case "int": {
			const n = typeof raw === "number" ? raw : parseFloat(String(raw));
			return Number.isFinite(n) ? clampNum(Math.round(n), spec.min, spec.max) : 0;
		}
		case "float": {
			const n = typeof raw === "number" ? raw : parseFloat(String(raw));
			return Number.isFinite(n) ? clampNum(n, spec.min, spec.max) : 0;
		}
		case "enum": {
			const s = String(raw);
			return spec.enum && spec.enum.includes(s) ? s : (spec.enum?.[0] ?? "");
		}
	}
}

/**
 * Normalize a (possibly partial / legacy) VsFilterEntry against its manifest.
 *
 * - Fills in any missing per-level defaults from the manifest.
 * - Clamps every value to its declared range.
 * - Forces `level` to be either "off" or one of the manifest's levels.
 *
 * Returns null if the manifest can't be found (preset deleted/renamed).
 */
export function normalizeVsFilterEntry(entry: Partial<VsFilterEntry> | undefined | null): VsFilterEntry | null {
	if (!entry || typeof entry.presetId !== "string") return null;
	const manifest = vsRegistry.get(entry.presetId);
	if (!manifest) {
		Logger.warn(`[vs] Dropping entry with unknown preset: ${entry.presetId}`);
		return null;
	}

	const params: Record<string, Record<string, VsParamValue>> = {};
	const incoming = (entry.params ?? {}) as Record<string, Record<string, unknown>>;

	for (const lvl of manifest.levels) {
		const lvlIn = incoming[lvl] ?? {};
		const lvlOut: Record<string, VsParamValue> = {};
		for (const spec of manifest.params) {
			const provided = lvlIn[spec.key];
			lvlOut[spec.key] = provided === undefined ? spec.defaults[lvl]! : normalizeOne(provided, spec);
		}
		params[lvl] = lvlOut;
	}

	const requestedLevel = String(entry.level ?? "off");
	const level = requestedLevel === "off" || manifest.levels.includes(requestedLevel) ? requestedLevel : "off";

	return {
		presetId: manifest.id,
		level,
		params,
	};
}

export function normalizeVsFilterChain(entries: Partial<VsFilterEntry>[] | undefined | null): VsFilterEntry[] {
	if (!Array.isArray(entries)) return [];
	const out: VsFilterEntry[] = [];
	for (const e of entries) {
		const n = normalizeVsFilterEntry(e);
		if (n) out.push(n);
	}
	return out;
}

/**
 * Build a fresh entry for a preset, filling all levels with manifest defaults.
 * Used by the UI when the user adds a new filter to the chain.
 */
export function makeDefaultVsFilterEntry(presetId: string): VsFilterEntry | null {
	const manifest = vsRegistry.get(presetId);
	if (!manifest) return null;
	const params: Record<string, Record<string, VsParamValue>> = {};
	for (const lvl of manifest.levels) {
		const lvlOut: Record<string, VsParamValue> = {};
		for (const spec of manifest.params) lvlOut[spec.key] = spec.defaults[lvl]!;
		params[lvl] = lvlOut;
	}
	return {
		presetId: manifest.id,
		level: manifest.levels[0]!, // default to first declared level
		params,
	};
}

interface SourceColorTags {
	pixFmt: string;
	colorRange?: string;
	colorPrimaries?: string;
	colorTrc?: string;
	colorSpace?: string;
}

async function probeSourceColor(inputPath: string): Promise<SourceColorTags> {
	const proc = Bun.spawn(
		[
			"ffprobe",
			"-v",
			"error",
			"-select_streams",
			"v:0",
			"-show_entries",
			"stream=pix_fmt,color_range,color_primaries,color_trc,color_space",
			"-of",
			"json",
			inputPath,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const out = await new Response(proc.stdout).text();
	await proc.exited;

	let s: any = {};
	try {
		s = JSON.parse(out)?.streams?.[0] ?? {};
	} catch {}

	const clean = (v: unknown): string | undefined => {
		if (typeof v !== "string") return undefined;
		const t = v.trim();
		if (!t || t === "unknown" || t === "N/A") return undefined;
		return t;
	};

	return {
		pixFmt: clean(s.pix_fmt) ?? "yuv420p",
		colorRange: clean(s.color_range),
		colorPrimaries: clean(s.color_primaries),
		colorTrc: clean(s.color_trc),
		colorSpace: clean(s.color_space),
	};
}

function buildColorPassthroughArgs(c: SourceColorTags): string[] {
	const args: string[] = [];
	if (c.colorRange) args.push("-color_range", c.colorRange);
	if (c.colorPrimaries) args.push("-color_primaries", c.colorPrimaries);
	if (c.colorTrc) args.push("-color_trc", c.colorTrc);
	if (c.colorSpace) args.push("-colorspace", c.colorSpace);
	return args;
}

/**
 * Build the vspipe argv that runs `manifest`'s script with the params for the
 * selected level.
 *
 * The convention every preset must follow is: read `SRC` and the named params
 * via `rabbit_vs.arg_*`. We pass them as -a key=value pairs.
 */
export function buildVsCommand(manifest: VsPresetManifest, entry: VsFilterEntry, inputPath: string): string[] {
	if (entry.level === "off" || !manifest.levels.includes(entry.level)) {
		throw new Error(`buildVsCommand called for inactive entry (level=${entry.level})`);
	}

	const lvlParams = entry.params[entry.level] ?? {};

	const args: string[] = ["vspipe", manifest.scriptPath, "-", "-p", "-c", "y4m", "--arg", `SRC=${inputPath}`];

	for (const spec of manifest.params) {
		const v = lvlParams[spec.key] ?? spec.defaults[entry.level];
		args.push("--arg", `${spec.key}=${formatArg(v!, spec)}`);
	}

	return args;
}

function formatArg(v: VsParamValue, spec: VsParamSpec): string {
	if (spec.type === "bool") return v ? "true" : "false";
	return String(v);
}

export interface VsPassResult {
	/** Final output path (same as the one passed in). */
	outputPath: string;
	/** Frames written to the output. */
	frames: number;
	/** Tail of stderr from both processes, concatenated, for diagnostics. */
	stderrTail: string;
}

export interface RunVsPassOptions {
	manifest: VsPresetManifest;
	entry: VsFilterEntry;
	inputPath: string;
	outputPath: string;
	totalFrames: number;
	onProgress?: (currentFrames: number, fpsStr: string | null) => void;
	signal?: AbortSignal;
}

function shQuote(s: string): string {
	return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Run a single VapourSynth pass on `inputPath`, writing FFV1 to `outputPath`.
 *
 * Internally:  `vspipe -c y4m ... script.vpy -` | `ffmpeg -i pipe:0 ... FFV1`
 *
 * Color metadata is probed from the source and re-applied on the ffmpeg side
 * because the y4m container does not carry full HDR signalling.
 */
export async function runVsPass(opts: RunVsPassOptions): Promise<VsPassResult> {
	const { manifest, entry, inputPath, outputPath, totalFrames, onProgress, signal } = opts;

	if (signal?.aborted) throw new CancelledError();

	const colorTags = await probeSourceColor(inputPath);
	const colorArgs = buildColorPassthroughArgs(colorTags);

	const vsArgs = buildVsCommand(manifest, entry, inputPath);

	const ffmpegTailArgs = [...colorArgs, ...FFV1_ENCODE_ARGS, "-an", "-sn", outputPath];

	const env: Record<string, string> = { ...process.env } as Record<string, string>;
	const existingPyPath = env.PYTHONPATH ? `:${env.PYTHONPATH}` : "";
	env.PYTHONPATH = `${vsRegistry.getRabbitVsDir()}${existingPyPath}`;

	Logger.debug(`[vs] ${manifest.id} level=${entry.level} cmd: ${vsArgs.join(" ")}`);

	const vsCmd = vsArgs.map(shQuote).join(" ");
	const ffmpegTailCmd = ffmpegTailArgs.map(shQuote).join(" ");

	const pipelineScript = `
set -u

fifo="$(mktemp -u /tmp/rabbit-vs-y4m.XXXXXX)"
mkfifo "$fifo"

vspid=""
ffpid=""

cleanup_children() {
	trap - TERM INT

	if [ -n "$vspid" ]; then
		kill -TERM "$vspid" 2>/dev/null || true
	fi

	if [ -n "$ffpid" ]; then
		kill -TERM "$ffpid" 2>/dev/null || true
	fi

	sleep 0.3

	if [ -n "$vspid" ]; then
		kill -KILL "$vspid" 2>/dev/null || true
	fi

	if [ -n "$ffpid" ]; then
		kill -KILL "$ffpid" 2>/dev/null || true
	fi
}

cleanup_exit() {
	rm -f "$fifo"
}

on_term() {
	cleanup_children
	cleanup_exit
	exit 143
}

trap on_term TERM INT
trap cleanup_exit EXIT

ffmpeg -y -f yuv4mpegpipe -i "$fifo" ${ffmpegTailCmd} &
ffpid="$!"

${vsCmd} > "$fifo" &
vspid="$!"

wait "$vspid"
vs_code="$?"

wait "$ffpid"
ff_code="$?"

if [ "$vs_code" -ne 0 ]; then
	exit "$vs_code"
fi

if [ "$ff_code" -ne 0 ]; then
	exit "$ff_code"
fi

exit 0
`.trim();

	const proc = Bun.spawn(["bash", "-lc", pipelineScript], {
		stdout: "ignore",
		stderr: "pipe",
		env,
	});

	const onAbort = () => {
		try {
			proc.kill("SIGTERM");
		} catch {}

		setTimeout(() => {
			try {
				proc.kill("SIGKILL");
			} catch {}
		}, 3000);
	};

	if (signal) {
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	}

	const startedAt = Date.now();
	let currentFrames = 0;

	const stderrTask = readStderrLines(proc.stderr, (line) => {
		const m = line.match(/Frame:\s*(\d+)\s*\/\s*(\d+)/);
		if (m) {
			currentFrames = parseInt(m[1]!, 10);
			const fps = computeFps(currentFrames, startedAt);
			onProgress?.(currentFrames, fps);
		}
	});

	const [stderr, code] = await Promise.all([stderrTask, proc.exited]);

	if (signal && !signal.aborted) {
		signal.removeEventListener("abort", onAbort);
	}

	if (signal?.aborted) {
		throw new CancelledError();
	}

	if (code !== 0) {
		const tail = stderr.trim().split("\n").slice(-40).join("\n");
		throw new Error(`VapourSynth pass failed (preset=${manifest.id}, level=${entry.level}, exit=${code}):\n${tail}`);
	}

	return {
		outputPath,
		frames: currentFrames || totalFrames,
		stderrTail: stderr.slice(-2000),
	};
}

async function readStderrLines(stream: ReadableStream<Uint8Array> | undefined | null, onLine: (line: string) => void): Promise<string> {
	if (!stream) return "";

	const collected: string[] = [];
	try {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		while (true) {
			try {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const parts = buffer.split(/[\r\n]/);
				buffer = parts.pop() || "";
				for (const part of parts) {
					if (part) {
						collected.push(part);
						onLine(part);
					}
				}
			} catch {
				break;
			}
		}
		if (buffer) {
			collected.push(buffer);
			onLine(buffer);
		}
	} catch {}

	return collected.join("\n");
}

export function formatVsProgressDetail(presetName: string, level: string, current: number, total: number, fpsStr: string | null): string {
	const base = `${presetName} (${level}): ${fmtFrames(current, total)}`;
	return fpsStr ? `${base} @ ${fpsStr} fps` : base;
}
