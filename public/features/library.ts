import type { LibraryEntry, LibraryNode } from "../ui/models";
import { authFetch, fetchConfig, fetchJobs } from "../api/client";
import { API } from "../config/api-base";
import { escapeHtml } from "./job-render";
import {
	createTreeNode,
	isPathInside,
	onLibrarySearchScopeChanged,
	refreshLibraryQueuedPaths,
	renderLibraryView,
	updateLibrarySearchPlaceholder,
} from "./library-search";
import { update } from "./polling";
import { buttonById, byId, inputById } from "../shared/dom";
import { appState } from "../state";

/**
 * In translate-only mode, already-encoded files are the primary target
 * (backfilling subtitle languages into previous output), so they stay
 * selectable. In every other mode they are shown but excluded, matching the
 * server-side skip in scanLibraryPath/scanLibraryFolder — the gate on both
 * sides is the DEFAULT pipeline mode, since queued jobs start from defaults.
 */
function encodedSelectable(): boolean {
	return appState.defaults?.subtitleProcessing === "translate";
}

export async function fetchLibraryDirs() {
	const res = await authFetch(`${API}/api/library`);
	const data = await res.json();
	return data.dirs || [];
}

export async function fetchLibraryBrowse(path?: string | null): Promise<{ entries: LibraryEntry[] }> {
	const res = await authFetch(`${API}/api/library/browse?path=${encodeURIComponent(path ?? "")}`);
	return res.json();
}

export async function postLibraryEncodePaths(paths: string[]): Promise<{ added: number; skipped: number; alreadyEncoded: number }> {
	const res = await authFetch(`${API}/api/library/encode`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ paths }),
	});
	return res.json();
}

export function humanFileSize(bytes: number): string {
	if (!bytes) return "";
	const units = ["B", "KiB", "MiB", "GiB", "TiB"];
	let i = 0;
	let val = bytes;
	while (val >= 1024 && i < units.length - 1) {
		val /= 1024;
		i++;
	}
	return `${val.toFixed(1)} ${units[i]}`;
}

export function setNodeChecked(path: string, checked: boolean): void {
	const node = appState.libraryNodes.get(path);
	if (!node) return;
	if (node.type === "file" && node.queued) {
		node.checked = false;
		return;
	}
	node.checked = checked;
	if (node.type === "directory" && node.children) {
		for (const childPath of node.children) setNodeChecked(childPath, checked);
	}
}

export function getNodeCheckState(path: string): { checked: boolean; indeterminate: boolean } {
	const node = appState.libraryNodes.get(path);
	if (!node) return { checked: false, indeterminate: false };
	if (node.type === "file") return { checked: node.checked, indeterminate: false };
	if (!node.children || node.children.length === 0) return { checked: node.checked, indeterminate: false };

	let checkedCount = 0;
	let totalCount = 0;
	let hasIndeterminate = false;
	for (const childPath of node.children) {
		const s = getNodeCheckState(childPath);
		totalCount++;
		if (s.checked) checkedCount++;
		if (s.indeterminate) hasIndeterminate = true;
	}
	if (hasIndeterminate || (checkedCount > 0 && checkedCount < totalCount)) {
		return { checked: false, indeterminate: true };
	}
	return { checked: checkedCount === totalCount && totalCount > 0, indeterminate: false };
}

export function updateParentCheckState(path: string | null): void {
	if (!path) return;
	const node = appState.libraryNodes.get(path);
	if (!node || !node.parentPath) return;
	const parent = appState.libraryNodes.get(node.parentPath);
	if (!parent || !parent.children) return;
	const state = getNodeCheckState(parent.path);
	parent.checked = state.checked;
	updateParentCheckState(parent.path);
}

export function toggleNodeCheck(path: string): void {
	const node = appState.libraryNodes.get(path);
	if (node && node.type === "file" && node.queued) return;
	const state = getNodeCheckState(path);
	const newChecked = !(state.checked || state.indeterminate);
	setNodeChecked(path, newChecked);
	updateParentCheckState(path);
	renderLibraryView();
	updateLibraryFooter();
}

export async function toggleNodeExpand(path: string): Promise<void> {
	const node = appState.libraryNodes.get(path);
	if (!node || node.type !== "directory") return;

	if (node.expanded) {
		node.expanded = false;
		if (appState.librarySearchScope && isPathInside(appState.librarySearchScope, node.path)) {
			appState.librarySearchScope = node.parentPath || null;
			onLibrarySearchScopeChanged();
		}
		renderLibraryTree();
		return;
	}

	if (node.children === null) {
		node.loading = true;
		renderLibraryTree();
		try {
			const data = await fetchLibraryBrowse(node.path);
			const entries = data.entries || [];
			node.children = [];
			for (const entry of entries) {
				const child = createTreeNode(entry, node.depth + 1, node.path);
				if (node.checked) child.checked = true;
				appState.libraryNodes.set(child.path, child);
				node.children.push(child.path);
			}
		} catch {
			node.children = [];
		}
		node.loading = false;
	}

	node.expanded = true;
	appState.librarySearchScope = node.path;
	onLibrarySearchScopeChanged();
	renderLibraryTree();
}

