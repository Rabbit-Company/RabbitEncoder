/** Writes Blu-ray playlists in the layout of the BD-ROM spec, for tests. */

export const TICKS = 45_000;

export interface BuildItem {
	clip: string;
	/** Seconds on the clip's own clock. */
	in: number;
	out: number;
	audio?: string[];
	subtitles?: string[];
	angles?: number;
}

export interface BuildMark {
	item: number;
	/** Seconds on the clip's own clock. */
	at: number;
	type?: number;
}

const u8 = (n: number) => Buffer.from([n & 0xff]);
const u16 = (n: number) => {
	const b = Buffer.alloc(2);
	b.writeUInt16BE(n);
	return b;
};
const u32 = (n: number) => {
	const b = Buffer.alloc(4);
	b.writeUInt32BE(n >>> 0);
	return b;
};
const ascii = (s: string) => Buffer.from(s, "latin1");

function stream(codingType: number, language?: string): Buffer {
	const entry = Buffer.concat([u8(0x01), u16(0x1011), Buffer.alloc(6)]);
	let attr: Buffer;
	if (codingType === 0x1b) attr = Buffer.concat([u8(codingType), u8(0x63), Buffer.alloc(3)]);
	else if (codingType === 0x90) attr = Buffer.concat([u8(codingType), ascii(language ?? "und"), Buffer.alloc(1)]);
	else attr = Buffer.concat([u8(codingType), u8(0x31), ascii(language ?? "und")]);
	return Buffer.concat([u8(entry.length), entry, u8(attr.length), attr]);
}

function playItem(item: BuildItem): Buffer {
	const angles = item.angles ?? 1;
	const audio = item.audio ?? ["jpn"];
	const subs = item.subtitles ?? [];
	const streams = Buffer.concat([stream(0x1b), ...audio.map((l) => stream(0x80, l)), ...subs.map((l) => stream(0x90, l))]);
	const stnBody = Buffer.concat([u16(0), u8(1), u8(audio.length), u8(subs.length), Buffer.alloc(9), streams]);
	const stn = Buffer.concat([u16(stnBody.length), stnBody]);
	const body = Buffer.concat([
		ascii(item.clip),
		ascii("M2TS"),
		u16((angles > 1 ? 0x10 : 0) | 0x01),
		u8(0),
		u32(Math.round(item.in * TICKS)),
		u32(Math.round(item.out * TICKS)),
		Buffer.alloc(8),
		u8(0x80),
		u8(0),
		u16(0),
		...(angles > 1 ? [u8(angles), u8(0), ...Array.from({ length: angles - 1 }, () => Buffer.concat([ascii(item.clip), ascii("M2TS"), u8(0)]))] : []),
		stn,
	]);
	return Buffer.concat([u16(body.length), body]);
}

export function buildMpls(items: BuildItem[], marks: BuildMark[] = []): Buffer {
	const header = 40;
	const appInfo = Buffer.concat([u32(14), Buffer.alloc(14)]);
	const listBody = Buffer.concat([u16(0), u16(items.length), u16(0), ...items.map(playItem)]);
	const list = Buffer.concat([u32(listBody.length), listBody]);
	const markBody = Buffer.concat([
		u16(marks.length),
		...marks.map((m) => Buffer.concat([u8(0), u8(m.type ?? 1), u16(m.item), u32(Math.round(m.at * TICKS)), u16(0xffff), u32(0)])),
	]);
	const markSection = Buffer.concat([u32(markBody.length), markBody]);
	const listAt = header + appInfo.length;
	const markAt = listAt + list.length;
	const head = Buffer.concat([ascii("MPLS"), ascii("0200"), u32(listAt), u32(markAt), u32(0), Buffer.alloc(20)]);
	return Buffer.concat([head, appInfo, list, markSection]);
}
