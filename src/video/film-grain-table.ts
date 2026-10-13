import { readFileSync, writeFileSync } from "fs";

interface Segment {
	start: bigint;
	end: bigint;
	lines: string[];
}

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

export function filmGrainSegmentCount(path: string): number {
	return parseTable(path).length;
}

/** SVT-AV1 currently accepts one table for an entire encode. Use the middle measured segment. */
export function writeEncoderFilmGrainTable(sourcePath: string, outputPath: string): number {
	const segments = parseTable(sourcePath);
	const representative = segments[Math.floor(segments.length / 2)]!;
	const fields = representative.lines[0]!.split(/\s+/);
	fields[1] = "0";
	fields[2] = "18446744073709551615";
	writeFileSync(outputPath, `filmgrn1\n${fields.join(" ")}\n${representative.lines.slice(1).join("\n").trimEnd()}\n`);
	return segments.length;
}