export function getCheckedPaths(): string[] {
	const paths: string[] = [];
	const includeEncoded = encodedSelectable();
	function collect(path: string): void {
		const node = appState.libraryNodes.get(path);
		if (!node) return;
		if (node.type === "file") {
			if (node.checked && (includeEncoded || !node.encoded)) paths.push(node.path);
			return;
		}
		const state = getNodeCheckState(path);
		if (state.checked) {
			paths.push(node.path);
			return;
		}
		if (state.indeterminate && node.children) {
			for (const childPath of node.children) collect(childPath);
		}
	}
	for (const dir of appState.libraryDirs) {
		const root = appState.libraryNodes.get(dir.path);
		if (root) collect(root.path);
	}
	return paths;
}

export function countSelectedToEncode(): number {
	let total = 0;
	const includeEncoded = encodedSelectable();
	function count(path: string): void {
		const node = appState.libraryNodes.get(path);
		if (!node) return;
		if (node.type === "file") {
			if (node.checked && (includeEncoded || !node.encoded)) total++;
			return;
		}
		const state = getNodeCheckState(path);
		if (state.checked) {
			total += includeEncoded ? node.videoCount || 0 : (node.videoCount || 0) - (node.encodedCount || 0);
			return;
		}
		if (state.indeterminate && node.children) {
			for (const childPath of node.children) count(childPath);
		}
	}
	for (const dir of appState.libraryDirs) {
		const root = appState.libraryNodes.get(dir.path);
		if (root) count(root.path);
	}
	return total;
}

export function renderLibraryTree() {
	const content = byId("library-content");
	if (appState.libraryDirs.length === 0) {
		content.innerHTML = `<div class="library-empty">No library directories configured.<br>Set <code>LIBRARY_DIRS</code> in your docker-compose.yml</div>`;
		return;
	}
	let html = "";
	for (const dir of appState.libraryDirs) {
		const node = appState.libraryNodes.get(dir.path);
		if (node) html += renderTreeNode(node);
	}
	content.innerHTML = html || `<div class="library-empty">No library directories configured</div>`;
}

export function renderTreeNode(node: LibraryNode): string {
	const isDir = node.type === "directory";
	const state = getNodeCheckState(node.path);
	const indent = node.depth * 24;

	if (isDir) {
		return renderTreeFolder(node, state.checked, state.indeterminate, indent);
	}
	return renderTreeFile(node, indent);
}

export function renderTreeFolder(node: LibraryNode, checked: boolean, indeterminate: boolean, indent: number): string {
	const chevronClass = node.expanded ? "expanded" : "";
	const encodedClass = node.videoCount > 0 && node.videoCount === node.encodedCount ? " is-encoded" : "";
	const pending = encodedSelectable() ? node.videoCount || 0 : (node.videoCount || 0) - (node.encodedCount || 0);
	const actionWord = encodedSelectable() ? "to translate" : "to encode";

	let metaParts = [];
	if (node.videoCount > 0 && node.videoCount === node.encodedCount) metaParts.push(`<span class="library-encoded-badge">encoded</span>`);
	if (pending > 0) metaParts.push(`${pending} ${actionWord}`);
	if (node.videoCount > 0) metaParts.push(`${node.videoCount} video${node.videoCount !== 1 ? "s" : ""}`);

	let childrenHtml = "";
	if (node.expanded && node.children) {
		if (node.children.length === 0) {
			childrenHtml = `<div class="tree-empty" style="padding-left:${indent + 56}px">Empty folder</div>`;
		} else {
			for (const childPath of node.children) {
				const child = appState.libraryNodes.get(childPath);
				if (child) childrenHtml += renderTreeNode(child);
			}
		}
	}
	if (node.loading) {
		childrenHtml = `<div class="tree-loading" style="padding-left:${indent + 56}px">Loading...</div>`;
	}

	const cbHtml = renderCheckbox(node.path, checked, indeterminate);
	return `
		<div class="tree-node tree-folder${encodedClass}">
			<div class="tree-row" style="padding-left:${indent}px">
				<button class="tree-chevron ${chevronClass}" data-action="expand" data-path="${escapeHtml(node.path)}">
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
				</button>
				${cbHtml}
				<svg class="tree-icon tree-icon-folder" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
					<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
				</svg>
				<span class="tree-name" data-action="expand" data-path="${escapeHtml(node.path)}" title="${escapeHtml(node.name)}">${escapeHtml(node.name)}</span>
				<span class="tree-meta">${metaParts.join(", ")}</span>
			</div>
			${childrenHtml}
		</div>`;
}

