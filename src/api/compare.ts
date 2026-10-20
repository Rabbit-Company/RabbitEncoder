import type { Web } from "@rabbit-company/web";
import type { AppConfig } from "../core/types";
import { resolveAllowedMediaFile } from "./repair";
import { buildZip } from "../core/zip";
import {
	cancelSession,
	clearSessions,
	comparisonArchiveEntries,
	compareRoot,
	deleteSession,
	listSessions,
	loadSession,
	readImage,
	startCompare,
	type CompareFrameMode,
	type CompareSourceInput,
} from "../compare/compare";

const MAX_SOURCES = 8;
const MAX_FRAMES = 50;
const MAX_OFFSET_MS = 3_600_000;

export function registerCompareRoutes(app: Web, config: AppConfig): void {
	const root = compareRoot(config);

	app.get("/api/compare", (c) =>
		c.json({
			sessions: listSessions(root).map((s) => ({
				id: s.id,
				createdAt: s.createdAt,
				status: s.status,
				labels: s.sources.map((x) => x.label),
				frames: s.frames.length,
			})),
		}),
	);

	app.post("/api/compare", async (c) => {
		try {
			const body = (await c.req.json().catch(() => ({}))) as { sources?: unknown; mode?: unknown; count?: unknown; timestamps?: unknown; align?: unknown };
			if (!Array.isArray(body.sources) || body.sources.length < 2 || body.sources.length > MAX_SOURCES)
				throw new Error(`Choose 2 to ${MAX_SOURCES} videos to compare`);
			const sources: CompareSourceInput[] = body.sources.map((raw, i) => {
				const entry = (raw ?? {}) as { path?: unknown; label?: unknown; offsetMs?: unknown; range?: unknown; matrix?: unknown };
				const path = resolveAllowedMediaFile(entry.path, config, `Video ${i + 1}`);
				const label = (typeof entry.label === "string" ? entry.label.trim().slice(0, 40) : "") || `Source ${i + 1}`;
				let offsetMs: number | undefined;
				if (i > 0 && entry.offsetMs !== undefined && entry.offsetMs !== null) {
					offsetMs = Number(entry.offsetMs);
					if (!Number.isFinite(offsetMs) || Math.abs(offsetMs) > MAX_OFFSET_MS) throw new Error(`Offset for ${label} must be within one hour`);
				}
				if (entry.range !== undefined && entry.range !== null && entry.range !== "limited" && entry.range !== "full")
					throw new Error(`Range for ${label} must be limited or full`);
				if (entry.matrix !== undefined && entry.matrix !== null && !["709", "601", "2020"].includes(entry.matrix as string))
					throw new Error(`Matrix for ${label} must be 709, 601 or 2020`);
				return {
					path,
					label,
					offsetMs,
					range: (entry.range ?? undefined) as CompareSourceInput["range"],
					matrix: (entry.matrix ?? undefined) as CompareSourceInput["matrix"],
				};
			});
			const mode = body.mode as CompareFrameMode;
			if (!["even", "random", "manual"].includes(mode)) throw new Error("mode must be even, random or manual");
			const count = Number(body.count ?? 30);
			if (mode !== "manual" && (!Number.isInteger(count) || count < 1 || count > MAX_FRAMES)) throw new Error(`Frame count must be 1 to ${MAX_FRAMES}`);
			let timestamps: number[] | undefined;
			if (mode === "manual") {
				if (!Array.isArray(body.timestamps) || body.timestamps.length === 0 || body.timestamps.length > MAX_FRAMES)
					throw new Error(`Enter 1 to ${MAX_FRAMES} timestamps`);
				timestamps = body.timestamps.map(Number);
				if (timestamps.some((t) => !Number.isFinite(t) || t < 0)) throw new Error("Timestamps must be positive seconds");
			}
			const session = startCompare(root, { sources, mode, count, timestamps, align: body.align !== false });
			return c.json(session);
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
		}
	});

	app.get("/api/compare/:id", (c) => {
		const session = loadSession(root, c.params.id!);
		return session ? c.json(session) : c.json({ error: "Comparison not found" }, 404);
	});

	app.get("/api/compare/:id/image/:frame/:source", (c) => {
		const frame = Number(c.params.frame);
		const source = Number(c.params.source);
		if (!Number.isInteger(frame) || frame < 0 || !Number.isInteger(source) || source < 0) return c.json({ error: "Invalid image" }, 400);
		const data = readImage(root, c.params.id!, frame, source);
		if (!data) return c.json({ error: "Image not found" }, 404);
		return new Response(new Uint8Array(data), { headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=86400" } });
	});

	app.get("/api/compare/:id/download", (c) => {
		const session = loadSession(root, c.params.id!);
		if (!session || session.status !== "done") return c.json({ error: "Comparison not found or not finished" }, 404);
		const zip = buildZip(comparisonArchiveEntries(root, session), new Date(session.createdAt));
		const name = `compare_${session.sources.map((s) => s.label.replace(/[^\p{L}\p{N}._-]+/gu, "_")).join("_vs_")}.zip`;
		return new Response(zip, {
			headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}` },
		});
	});

	app.delete("/api/compare", (c) => c.json({ ok: true, removed: clearSessions(root) }));

	app.delete("/api/compare/:id", (c) => {
		if (cancelSession(c.params.id!)) return c.json({ ok: true, cancelled: true });
		return deleteSession(root, c.params.id!) ? c.json({ ok: true }) : c.json({ error: "Comparison not found" }, 404);
	});
}
