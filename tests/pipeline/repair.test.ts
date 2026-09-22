import { describe, expect, test } from "bun:test";
import {
	applyAutoCompression,
	buildRepairMkvmergeArgs,
	buildRepairMkvpropeditArgs,
	buildRepairAuditGroupPlans,
	groupRepairAuditFiles,
	isMetadataOnlyRepair,
	repairAuditGroupLabel,
	sanitizeRepairPlan,
	usedFontsAfterRepair,
} from "../../src/pipeline/repair";
import type { RepairAuditGroupEdit, RepairAuditTrack } from "../../src/core/types";
import { ass4kWithSign, buildAss } from "../fixtures/ass";

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

describe("repair font retention", () => {
	const track = (over: Record<string, unknown> = {}) => ({
		plan: { source: "target", trackId: 3 } as never,
		path: "/tmp/target_3.raw.ass",
		kind: "ass" as const,
		restyle: true,
		...over,
	});

	test("drops the dialogue font we replace but keeps fonts the same file still uses", () => {
		const used = usedFontsAfterRepair([track({ rawText: ass4kWithSign() })], []);

		expect(used.has("comic sans ms")).toBe(true); // the sign style is untouched
		expect(used.has("arial")).toBe(false); // restyled away, so its attachment can go
	});

	test("keeps the dialogue font of a track that is not restyled", () => {
		const used = usedFontsAfterRepair([track({ rawText: ass4kWithSign(), restyle: false })], []);

		expect(used.has("arial")).toBe(true);
		expect(used.has("comic sans ms")).toBe(true);
	});

	test("keeps every font used by a copied track", () => {
		const used = usedFontsAfterRepair([], [ass4kWithSign()]);

		expect(used.has("arial")).toBe(true);
		expect(used.has("comic sans ms")).toBe(true);
	});

	test("keeps a font an inline override pulls in", () => {
		const overridden = buildAss({ events: ["Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\fnPapyrus}Hello"] });

		expect(usedFontsAfterRepair([track({ rawText: overridden })], []).has("papyrus")).toBe(true);
	});

	test("reports no fonts for an SRT track passed through untouched", () => {
		expect(usedFontsAfterRepair([track({ kind: "srt-passthrough", restyle: false })], []).size).toBe(0);
	});
});

describe("repair attachment rewrite", () => {
	const plan = () =>
		sanitizeRepairPlan({
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
					compression: "none",
					isDefault: true,
					isForced: false,
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
			{ id: 3, type: "subtitles", codec: "SubStationAlpha", properties: { codec_id: "S_TEXT/ASS" } },
		],
		attachments: [{ id: 1, file_name: "noto_sans.ttf" }],
	};
	const source = { tracks: [{ id: 5, type: "subtitles", codec: "SubStationAlpha", properties: { codec_id: "S_TEXT/ASS" } }], attachments: [] };
	const prepared = [
		{
			plan: plan().tracks[0]!,
			path: "/tmp/source_5.rabbit.ass",
			attachFontPath: "/tmp/inst_abc.ttf",
			attachFontName: "noto_sans.ttf",
			attachFontMime: "font/ttf",
		},
	];

	test("re-attaches only the kept attachments and lets the injected face reuse a dropped name", () => {
		const kept = [{ fileName: "signs.otf", path: "/tmp/att_target_2_signs.otf", mime: "font/otf", isFont: true, names: ["signsfont"] }];
		const args = buildRepairMkvmergeArgs({ outputPath: "/tmp/out.mkv", plan: plan(), target, source, prepared, keptAttachments: kept });

		// Both inputs are muxed without their own attachments, so the stale
		// noto_sans.ttf in the target is dropped rather than passed through.
		expect(args.filter((arg) => arg === "--no-attachments")).toHaveLength(2);
		expect(args).toContain("/tmp/att_target_2_signs.otf");
		expect(args).toContain("font/otf");
		// Its name is free again, so the fresh face is attached under it.
		expect(args).toContain("/tmp/inst_abc.ttf");
		expect(args[args.indexOf("/tmp/inst_abc.ttf") - 1]).toBe("--attach-file");
		expect(args).toContain("noto_sans.ttf");
	});

	test("does not attach a face whose name a kept attachment still holds", () => {
		const kept = [{ fileName: "noto_sans.ttf", path: "/tmp/att_target_1_noto_sans.ttf", mime: "font/ttf", isFont: true, names: ["notosans"] }];
		const args = buildRepairMkvmergeArgs({ outputPath: "/tmp/out.mkv", plan: plan(), target, source, prepared, keptAttachments: kept });

		expect(args).toContain("/tmp/att_target_1_noto_sans.ttf");
		expect(args).not.toContain("/tmp/inst_abc.ttf");
	});

	test("passes attachments through untouched when the kept set is unknown", () => {
		const args = buildRepairMkvmergeArgs({ outputPath: "/tmp/out.mkv", plan: plan(), target, source, prepared, keptAttachments: null });

		// Only the source input is muxed without attachments, as before.
		expect(args.filter((arg) => arg === "--no-attachments")).toHaveLength(1);
		// The target already carries a noto_sans.ttf, so nothing is attached over it.
		expect(args).not.toContain("/tmp/inst_abc.ttf");
	});
});

