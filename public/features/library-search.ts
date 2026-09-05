import type { Job, JobSettings } from "../types";
import type { LibraryEntry, LibraryNode } from "../ui/models";
import { escapeHtml } from "./job-render";
import { getNodeCheckState, humanFileSize, renderCheckbox, renderLibraryTree, toggleNodeExpand } from "./library";
import { byId, inputById, isDefined } from "../shared/dom";
import { appState } from "../state";

export function refreshLibraryQueuedPaths(jobs: Job[]): void {
	appState.libraryQueuedPaths = new Set((jobs || []).filter((j) => j.inputPath && j.status !== "done" && j.status !== "error").map((j) => j.inputPath));
}

export function isPathInside(child: string, parent: string): boolean {
	if (!child || !parent) return false;
	return child === parent || child.startsWith(parent.endsWith("/") ? parent : parent + "/");
}

export function libraryScopeName() {
	if (!appState.librarySearchScope) return appState.libraryDirs.length === 1 ? appState.libraryDirs[0]!.name : null;
	const node = appState.libraryNodes.get(appState.librarySearchScope);
	return node ? node.name : appState.librarySearchScope.split("/").filter(Boolean).pop();
}

export function updateLibrarySearchPlaceholder() {
	const input = inputById("library-search");
	const name = libraryScopeName();
	input.placeholder = name ? `Search in "${name}"...` : "Search library folders...";
}

export function onLibrarySearchScopeChanged() {
	updateLibrarySearchPlaceholder();
	if (appState.librarySearchQuery.trim()) runLibrarySearch();
}

export function renderLibraryView() {
	if (appState.librarySearchQuery.trim()) runLibrarySearch();
	else renderLibraryTree();
}

export function getLibraryScopeChildren(): LibraryNode[] {
	if (appState.librarySearchScope) {
		const node = appState.libraryNodes.get(appState.librarySearchScope);
		if (node && node.children) return node.children.map((p) => appState.libraryNodes.get(p)).filter(isDefined);
		return [];
	}
	return appState.libraryDirs.map((d) => appState.libraryNodes.get(d.path)).filter(isDefined);
}

export function runLibrarySearch() {
	const query = appState.librarySearchQuery.trim().toLowerCase();
	if (!query) {
		renderLibraryTree();
		return;
	}
	const matches = getLibraryScopeChildren()
		.filter((n) => n.name.toLowerCase().includes(query))
		.sort((a, b) => {
			if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
			return a.name.localeCompare(b.name, undefined, { numeric: true });
		});
	renderLibrarySearchResults(matches);
}

export function renderLibrarySearchResults(nodes: LibraryNode[]): void {
	const content = byId("library-content");
	const scopeName = libraryScopeName();
	const header = `<div class="library-search-scope">${
		scopeName ? `In <strong>${escapeHtml(scopeName)}</strong>` : "Library folders"
	} · ${nodes.length} match${nodes.length !== 1 ? "es" : ""}</div>`;

	if (nodes.length === 0) {
		content.innerHTML = header + `<div class="library-empty">No matches in this folder</div>`;
		return;
	}

	let rows = "";
	for (const node of nodes) {
		if (node.type === "directory") {
			const state = getNodeCheckState(node.path);
			const pending = (node.videoCount || 0) - (node.encodedCount || 0);
			const meta = [];
			if (node.videoCount > 0 && pending === 0) meta.push(`<span class="library-encoded-badge">encoded</span>`);
			if (pending > 0) meta.push(`${pending} to encode`);
			rows += `
				<div class="tree-node tree-folder search-result">
					<div class="tree-row" style="padding-left:16px">
						${renderCheckbox(node.path, state.checked, state.indeterminate)}
						<svg class="tree-icon tree-icon-folder" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
						<span class="tree-name" data-action="search-open" data-path="${escapeHtml(node.path)}" title="${escapeHtml(node.name)}">${escapeHtml(node.name)}</span>
						<span class="tree-meta">${meta.join(" · ")}</span>
					</div>
				</div>`;
		} else {
			const cb = node.queued ? `<span class="tree-checkbox is-queued" title="Already in the queue"></span>` : renderCheckbox(node.path, node.checked, false);
			const meta = [];
			if (node.queued) meta.push(`<span class="library-queued-badge">queued</span>`);
			if (node.encoded) meta.push(`<span class="library-encoded-badge">encoded</span>`);
			if (node.size) meta.push(humanFileSize(node.size));
			rows += `
				<div class="tree-node tree-file search-result${node.encoded ? " is-encoded" : ""}${node.queued ? " is-queued" : ""}">
					<div class="tree-row" style="padding-left:16px">
						${cb}
						<svg class="tree-icon tree-icon-file" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
						<span class="tree-name tree-name-file" title="${escapeHtml(node.name)}">${escapeHtml(node.name)}</span>
						<span class="tree-meta">${meta.join(" · ")}</span>
					</div>
				</div>`;
		}
	}
	content.innerHTML = header + rows;
}

export async function openFolderFromSearch(path: string): Promise<void> {
	const input = inputById("library-search");
	input.value = "";
	appState.librarySearchQuery = "";
	const clearBtn = byId("library-search-clear");
	if (clearBtn) clearBtn.style.display = "none";

	const node = appState.libraryNodes.get(path);
	if (node && !node.expanded) {
		await toggleNodeExpand(path);
	} else {
		appState.librarySearchScope = path;
		updateLibrarySearchPlaceholder();
		renderLibraryTree();
	}
	requestAnimationFrame(() => scrollLibraryNodeIntoView(path));
}

export function scrollLibraryNodeIntoView(path: string): void {
	const content = byId("library-content");
	if (!content) return;
	let target = null;
	for (const el of Array.from(content.querySelectorAll<HTMLElement>("[data-path]"))) {
		if (el.dataset.path === path) {
			target = el;
			break;
		}
	}
	if (!target) return;
	const nodeEl = target.closest(".tree-node") || target;
	nodeEl.scrollIntoView({ block: "center", behavior: "smooth" });
	const row = nodeEl.querySelector(".tree-row");
	if (row) {
		row.classList.add("tree-row-flash");
		setTimeout(() => row.classList.remove("tree-row-flash"), 1200);
	}
}

export function previewSettingsFingerprintFE(s: JobSettings): string {
	return JSON.stringify({
		quality: s.quality,
		finalSpeed: s.finalSpeed,
		denoise: s.denoise,
		denoiseBackend: s.denoiseBackend,
		gpuDevice: s.gpuDevice,
		deband: s.deband,
		downscale: s.downscale,
		skipBoosting: s.skipBoosting,
		nlmeansParams: s.nlmeansParams,
		gradfunParams: s.gradfunParams,
		autoDenoiseMetric: s.autoDenoiseMetric,
		autoDenoiseThresholds: s.autoDenoiseThresholds,
		autoDenoiseBitrateThresholds: s.autoDenoiseBitrateThresholds,
		vsFilters: s.vsFilters ?? [],
	});
}

export function createTreeNode(entry: LibraryEntry, depth: number, parentPath: string | null): LibraryNode {
	return {
		path: entry.path,
		name: entry.name,
		type: entry.type,
		depth,
		parentPath,
		expanded: false,
		checked: false,
		children: entry.type === "directory" ? null : undefined,
		loading: false,
		encoded: entry.encoded || false,
		queued: entry.type === "file" && appState.libraryQueuedPaths.has(entry.path),
		videoCount: entry.videoCount || 0,
		encodedCount: entry.encodedCount || 0,
		size: entry.size || 0,
	};
}
