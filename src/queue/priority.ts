export interface QueuePriorityJob {
	kind?: "encode" | "repair";
	queueOrder: number;
}

/** Repairs are short, user-blocking jobs, so they run before queued encodes. */
export function queuePriority(job: QueuePriorityJob): number {
	return job.kind === "repair" ? 0 : 1;
}

/** Preserve the user's order within each priority class. */
export function compareQueuedJobs(a: QueuePriorityJob, b: QueuePriorityJob): number {
	return queuePriority(a) - queuePriority(b) || a.queueOrder - b.queueOrder;
}
