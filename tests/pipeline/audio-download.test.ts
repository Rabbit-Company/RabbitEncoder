import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Web } from "@rabbit-company/web";
import type { AppConfig } from "../../src/core/types";
import { run } from "../../src/core/process";
import { audioExtension, registerRepairRoutes } from "../../src/api/repair";

const hasTools = !!Bun.which("ffmpeg") && !!Bun.which("mkvextract") && !!Bun.which("mkvmerge");

describe("audioExtension", () => {
	it("maps Matroska audio codec IDs to the file mkvextract writes", () => {
		expect(audioExtension("A_FLAC")).toBe("flac");
		expect(audioExtension("A_OPUS")).toBe("opus");
		expect(audioExtension("A_AAC/MPEG4/LC")).toBe("aac");
		expect(audioExtension("A_TRUEHD")).toBe("thd");
		expect(audioExtension("A_PCM/INT/LIT")).toBe("wav");
		expect(audioExtension("A_REAL/COOK")).toBeUndefined();
	});
});

(hasTools ? it : it.skip)("extracts an audio track and removes its temporary copy", async () => {
	const root = mkdtempSync(join(tmpdir(), "rabbit-audio-download-"));
	try {
		const input = join(root, "input");
		const temp = join(root, "temp");
		const mkv = join(input, "Show - 01.mkv");
		await run(["mkdir", "-p", input, temp]);
		const made = await run([
			"ffmpeg",
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:duration=1",
			"-c:a",
			"flac",
			"-metadata:s:a:0",
			"language=slv",
			mkv,
		]);
		expect(made.code).toBe(0);

		const app = new Web();
		registerRepairRoutes(app, { inputDir: input, outputDir: join(root, "out"), libraryDirs: [], tempDir: temp } as unknown as AppConfig);
		const download = (trackId: number) =>
			app.handle(
				new Request("http://localhost/api/repair/audio-download", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ path: mkv, trackId }),
				}),
			);

		const res = await download(0);
		expect(res.status).toBe(200);
		expect(decodeURIComponent(res.headers.get("Content-Disposition")!)).toContain("Show - 01.0.slv.flac");
		const data = new Uint8Array(await res.arrayBuffer());
		expect(new TextDecoder().decode(data.slice(0, 4))).toBe("fLaC");
		expect(readdirSync(temp)).toEqual([]);

		expect((await download(5)).status).toBe(400);
		expect(existsSync(temp) && readdirSync(temp)).toEqual([]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