describe("repair subtitle compression", () => {
	const planWith = (compression: "auto" | "zlib" | "none" | "preserve") =>
		sanitizeRepairPlan({
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
					compression,
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
					order: 1,
					title: "Signs & Songs",
					language: "eng",
					compression,
					isDefault: false,
					isForced: true,
					isEnabled: true,
					isHearingImpaired: false,
					isOriginal: false,
					isCommentary: false,
				},
			],
		});

	test("keeps auto as a distinct choice through sanitization", () => {
		expect(planWith("auto").tracks.map((track) => track.compression)).toEqual(["auto", "auto"]);
	});

	test("compresses only the tracks the probe found worth compressing", () => {
		const plan = planWith("auto");
		applyAutoCompression(
			plan,
			new Map([
				["source:5", false], // dialogue grew under zlib
				["target:3", true],
			]),
		);

		expect(plan.tracks.map((track) => track.compression)).toEqual(["none", "zlib"]);
	});

	test("leaves a track uncompressed when the probe produced no answer", () => {
		const plan = planWith("auto");
		applyAutoCompression(plan, new Map());

		expect(plan.tracks.every((track) => track.compression === "none")).toBe(true);
	});

	test("never overrides an explicit choice", () => {
		const explicit = planWith("zlib");
		applyAutoCompression(explicit, new Map([["source:5", false]]));

		expect(explicit.tracks.every((track) => track.compression === "zlib")).toBe(true);
	});

	test("does not take the metadata-only shortcut while compression is unresolved", () => {
		const target = {
			tracks: [
				{ id: 3, type: "subtitles", codec: "SubStationAlpha", properties: { codec_id: "S_TEXT/ASS" } },
				{ id: 5, type: "subtitles", codec: "SubStationAlpha", properties: { codec_id: "S_TEXT/ASS" } },
			],
		};
		const plan = planWith("auto");
		plan.tracks = plan.tracks.map((track) => ({ ...track, source: "target" as const, mode: "copy" as const }));
		plan.tracks[0]!.trackId = 3;
		plan.tracks[1]!.trackId = 5;

		expect(isMetadataOnlyRepair(plan, target)).toBe(false);
	});

	test("an unresolved auto track is muxed with the compression it already had", () => {
		const plan = planWith("auto");
		const target = { tracks: [{ id: 3, type: "subtitles", codec: "SubStationAlpha", properties: { codec_id: "S_TEXT/ASS" } }] };
		const source = {
			tracks: [{ id: 5, type: "subtitles", codec: "SubStationAlpha", properties: { codec_id: "S_TEXT/ASS", content_encoding_algorithms: "0" } }],
		};
		const args = buildRepairMkvmergeArgs({
			outputPath: "/tmp/out.mkv",
			plan,
			target,
			source,
			prepared: [{ plan: plan.tracks[0]!, path: "/tmp/source_5.rabbit.ass" }],
		});

		expect(args).toContain("0:zlib"); // the source track was already zlib
		expect(args).not.toContain("0:auto");
	});
});
