import { readFileSync, writeFileSync } from "fs";

interface Segment {
	start: bigint;
	end: bigint;
	lines: string[];
}

/** Film grain tables count time in 100 ns ticks. */
const TICKS_PER_SECOND = 10_000_000;
const OPEN_END = 18446744073709551615n;

function parseTable(path: string): Segment[] {
	const lines = readFileSync(path, "utf8").split(/\r?\n/);
	if (lines.shift() !== "filmgrn1") throw new Error(`Invalid AV1 film grain table: ${path}`);
	const segments: Segment[] = [];
	for (const line of lines) {
		if (line.startsWith("E ")) {
			const fields = line.split(/\s+/);
			if (fields.length < 6) throw new Error(`Invalid AV1 film grain segment: ${path}`);
			const start = BigInt(fields[1]!);
			const end = BigInt(fields[2]!);
			if (end <= start) throw new Error(`Invalid AV1 film grain timestamps: ${path}`);
			segments.push({ start, end, lines: [line] });
		} else if (segments.length > 0) {
			segments[segments.length - 1]!.lines.push(line);
		}
	}
	if (segments.length === 0) throw new Error(`Film grain table has no segments: ${path}`);
	return segments;
}

function formatSegment(segment: Segment, start: bigint, end: bigint): string {
	const fields = segment.lines[0]!.split(/\s+/);
	fields[1] = String(start);
	fields[2] = String(end);
	return `${fields.join(" ")}\n${segment.lines.slice(1).join("\n").trimEnd()}\n`;
}

export function filmGrainSegmentCount(path: string): number {
	return parseTable(path).length;
}

/**
 * A table measured on a short window says nothing about when the rest of the video's scenes
 * start. Keep its middle segment and stretch it over the whole video.
 */
export function writeRepresentativeFilmGrainTable(sourcePath: string, outputPath: string): number {
	const segments = parseTable(sourcePath);
	const representative = segments[Math.floor(segments.length / 2)]!;
	writeFileSync(outputPath, `filmgrn1\n${formatSegment(representative, 0n, OPEN_END)}`);
	return segments.length;
}

/**
 * Write the table grav1synth applies to the encode, with every segment on the encode's timeline.
 * A preview clip starts `clipStartSeconds` into the video, so its segments move back by that much.
 * The last segment is left open so trailing frames never end up without grain.
 */
export function writeEncoderFilmGrainTable(sourcePath: string, outputPath: string, clipStartSeconds = 0): number {
	const segments = parseTable(sourcePath);
	const shift = BigInt(Math.max(0, Math.round(clipStartSeconds * TICKS_PER_SECOND)));
	const last = segments.length - 1;
	let table = "filmgrn1\n";
	segments.forEach((segment, i) => {
		const end = i === last ? OPEN_END : segment.end - shift;
		if (end <= 0n) return;
		const start = segment.start > shift ? segment.start - shift : 0n;
		table += formatSegment(segment, start, end);
	});
	writeFileSync(outputPath, table);
	return segments.length;
}
