import type { Job } from "../types";
import type { FolderTreeNode, MoveDirection } from "../ui/models";
import { fetchJobs, reorderQueue } from "../api/client";
import { buildFolderTree } from "./job-render";
import { update } from "./polling";
import { appState } from "../state";
import { compareQueuedJobs, queuePriority } from "../../src/queue/priority";

export function getMinQueueOrder(node: FolderTreeNode): number {
	let min = Infinity;
	for (const job of node.jobs) {
		if (job.status === "queued" && job.queueOrder < min) min = job.queueOrder;
	}
	for (const child of node.children.values()) {
		const childMin = getMinQueueOrder(child);
		if (childMin < min) min = childMin;
	}
	return min;
}

export function sortNodeChildren(children: FolderTreeNode[]): FolderTreeNode[] {
	return [...children].sort((a, b) => {
		const aMin = getMinQueueOrder(a);
		const bMin = getMinQueueOrder(b);
		if (aMin === Infinity && bMin === Infinity) return a.name.localeCompare(b.name);
		if (aMin === Infinity) return 1;
		if (bMin === Infinity) return -1;
		return aMin - bMin;
	});
}

export function collectAllQueuedJobs(node: FolderTreeNode): Job[] {
	const result = [];
	for (const child of node.children.values()) {
		result.push(...collectAllQueuedJobs(child));
	}
	for (const job of node.jobs) {
		if (job.status === "queued") {
			result.push(job);
		}
	}
	return result;
}

export function collectQueuedIdsInOrder(node: FolderTreeNode): string[] {
	const ids = [];

	const sorted = sortNodeChildren(Array.from(node.children.values()));
	for (const child of sorted) {
		ids.push(...collectQueuedIdsInOrder(child));
	}

	const sortedJobs = [...node.jobs].sort(compareQueuedJobs);
	for (const job of sortedJobs) {
		if (job.status === "queued") {
			ids.push(job.id);
		}
	}

	return ids;
}

export function findFolderByPath(node: FolderTreeNode, folderPath: string): FolderTreeNode | null {
	if (node.fullPath === folderPath) return node;
	for (const child of node.children.values()) {
		const found = findFolderByPath(child, folderPath);
		if (found) return found;
	}
	return null;
}

export function findParentOfFolder(node: FolderTreeNode, folderPath: string): FolderTreeNode | null {
	for (const child of node.children.values()) {
		if (child.fullPath === folderPath) return node;
		const found = findParentOfFolder(child, folderPath);
		if (found) return found;
	}
	return null;
}

export function swapArrayItems<T>(items: T[], a: number, b: number): boolean {
	const first = items[a];
	const second = items[b];
	if (first === undefined || second === undefined) return false;
	items[a] = second;
	items[b] = first;
	return true;
}

export function assignQueueOrders(jobs: Job[], sortedOrders: number[], startIndex = 0): number | null {
	let orderIndex = startIndex;
	for (const job of jobs) {
		const order = sortedOrders[orderIndex];
		if (order === undefined) return null;
		job.queueOrder = order;
		orderIndex++;
	}
	return orderIndex;
}

export async function handleMove(targetPath: string, direction: MoveDirection, isFile: boolean, jobId: string | null): Promise<void> {
	const jobs = await fetchJobs();
	const tree = buildFolderTree(jobs);

	if (isFile) {
		const folder = findFolderByPath(tree, targetPath);
		if (!folder) return;

		const selectedJob = folder.jobs.find((j) => j.id === jobId && j.status === "queued");
		if (!selectedJob) return;
		const selectedPriority = queuePriority(selectedJob);
		const queuedJobs = folder.jobs.filter((j) => j.status === "queued" && queuePriority(j) === selectedPriority).sort(compareQueuedJobs);

		const idx = queuedJobs.findIndex((j) => j.id === jobId);
		if (idx === -1) return;

		if (direction === "up" && idx > 0) {
			if (!swapArrayItems(queuedJobs, idx, idx - 1)) return;
		} else if (direction === "down" && idx < queuedJobs.length - 1) {
			if (!swapArrayItems(queuedJobs, idx, idx + 1)) return;
		} else {
			return;
		}

		const orders = queuedJobs.map((j) => j.queueOrder).sort((a, b) => a - b);
		if (assignQueueOrders(queuedJobs, orders) === null) return;
	} else {
		const parent = findParentOfFolder(tree, targetPath);
		if (!parent) return;

		const siblings = sortNodeChildren(Array.from(parent.children.values()));
		const idx = siblings.findIndex((n) => n.fullPath === targetPath);
		if (idx === -1) return;

		let otherIdx;
		if (direction === "up" && idx > 0) {
			otherIdx = idx - 1;
		} else if (direction === "down" && idx < siblings.length - 1) {
			otherIdx = idx + 1;
		} else {
			return;
		}

		const currentSibling = siblings[idx];
		const otherSibling = siblings[otherIdx];
		if (!currentSibling || !otherSibling) return;

		const jobsA = collectAllQueuedJobs(currentSibling).sort(compareQueuedJobs);
		const jobsB = collectAllQueuedJobs(otherSibling).sort(compareQueuedJobs);

		if (jobsA.length === 0 && jobsB.length === 0) return;

		const allOrders = [...jobsA, ...jobsB].map((j) => j.queueOrder).sort((a, b) => a - b);

		const first = direction === "up" ? jobsA : jobsB;
		const second = direction === "up" ? jobsB : jobsA;

		const afterFirst = assignQueueOrders(first, allOrders);
		if (afterFirst === null) return;
		if (assignQueueOrders(second, allOrders, afterFirst) === null) return;
	}

	const orderedIds = collectQueuedIdsInOrder(tree);
	await reorderQueue(orderedIds);
	appState.lastJobsJson = "";
	update();
}

export function renderRadioPills<T extends string>(container: HTMLElement, options: readonly T[], selected: T, onChange: (value: T) => void): void {
	container.innerHTML = "";
	options.forEach((opt) => {
		const pill = document.createElement("div");
		pill.className = `radio-pill${opt === selected ? " selected" : ""}`;
		pill.textContent = opt;
		pill.onclick = () => {
			container.querySelectorAll(".radio-pill").forEach((p) => p.classList.remove("selected"));
			pill.classList.add("selected");
			onChange(opt);
		};
		container.appendChild(pill);
	});
}
