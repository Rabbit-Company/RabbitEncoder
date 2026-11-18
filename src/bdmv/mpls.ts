/**
 * Blu-ray movie playlists (BDMV/PLAYLIST/*.mpls). A playlist is a list of play
 * items, each a range of one clip (STREAM/<clip>.m2ts), and a list of marks,
 * the chapters. Times are in 45 kHz ticks.
 */

export const MPLS_CLOCK = 45_000;

export interface MplsStream {
	codingType: number;
	/** ISO 639-2 code, empty for video. */
	language: string;
}

export interface MplsPlayItem {
	/** Clip number as written, "00003". */
	clip: string;
	inTime: number;
	outTime: number;
	multiAngle: boolean;
	video: MplsStream[];
	audio: MplsStream[];
	subtitles: MplsStream[];
}

export interface MplsMark {
	/** 1 is a chapter, 2 a link point. */
	type: number;
	playItem: number;
	time: number;
}

export interface Mpls {
	items: MplsPlayItem[];
	marks: MplsMark[];
}

function text(buf: Buffer, at: number, length: number): string {
	return buf.toString("latin1", at, at + length).replace(/\0+$/, "");
}

function readStream(buf: Buffer, at: number): { stream: MplsStream; next: number } {
	const entryLength = buf.readUInt8(at);
	const attrAt = at + 1 + entryLength;
	const attrLength = buf.readUInt8(attrAt);
	const codingType = buf.readUInt8(attrAt + 1);
	let language = "";
	if ([0x03, 0x04, 0xa1, 0xa2].includes(codingType) || (codingType >= 0x80 && codingType <= 0x86)) language = text(buf, attrAt + 3, 3);
	else if (codingType === 0x90 || codingType === 0x91) language = text(buf, attrAt + 2, 3);
	else if (codingType === 0x92) language = text(buf, attrAt + 3, 3);
	return { stream: { codingType, language: /^[a-z]{3}$/.test(language) ? language : "" }, next: attrAt + 1 + attrLength };
}

function readPlayItem(buf: Buffer, at: number): { item: MplsPlayItem; next: number } {
	const length = buf.readUInt16BE(at);
	const start = at + 2;
	const clip = text(buf, start, 5);
	const flags = buf.readUInt16BE(start + 9);
	const multiAngle = (flags & 0x10) !== 0;
	const inTime = buf.readUInt32BE(start + 12);
	const outTime = buf.readUInt32BE(start + 16);
	let p = start + 32;
	if (multiAngle) {
		const angles = buf.readUInt8(p);
		p += 2 + Math.max(0, angles - 1) * 10;
	}
	const item: MplsPlayItem = { clip, inTime, outTime, multiAngle, video: [], audio: [], subtitles: [] };
	// The stream table only tells the languages. A playlist that hides it is still usable.
	try {
		const counts = p + 4;
		const [video, audio, pg] = [buf.readUInt8(counts), buf.readUInt8(counts + 1), buf.readUInt8(counts + 2)];
		let s = p + 16;
		for (const [list, count] of [
			[item.video, video],
			[item.audio, audio],
			[item.subtitles, pg],
		] as const) {
			for (let i = 0; i < count; i++) {
				const { stream, next } = readStream(buf, s);
				list.push(stream);
				s = next;
			}
		}
	} catch {}
	return { item, next: start + length };
}

export function parseMpls(buf: Buffer): Mpls {
	if (buf.length < 40 || text(buf, 0, 4) !== "MPLS") throw new Error("Not a Blu-ray playlist");
	const listAt = buf.readUInt32BE(8);
	const markAt = buf.readUInt32BE(12);

	const count = buf.readUInt16BE(listAt + 6);
	const items: MplsPlayItem[] = [];
	let p = listAt + 10;
	for (let i = 0; i < count; i++) {
		const { item, next } = readPlayItem(buf, p);
		items.push(item);
		p = next;
	}

	const marks: MplsMark[] = [];
	const markCount = buf.readUInt16BE(markAt + 4);
	for (let i = 0; i < markCount; i++) {
		const m = markAt + 6 + i * 14;
		marks.push({ type: buf.readUInt8(m + 1), playItem: buf.readUInt16BE(m + 2), time: buf.readUInt32BE(m + 4) });
	}
	return { items, marks };
}

export interface PlaylistTimeline {
	/** Seconds. */
	duration: number;
	/** Start of each play item on the playlist's timeline, in seconds. */
	itemStarts: number[];
	/** Chapter starts on the playlist's timeline, in seconds, sorted and without duplicates. */
	chapters: number[];
}

export function playlistTimeline(mpls: Mpls): PlaylistTimeline {
	const itemStarts: number[] = [];
	let total = 0;
	for (const item of mpls.items) {
		itemStarts.push(total / MPLS_CLOCK);
		total += Math.max(0, item.outTime - item.inTime);
	}
	const chapters = new Set<number>();
	for (const mark of mpls.marks) {
		const item = mpls.items[mark.playItem];
		if (mark.type !== 1 || !item) continue;
		const offset = Math.min(Math.max(0, mark.time - item.inTime), item.outTime - item.inTime);
		chapters.add(Math.round((itemStarts[mark.playItem]! + offset / MPLS_CLOCK) * 1000) / 1000);
	}
	return { duration: total / MPLS_CLOCK, itemStarts, chapters: [...chapters].sort((a, b) => a - b) };
}