export function renderTreeFile(node: LibraryNode, indent: number): string {
	const encodedClass = node.encoded && !encodedSelectable() ? " is-encoded" : "";
	const cbHtml = node.queued ? `<span class="tree-checkbox is-queued" title="Already in the queue"></span>` : renderCheckbox(node.path, node.checked, false);
	let metaParts = [];
	if (node.queued) metaParts.push(`<span class="library-queued-badge">queued</span>`);
	if (node.encoded) metaParts.push(`<span class="library-encoded-badge">encoded</span>`);
	if (node.size) metaParts.push(humanFileSize(node.size));

	return `
		<div class="tree-node tree-file${encodedClass}${node.queued ? " is-queued" : ""}">
			<div class="tree-row" style="padding-left:${indent + 24}px">
				${cbHtml}
				<svg class="tree-icon tree-icon-file" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
					<polygon points="23 7 16 12 23 17 23 7"/>
					<rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
				</svg>
				<span class="tree-name tree-name-file" title="${escapeHtml(node.name)}">${escapeHtml(node.name)}</span>
				<span class="tree-meta">${metaParts.join(", ")}</span>
			</div>
		</div>`;
}

export function renderCheckbox(path: string, checked: boolean, indeterminate: boolean): string {
	const cls = checked ? "checked" : indeterminate ? "indeterminate" : "";
	const icon = checked
		? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>`
		: indeterminate
			? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="5" y1="12" x2="19" y2="12"/></svg>`
			: "";
	return `<button class="tree-checkbox ${cls}" data-action="check" data-path="${escapeHtml(path)}">${icon}</button>`;
}

export function updateLibraryFooter() {
	const note = byId("library-note");
	const encodeBtn = buttonById("library-encode-btn");
	const count = countSelectedToEncode();
	const action = encodedSelectable() ? "translation" : "encoding";
	if (count > 0) {
		note.textContent = `${count} file${count !== 1 ? "s" : ""} selected for ${action}`;
		encodeBtn.disabled = false;
	} else {
		note.textContent = `Select folders or files to ${encodedSelectable() ? "translate" : "encode"}`;
		encodeBtn.disabled = true;
	}
}
export async function openLibrary() {
	const modal = byId("library-modal");
	const content = byId("library-content");
	const note = byId("library-note");
	const encodeBtn = buttonById("library-encode-btn");
	content.innerHTML = `<div class="library-loading">Loading library...</div>`;
	note.textContent = "";
	encodeBtn.disabled = true;
	modal.style.display = "";

	try {
		if (!appState.defaults) {
			try {
				appState.defaults = await fetchConfig();
			} catch {}
		}

		appState.libraryDirs = await fetchLibraryDirs();
		if (appState.libraryDirs.length === 0) {
			content.innerHTML = `<div class="library-empty">No library directories configured.<br>Set <code>LIBRARY_DIRS</code> in your docker-compose.yml</div>`;
			return;
		}
		appState.libraryNodes.clear();
		try {
			refreshLibraryQueuedPaths(await fetchJobs());
		} catch {}

		appState.librarySearchScope = null;
		appState.librarySearchQuery = "";
		const searchInput = inputById("library-search");
		searchInput.value = "";
		updateLibrarySearchPlaceholder();

		for (const dir of appState.libraryDirs) {
			const rootNode = createTreeNode({ path: dir.path, name: dir.name, type: "directory", videoCount: 0, encodedCount: 0 }, 0, null);
			appState.libraryNodes.set(dir.path, rootNode);
		}
		renderLibraryTree();
		updateLibraryFooter();
	} catch {
		content.innerHTML = `<div class="library-empty">Failed to load library</div>`;
	}
}

export function closeLibrary() {
	byId("library-modal").style.display = "none";
}

export function closeLibraryIfOutside(e: MouseEvent): void {
	if (e.target === e.currentTarget) closeLibrary();
}

export async function handleLibraryEncode() {
	const paths = getCheckedPaths();
	if (paths.length === 0) return;

	const encodeBtn = buttonById("library-encode-btn");
	encodeBtn.disabled = true;
	encodeBtn.textContent = "Starting...";

	try {
		const result = await postLibraryEncodePaths(paths);
		const note = byId("library-note");
		const parts: string[] = [];
		if (result.added > 0) parts.push(`Queued ${result.added} file${result.added !== 1 ? "s" : ""}`);
		if (result.skipped > 0) parts.push(`${result.skipped} already queued`);
		if (result.alreadyEncoded > 0) parts.push(`${result.alreadyEncoded} already encoded`);
		if (parts.length === 0) parts.push("No video files found to encode");
		note.textContent = parts.join(", ");

		if (result.added > 0) {
			closeLibrary();
			update();
		}
	} catch {
		byId("library-note").textContent = "Failed to start encoding";
	} finally {
		encodeBtn.textContent = "Encode Selected";
		encodeBtn.disabled = getCheckedPaths().length === 0;
	}
}
