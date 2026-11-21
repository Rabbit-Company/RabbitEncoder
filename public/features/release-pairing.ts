import type { ReleaseCheck, ReleaseRow } from "../types";
import { errorMessage } from "../shared/errors";

/** What the release grids share: how an episode's releases are shown, changed and checked. */

type PairedSource = ReleaseRow["sources"][number];
interface PairedRow {
	targetPath: string;
	targetName: string;
	sources: PairedSource[];
}
export type TimingCheck = { loading: boolean; results?: ReleaseCheck[]; error?: string };
/** Compares an episode's audio with its releases. */
export type FetchCheck = (options: { targetPath: string; sourcePaths: string[] }) => Promise<ReleaseCheck[]>;
/** The last release picked by hand, offered to the episodes below it. */
export type LastPick = { targetPath: string; folder: string; delta: number } | null;

const CHECK_CONCURRENCY = 2;

const escapeHtml = (value: unknown): string =>
	String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");

export const fileName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
export const folderOf = (path: string): string => path.slice(0, path.lastIndexOf("/"));
const stem = (name: string): string => name.replace(/\.mkv$/i, "");
const isDigit = (char: string | undefined): boolean => !!char && char >= "0" && char <= "9";
const signed = (n: number): string => (n < 0 ? `−${-n}` : `+${n}`);

/**
 * Each name with the text all of them share cut from both ends, so a list of
 * "[Group] Show - 01 [BD]" reads "01". A number is never cut in half.
 */
export function shortNames(names: string[]): Map<string, string> {
	const stems = names.map(stem);
	const out = new Map<string, string>();
	if (stems.length < 2) {
		names.forEach((name, i) => out.set(name, stems[i]!));
		return out;
	}
	const shortest = Math.min(...stems.map((s) => s.length));
	let prefix = 0;
	while (prefix < shortest && stems.every((s) => s[prefix] === stems[0]![prefix])) prefix++;
	let suffix = 0;
	while (suffix < shortest - prefix && stems.every((s) => s[s.length - 1 - suffix] === stems[0]![stems[0]!.length - 1 - suffix])) suffix++;
	while (prefix > 0 && isDigit(stems[0]![prefix - 1])) prefix--;
	while (suffix > 0 && isDigit(stems[0]![stems[0]!.length - suffix])) suffix--;
	names.forEach((name, i) => {
		const s = stems[i]!;
		const short = s
			.slice(prefix, s.length - suffix)
			.replace(/^[\s._-]+|[\s._-]+$/g, "")
			.trim();
		out.set(name, short || s);
	});
	return out;
}

/** The release files by folder, in the order the scan read them. */
export function filesByFolder(releaseFiles: string[]): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const path of releaseFiles) out.set(folderOf(path), [...(out.get(folderOf(path)) ?? []), path]);
	return out;
}

/** A short label for every release file, led by its folder's name when there are several folders. */
export function releaseLabels(releaseFiles: string[]): Map<string, string> {
	const folders = filesByFolder(releaseFiles);
	const out = new Map<string, string>();
	for (const [folder, files] of folders) {
		const short = shortNames(files.map(fileName));
		for (const path of files) out.set(path, `${folders.size > 1 ? `${fileName(folder)} · ` : ""}${short.get(fileName(path))}`);
	}
	return out;
}

/** The encodes each release file is paired with, for the ones paired more than once. */
function sharedReleases(rows: PairedRow[]): Map<string, string[]> {
	const byPath = new Map<string, string[]>();
	for (const row of rows) for (const s of row.sources) byPath.set(s.path, [...(byPath.get(s.path) ?? []), row.targetPath]);
	return new Map([...byPath].filter(([, targets]) => targets.length > 1));
}

export function methodLabel(method: string, offset?: number): string {
	if (method === "episode") return '<span class="repair-pair-method">Episode number</span>';
	if (method === "absolute")
		return `<span class="repair-pair-method" title="The release numbers its episodes apart from the encode">Offset ${offset === undefined ? "?" : signed(offset)}</span>`;
	if (method === "order") return '<span class="repair-pair-method repair-pair-weak">Filename order</span>';
	if (method === "manual") return '<span class="repair-pair-method">Chosen by hand</span>';
	return '<span class="repair-pair-method repair-pair-none">No match</span>';
}

/** Labels computed once per render, as every row needs them. */
export interface PairingView {
	files: Map<string, string[]>;
	labels: Map<string, string>;
	targets: Map<string, string>;
	shared: Map<string, string[]>;
}

export function pairingView(rows: PairedRow[], releaseFiles: string[]): PairingView {
	const targets = shortNames(rows.map((r) => r.targetName));
	return {
		files: filesByFolder(releaseFiles),
		labels: releaseLabels(releaseFiles),
		targets: new Map(rows.map((r) => [r.targetPath, targets.get(r.targetName) ?? r.targetName])),
		shared: sharedReleases(rows),
	};
}

