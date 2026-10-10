import type { Web } from "@rabbit-company/web";
import type { AppConfig } from "../core/types";
import { BENCHMARK_MODES, cancelBenchmark, getBenchmarkState, startBenchmark, type BenchmarkMode } from "../video/benchmark";

export function registerBenchmarkRoutes(app: Web, config: AppConfig): void {
	const currentState = () => getBenchmarkState(config.defaults.gpuDevice, config.defaults.denoiseBackend, config.defaults.avdDevice);

	app.get("/api/benchmark", async (c) => {
		return c.json(await currentState());
	});

	app.post("/api/benchmark", async (c) => {
		// Optional body: { modes: ["cpu", "vulkan", "avd-nl4d", ...] }. No body benchmarks everything available.
		const body = (await c.req.json().catch(() => null)) as { modes?: unknown } | null;
		const modes = Array.isArray(body?.modes) ? BENCHMARK_MODES.filter((m) => (body!.modes as unknown[]).includes(m)) : undefined;
		if (modes && modes.length === 0) return c.json({ error: "No valid benchmark modes selected" }, 400);

		const result = await startBenchmark({
			gpuDevice: config.defaults.gpuDevice,
			denoiseBackend: config.defaults.denoiseBackend,
			avdDevice: config.defaults.avdDevice,
			modes: modes as BenchmarkMode[] | undefined,
		});
		if (!result.ok) return c.json({ error: result.error || "Failed to start benchmark" }, 409);
		return c.json(await currentState());
	});

	app.delete("/api/benchmark", (c) => {
		const ok = cancelBenchmark();
		if (!ok) return c.json({ error: "No benchmark currently running" }, 400);
		return c.json({ ok: true });
	});
}
