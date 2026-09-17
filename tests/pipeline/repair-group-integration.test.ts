import { expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { run } from "../../src/core/process";
import {
	buildRepairAuditGroupPlans,
	buildRepairMkvpropeditArgs,
	groupRepairAuditFiles,
	identifyMatroska,
	inspectRepairAuditFile,
} from "../../src/pipeline/repair";

const hasTools = ["ffmpeg", "mkvmerge", "mkvpropedit"].every((tool) => Bun.which(tool));

(hasTools ? test : test.skip)(
	"group edits preserve real MKV streams, per-file compression, and unedited flags",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "rabbit-group-repair-"));
		const command = async (args: string[]) => {
			const result = await run(args, { cwd: root });
			if (result.code !== 0 && !(args[0] === "mkvmerge" && result.code === 1)) throw new Error(result.stderr || result.stdout);
		};
		try {
			writeFileSync(join(root, "sub.srt"), "1\n00:00:00,000 --> 00:00:00,800\nHello world\n");
			await command([
				"ffmpeg",
				"-v",
				"error",
				"-f",
				"lavfi",
				"-i",
				"color=black:s=64x64:r=10:d=1",
				"-f",
				"lavfi",
				"-i",
				"sine=frequency=440:duration=1",
				"-i",
				"sub.srt",
				"-map",
				"0:v",
				"-map",
				"1:a",
				"-map",
				"2:s",
				"-c:v",
				"libx264",
				"-preset",
				"ultrafast",
				"-c:a",
				"aac",
				"-c:s",
				"copy",
				"-metadata:s:s:0",
				"title=Old name",
				"-metadata:s:s:0",
				"language=eng",
				"source.mkv",
			]);
			await command(["mkvmerge", "-o", "e01.mkv", "--no-video", "--compression", "2:none", "--visual-impaired-flag", "2:1", "source.mkv"]);
			await command(["mkvmerge", "-o", "e02.mkv", "--compression", "2:zlib", "--visual-impaired-flag", "2:1", "source.mkv"]);
			const files = await Promise.all(["e01.mkv", "e02.mkv"].map((name) => inspectRepairAuditFile(join(root, name))));
			expect(groupRepairAuditFiles(files).groups).toHaveLength(1);
			expect(files[0]!.tracks.find((track) => track.type === "subtitles")!.id).not.toBe(files[1]!.tracks.find((track) => track.type === "subtitles")!.id);
			expect(files.map((file) => file.tracks.find((track) => track.type === "subtitles")!.compression)).toEqual(["none", "zlib"]);
			const plans = buildRepairAuditGroupPlans(files, {
				paths: files.map((file) => file.path),
				expectedTracks: files[0]!.tracks,
				subtitles: files[0]!.tracks.filter((track) => track.type === "subtitles").map((track) => ({ ...track, title: "Full Subtitles" })),
				replaceTarget: false,
			});
			for (const [index, plan] of plans.entries()) {
				const original = await identifyMatroska(plan.targetPath);
				const staged = join(root, `repaired-${index}.mkv`);
				copyFileSync(plan.targetPath, staged);
				await command(buildRepairMkvpropeditArgs(staged, plan, original));
				const repaired = await inspectRepairAuditFile(staged);
				expect(repaired.tracks).toEqual(files[index]!.tracks.map((track) => (track.type === "subtitles" ? { ...track, title: "Full Subtitles" } : track)));
				const verified = await identifyMatroska(staged);
				expect(verified.tracks?.map((track) => [track.type, track.codec])).toEqual(original.tracks?.map((track) => [track.type, track.codec]));
				expect((await inspectRepairAuditFile(plan.targetPath)).tracks).toEqual(files[index]!.tracks);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
	30_000,
);
