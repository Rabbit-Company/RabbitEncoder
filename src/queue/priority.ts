export interface QueuePriorityJob {
	kind?: "encode" | "repair" | "hdr" | "grain" | "subtitles" | "audio" | "disc";
	queueOrder: number;
}

/**
 * Repairs, HDR metadata and film grain changes, and added subtitles and audio are user-blocking jobs that copy the video, so they run before queued encodes.
 * A disc remux runs in line with the encodes, so only the episode about to be encoded takes up temp space.
 */
export function queuePriority(job: QueuePriorityJob): number {
	return job.kind === "encode" || job.kind === "disc" || job.kind === undefined ? 1 : 0;
}

/** Preserve the user's order within each priority class. */
export function compareQueuedJobs(a: QueuePriorityJob, b: QueuePriorityJob): number {
	return queuePriority(a) - queuePriority(b) || a.queueOrder - b.queueOrder;
}