/** Every paired release of a row as a list of the files of its folder, so a wrong pairing is fixed with one pick. */
export function sourcePickers(view: PairingView, row: PairedRow, rowIndex: number, disabled: boolean): string {
	return row.sources
		.map((source, index) => {
			const files = [...(view.files.get(folderOf(source.path)) ?? [])];
			if (!files.includes(source.path)) files.unshift(source.path);
			const options = files
				.map(
					(path) =>
						`<option value="${escapeHtml(path)}" title="${escapeHtml(fileName(path))}" ${path === source.path ? "selected" : ""}>${escapeHtml(view.labels.get(path) ?? fileName(path))}</option>`,
				)
				.join("");
			const others = (view.shared.get(source.path) ?? []).filter((t) => t !== row.targetPath).map((t) => view.targets.get(t) ?? fileName(t));
			const warning = others.length
				? `<div class="release-row-shared" title="${escapeHtml(others.join("\n"))}">Also paired with episode ${escapeHtml(others.join(", "))}</div>`
				: "";
			return `<div class="release-row-source release-row-source-pick">
				<select class="select-input release-source-select" data-release-source-row="${rowIndex}" data-release-source-index="${index}" title="${escapeHtml(source.path)}" aria-label="Release of ${escapeHtml(row.targetName)}" ${disabled ? "disabled" : ""}>${options}<option value="">No release</option></select>
				${methodLabel(source.method, source.offset)}
			</div>${warning}`;
		})
		.join("");
}

/** The releases of a row after one is changed from its list, and how far the pick moved within the folder. */
export function pickRelease(view: PairingView, row: PairedRow, index: number, value: string): { paths: string[]; pick: LastPick } {
	const old = row.sources[index]?.path ?? "";
	const paths = row.sources.map((s) => s.path);
	paths.splice(index, 1, ...(value ? [value] : []));
	const files = view.files.get(folderOf(old)) ?? [];
	const delta = value ? files.indexOf(value) - files.indexOf(old) : 0;
	const pick = value && files.includes(old) && files.includes(value) && delta ? { targetPath: row.targetPath, folder: folderOf(old), delta } : null;
	return { paths: [...new Set(paths)], pick };
}

export function shiftButton(pick: LastPick, row: PairedRow, rowIndex: number, rows: PairedRow[], disabled: boolean): string {
	if (!pick || pick.targetPath !== row.targetPath || rowIndex === rows.length - 1) return "";
	return `<button class="btn btn-ghost btn-sm" type="button" data-release-shift="${rowIndex}" ${disabled ? "disabled" : ""} title="Move the release of every episode below by the same number of files">Shift below ${signed(pick.delta)}</button>`;
}

/**
 * The releases of every episode below the given row, moved by the pick's
 * number of files within its folder. An episode moved past the folder's end
 * loses that release.
 */
export function shiftBelow(view: PairingView, rows: PairedRow[], rowIndex: number, pick: NonNullable<LastPick>): Map<string, string[]> {
	const files = view.files.get(pick.folder) ?? [];
	const out = new Map<string, string[]>();
	for (const row of rows.slice(rowIndex + 1)) {
		if (!row.sources.some((s) => folderOf(s.path) === pick.folder)) continue;
		const paths = row.sources.flatMap((s) => {
			if (folderOf(s.path) !== pick.folder) return [s.path];
			const next = files[files.indexOf(s.path) + pick.delta];
			return files.includes(s.path) && next ? [next] : [];
		});
		out.set(row.targetPath, [...new Set(paths)]);
	}
	return out;
}

/** The bar above the grid: checking every episode's timing, and how many did not match. */
export function checkAllHtml(rows: PairedRow[], checks: Map<string, TimingCheck>): string {
	const paired = rows.filter((r) => r.sources.length);
	if (!paired.length) return "";
	const done = paired.map((r) => checks.get(r.targetPath)).filter((c) => c && !c.loading);
	const running = paired.some((r) => checks.get(r.targetPath)?.loading);
	const failed = done.filter((c) => c!.error || c!.results?.some((r) => !r.matched)).length;
	const status = running
		? `Comparing the audio, ${done.length} of ${paired.length} done`
		: done.length
			? `${done.length} of ${paired.length} checked${failed ? `, <span class="repair-pair-none">${failed} did not match</span>` : ", all matched"}`
			: "";
	return `<div class="release-check-all">
		<button class="btn btn-ghost btn-sm" type="button" data-release-check-all ${running ? "disabled" : ""} title="Compare the audio of every episode with its releases, a few at a time">Check timing of all</button>
		<span>${status}</span>
	</div>`;
}

export async function checkTiming(row: PairedRow, checks: Map<string, TimingCheck>, fetchCheck: FetchCheck): Promise<void> {
	checks.set(row.targetPath, { loading: true });
	try {
		checks.set(row.targetPath, {
			loading: false,
			results: await fetchCheck({ targetPath: row.targetPath, sourcePaths: row.sources.map((s) => s.path) }),
		});
	} catch (error) {
		checks.set(row.targetPath, { loading: false, error: errorMessage(error) });
	}
}

/** Checks the timing of every paired episode, a few at a time, rendering as each finishes. */
export async function checkAllTiming(rows: PairedRow[], checks: Map<string, TimingCheck>, fetchCheck: FetchCheck, render: () => void): Promise<void> {
	const queue = rows.filter((r) => r.sources.length);
	for (const row of queue) checks.set(row.targetPath, { loading: true });
	render();
	await Promise.all(
		Array.from({ length: CHECK_CONCURRENCY }, async () => {
			for (let row = queue.shift(); row; row = queue.shift()) {
				await checkTiming(row, checks, fetchCheck);
				render();
			}
		}),
	);
}
