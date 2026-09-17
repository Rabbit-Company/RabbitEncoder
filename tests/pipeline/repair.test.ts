import { describe, expect, test } from "bun:test";
import {
	buildRepairMkvmergeArgs,
	buildRepairMkvpropeditArgs,
	buildRepairAuditGroupPlans,
	groupRepairAuditFiles,
	isMetadataOnlyRepair,
	repairAuditGroupLabel,
	sanitizeRepairPlan,
} from "../../src/pipeline/repair";
import type { RepairAuditGroupEdit, RepairAuditTrack } from "../../src/core/types";

function auditTrack(type: "audio" | "subtitles", language: string, title: string, flags: Partial<RepairAuditTrack> = {}): RepairAuditTrack {
	return {
		id: 0,
		type,
		codec: type === "audio" ? "AAC" : "SubStationAlpha",
		language,
		title,
		isDefault: false,
		isForced: false,
		isEnabled: true,
		isHearingImpaired: false,
		isVisualImpaired: false,
		isTextDescriptions: false,
		isOriginal: false,
		isCommentary: false,
		compression: "none",
		...flags,
	};
}

describe("subtitle repair plans", () => {
	test("groups folder files by majority audio/subtitle metadata and explains outliers", () => {
		const majorityTracks = [auditTrack("audio", "jpn", "Japanese", { isDefault: true }), auditTrack("subtitles", "en-JP", "Full Subtitles")];
		const audit = groupRepairAuditFiles([
			{ path: "/show/e01.mkv", filename: "e01.mkv", tracks: majorityTracks },
			{ path: "/show/e02.mkv", filename: "e02.mkv", tracks: majorityTracks.map((track) => ({ ...track })) },
			{ path: "/show/e03.mkv", filename: "e03.mkv", tracks: [auditTrack("audio", "jpn", "Japanese", { isDefault: true })] },
			{ path: "/show/e04.mkv", filename: "e04.mkv", tracks: [auditTrack("audio", "jpn", "Japanese"), auditTrack("subtitles", "en-JP", "Dialogue")] },
		]);

		expect(audit.groups.map((group) => [group.label, group.count])).toEqual([
			["A", 2],
			["B", 1],
			["C", 1],
		]);
		expect(audit.files.map((file) => file.groupLabel)).toEqual(["A", "A", "B", "C"]);
		expect(audit.files[2]!.differences).toContain("Missing Subtitle 1: en-JP (Full Subtitles)");
		expect(audit.files[3]!.differences).toContain("Audio 1 flags are Enabled. Group A uses Default, Enabled.");
		expect(audit.files[3]!.differences.some((difference) => difference.includes("Subtitle 1 title"))).toBe(true);
	});

	test("uses spreadsheet-style audit group labels", () => {
		expect([0, 25, 26, 27, 51, 52].map(repairAuditGroupLabel)).toEqual(["A", "Z", "AA", "AB", "AZ", "BA"]);
	});

	test("renames subtitles across 23 episodes using each file's own track IDs and compression", () => {
		const tracks = [auditTrack("audio", "jpn", "Japanese", { id: 1 }), auditTrack("subtitles", "eng", "Old name", { id: 2, isForced: true })];
		const files = Array.from({ length: 23 }, (_, index) => ({
			path: `/show/e${index + 1}.mkv`,
			tracks: tracks.map((track) => ({ ...track, id: track.id + index * 3, compression: index % 2 ? ("zlib" as const) : ("none" as const) })),
		}));
		const edit: RepairAuditGroupEdit = {
			paths: files.map((file) => file.path),
			expectedTracks: tracks,
			subtitles: [{ ...tracks[1]!, title: "Full Subtitles" }],
			replaceTarget: false,
		};
		const plans = buildRepairAuditGroupPlans(files, edit);
		expect(plans).toHaveLength(23);
		for (const [index, plan] of plans.entries()) {
			expect(plan.targetPath).toBe(files[index]!.path);
			expect(plan.replaceTarget).toBe(false);
			expect(plan.tracks).toHaveLength(1);
			expect(plan.tracks[0]).toMatchObject({
				trackId: 2 + index * 3,
				title: "Full Subtitles",
				language: "eng",
				compression: "preserve",
				source: "target",
				mode: "copy",
				isForced: true,
			});
			const target = { tracks: files[index]!.tracks.map((track) => ({ id: track.id, type: track.type, codec: track.codec, properties: {} })) };
			expect(isMetadataOnlyRepair(plan, target)).toBe(true);
		}
		edit.replaceTarget = true;
		expect(buildRepairAuditGroupPlans(files, edit).every((plan) => plan.replaceTarget)).toBe(true);
	});

	test("rejects stale or mixed group metadata before producing a batch of plans", () => {
		const tracks = [auditTrack("subtitles", "eng", "Full")];
		const edit: RepairAuditGroupEdit = { paths: [], expectedTracks: tracks, subtitles: [{ ...tracks[0]!, title: "New" }], replaceTarget: false };
		const first = { path: "/show/e01.mkv", tracks };
		for (const changed of [{ title: "Changed externally" }, { language: "jpn" }, { isDefault: true }, { type: "audio" as const }]) {
			expect(() => buildRepairAuditGroupPlans([first, { path: "/show/e02.mkv", tracks: [{ ...tracks[0]!, ...changed }] }], edit)).toThrow(
				"metadata changed since the audit",
			);
		}
		expect(() => buildRepairAuditGroupPlans([first, { path: "/show/e02.mkv", tracks: [] }], edit)).toThrow("metadata changed since the audit");
	});

	test("keeps every subtitle in its existing order and rejects adding or removing subtitles", () => {
		const tracks = [auditTrack("subtitles", "eng", "Full", { id: 3 }), auditTrack("subtitles", "eng", "Signs", { id: 7, isForced: true })];
		const file = { path: "/show/e01.mkv", tracks };
		const edit: RepairAuditGroupEdit = { paths: [file.path], expectedTracks: tracks, subtitles: tracks.map((track) => ({ ...track })), replaceTarget: false };
		edit.subtitles[1]!.title = "Signs & Songs";
		const plan = buildRepairAuditGroupPlans([file], edit)[0]!;
		expect(plan.tracks.map((track) => [track.trackId, track.order, track.title])).toEqual([
			[3, 0, "Full"],
			[7, 1, "Signs & Songs"],
		]);
		edit.subtitles.pop();
		expect(() => buildRepairAuditGroupPlans([file], edit)).toThrow("preserve every subtitle track");
		edit.subtitles.push({ ...tracks[1]! }, { ...tracks[1]! });
		expect(() => buildRepairAuditGroupPlans([file], edit)).toThrow("preserve every subtitle track");
	});

	test("sanitizes metadata and gives every selected track a stable order", () => {
		const plan = sanitizeRepairPlan({
			targetPath: "/media/encoded.mkv",
			sourcePath: "/media/source.mkv",
			replaceTarget: false,
			tracks: [
				{
					source: "source",
					trackId: 5,
					mode: "rabbit",
					order: 20,
					title: " Full Subtitles ",
					language: "en-JP",
					compression: "zlib",
					isDefault: true,
					isForced: false,
					isEnabled: true,
					isHearingImpaired: false,
					isOriginal: false,
					isCommentary: false,
				},
				{
					source: "target",
					trackId: 3,
					mode: "copy",
					order: 0,
					title: "Signs & Songs",
					language: "eng",
					compression: "preserve",
					isDefault: false,
					isForced: true,
					isEnabled: true,
					isHearingImpaired: false,
					isOriginal: false,
					isCommentary: false,
				},
			],
		});

		expect(plan.tracks.map((track) => `${track.source}:${track.trackId}`)).toEqual(["target:3", "source:5"]);
		expect(plan.tracks.map((track) => track.order)).toEqual([0, 1]);
		expect(plan.tracks[1]!.title).toBe("Full Subtitles");
		expect(plan.tracks[1]!.language).toBe("en-JP");
	});

	test("rejects duplicate selections", () => {
		const track = {
			source: "target" as const,
			trackId: 3,
			mode: "copy" as const,
			order: 0,
			title: "Full",
			language: "eng",
			compression: "preserve" as const,
			isDefault: true,
			isForced: false,
			isEnabled: true,
			isHearingImpaired: false,
			isOriginal: false,
			isCommentary: false,
		};
		expect(() => sanitizeRepairPlan({ targetPath: "/media/a.mkv", replaceTarget: false, tracks: [track, track] })).toThrow("selected more than once");
	});

	test("builds an explicit stream order and excludes replaced target subtitles", () => {
		const plan = sanitizeRepairPlan({
			targetPath: "/media/encoded.mkv",
			sourcePath: "/media/source.mkv",
			replaceTarget: false,
			tracks: [
				{
					source: "source",
					trackId: 5,
					mode: "rabbit",
					order: 0,
					title: "Full Subtitles",
					language: "eng",
					compression: "zlib",
					isDefault: true,
					isForced: false,
					isEnabled: true,
					isHearingImpaired: false,
					isOriginal: false,
					isCommentary: false,
				},
				{
					source: "target",
					trackId: 4,
					mode: "copy",
					order: 1,
					title: "Signs & Songs",
					language: "eng",
					compression: "none",
					isDefault: false,
					isForced: true,
					isEnabled: true,
					isHearingImpaired: false,
					isOriginal: false,
					isCommentary: false,
				},
			],
		});
		const target = {
			tracks: [
				{ id: 0, type: "video", codec: "AV1", properties: { codec_id: "V_AV1" } },
				{ id: 1, type: "audio", codec: "Opus", properties: { codec_id: "A_OPUS" } },
				{ id: 3, type: "subtitles", codec: "SubStationAlpha", properties: { codec_id: "S_TEXT/ASS" } },
				{ id: 4, type: "subtitles", codec: "SubStationAlpha", properties: { codec_id: "S_TEXT/ASS" } },
			],
		};
		const source = { tracks: [{ id: 5, type: "subtitles", codec: "SubStationAlpha", properties: { codec_id: "S_TEXT/ASS" } }] };
		const prepared = [{ plan: plan.tracks[0]!, path: "/tmp/source_5.rabbit.ass" }];
		const args = buildRepairMkvmergeArgs({ outputPath: "/tmp/out.mkv", plan, target, source, prepared });

		const orderIndex = args.indexOf("--track-order");
		expect(args[orderIndex + 1]).toBe("0:0,0:1,2:0,0:4");
		expect(args).toContain("--subtitle-tracks");
		expect(args).toContain("4");
		expect(args).toContain("--no-video");
		expect(args).toContain("--no-audio");
		expect(args).toContain("/tmp/source_5.rabbit.ass");
		expect(args).toContain("0:zlib");
		expect(args).not.toContain("3");
	});

	test("copies a source subtitle directly into the encoded target without selecting source video or audio", () => {
		const plan = sanitizeRepairPlan({
			targetPath: "/media/encoded.mkv",
			sourcePath: "/media/source.mkv",
			replaceTarget: false,
			tracks: [
				{
					source: "target",
					trackId: 2,
					mode: "copy",
					order: 0,
					title: "Signs & Songs",
					language: "eng",
					compression: "preserve",
					isDefault: false,
					isForced: true,
					isEnabled: true,
					isHearingImpaired: false,
					isOriginal: false,
					isCommentary: false,
				},
				{
					source: "source",
					trackId: 7,
					mode: "copy",
					order: 1,
					title: "Full Subtitles",
					language: "en-JP",
					compression: "preserve",
					isDefault: true,
					isForced: false,
					isEnabled: true,
					isHearingImpaired: false,
					isOriginal: true,
					isCommentary: false,
				},
			],
		});
		const target = {
			tracks: [
				{ id: 0, type: "video", codec: "AV1", properties: { codec_id: "V_AV1" } },
				{ id: 1, type: "audio", codec: "Opus", properties: { codec_id: "A_OPUS" } },
				{ id: 2, type: "subtitles", codec: "SubStationAlpha", properties: { codec_id: "S_TEXT/ASS" } },
			],
		};
		const source = {
			tracks: [
				{ id: 0, type: "video", codec: "AVC", properties: { codec_id: "V_MPEG4/ISO/AVC" } },
				{ id: 1, type: "audio", codec: "AAC", properties: { codec_id: "A_AAC" } },
				{ id: 7, type: "subtitles", codec: "SubStationAlpha", properties: { codec_id: "S_TEXT/ASS" } },
			],
		};

		const args = buildRepairMkvmergeArgs({ outputPath: "/tmp/out.mkv", plan, target, source, prepared: [] });
		expect(args[args.indexOf("--track-order") + 1]).toBe("0:0,0:1,0:2,1:7");
		expect(args).toContain("--no-video");
		expect(args).toContain("--no-audio");
		expect(args).toContain("7");
		expect(args).toContain("7:Full Subtitles");
		expect(args).toContain("7:en-JP");
	});

	test("uses mkvpropedit only when track structure, order, and compression stay unchanged", () => {
		const plan = sanitizeRepairPlan({
			targetPath: "/media/encoded.mkv",
			replaceTarget: false,
			tracks: [
				{
					source: "target",
					trackId: 2,
					mode: "copy",
					order: 0,
					title: "Full Subtitles",
					language: "en-JP",
					compression: "preserve",
					isDefault: true,
					isForced: false,
					isEnabled: true,
					isHearingImpaired: false,
					isOriginal: true,
					isCommentary: false,
				},
			],
		});
		const target = {
			tracks: [
				{ id: 0, type: "video", codec: "AV1", properties: { codec_id: "V_AV1" } },
				{ id: 1, type: "audio", codec: "Opus", properties: { codec_id: "A_OPUS" } },
				{ id: 2, type: "subtitles", codec: "SubStationAlpha", properties: { codec_id: "S_TEXT/ASS" } },
			],
		};

		expect(isMetadataOnlyRepair(plan, target)).toBe(true);
		const args = buildRepairMkvpropeditArgs("/tmp/staged.mkv", plan, target);
		expect(args).toContain("track:3");
		expect(args).toContain("name=Full Subtitles");
		expect(args).toContain("language-ietf=en-JP");
		expect(args).toContain("flag-original=1");

		plan.tracks[0]!.compression = "zlib";
		expect(isMetadataOnlyRepair(plan, target)).toBe(false);
	});
});
