import { existsSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { Logger } from "../core/logger";
import { findDiscFolders, groupDiscSets, streamBytes } from "./disc";

/**
 * Blu-ray disc sets copied into the input folder. They are never encoded on
 * their own: the dashboard offers each one for review once its files stop
 * growing, until it is queued or dismissed.
 */

export interface DetectedDiscSet {
	path: string;
	name: string;
	discs: number;
	bytes: number;
}

type Handled = "queued" | "dismissed";

const seen = new Map<string, { discs: string[]; bytes: number; changedAt: number }>();
let handled: Record<string, Handled> = {};
let stateFile = "";

export function initDiscWatch(tempDir: string): void {
	stateFile = join(tempDir, "discs.json");
	try {
		if (!existsSync(stateFile)) return;
		const raw = JSON.parse(readFileSync(stateFile, "utf-8"));
		if (raw && typeof raw === "object")
			handled = Object.fromEntries(Object.entries(raw).filter(([path, state]) => (state === "queued" || state === "dismissed") && existsSync(path))) as Record<
				string,
				Handled
			>;
	} catch (error: any) {
		Logger.warn(`[discs] Could not read ${stateFile}: ${error?.message}`);
	}
}

function save(): void {
	if (!stateFile) return;
	try {
		writeFileSync(stateFile, JSON.stringify(handled));
	} catch (error: any) {
		Logger.warn(`[discs] Could not save ${stateFile}: ${error?.message}`);
	}
}

export function scanInputDiscs(input: string, now = Date.now()): void {
	let inputDir: string;
	try {
		inputDir = realpathSync(input);
	} catch {
		return;
	}
	const sets = groupDiscSets(findDiscFolders(inputDir), [inputDir]);
	const present = new Set<string>();
	for (const set of sets) {
		present.add(set.path);
		if (handled[set.path]) continue;
		const bytes = set.discs.reduce((sum, disc) => sum + streamBytes(disc), 0);
		const before = seen.get(set.path);
		if (!before) Logger.info(`[discs] Found Blu-ray disc set ${basename(set.path)} with ${set.discs.length} disc(s)`);
		if (!before || before.bytes !== bytes || before.discs.length !== set.discs.length) seen.set(set.path, { discs: set.discs, bytes, changedAt: now });
	}
	for (const path of seen.keys()) if (!present.has(path)) seen.delete(path);
}

/** Sets whose files have not changed for `cooldownSec`, and that were neither queued nor dismissed. */
export function detectedDiscSets(cooldownSec: number, now = Date.now()): DetectedDiscSet[] {
	return [...seen.entries()]
		.filter(([path, set]) => !handled[path] && now - set.changedAt >= cooldownSec * 1000 && set.bytes > 0)
		.map(([path, set]) => ({ path, name: basename(path), discs: set.discs.length, bytes: set.bytes }));
}

export function markDiscSet(path: string, state: Handled): void {
	handled[path] = state;
	seen.delete(path);
	save();
}
