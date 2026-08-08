export interface BitrateSample {
	/** Bucket start time, seconds. */
	t: number;
	kbps: number;
}

/**
 * Sample a video stream's bitrate over time by summing packet sizes into
 * fixed-width time buckets. Pure container demuxing (no decode), so this is
 * fast even on long files.
 */
export async function sampleBitrateOverTime(path: string, bucketSeconds = 1): Promise<BitrateSample[]> {
	const proc = Bun.spawn(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,dts_time,size", "-of", "csv=p=0", path], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = await new Response(proc.stdout).text();
	await proc.exited;

	const bytesByBucket = new Map<number, number>();
	let maxBucket = -1;

	for (const line of out.split("\n")) {
		if (!line.trim()) continue;
		const [ptsTimeRaw, dtsTimeRaw, sizeRaw] = line.split(",");
		let t = parseFloat(ptsTimeRaw ?? "");
		if (!Number.isFinite(t)) t = parseFloat(dtsTimeRaw ?? "");
		const size = parseInt(sizeRaw ?? "", 10);
		if (!Number.isFinite(t) || t < 0 || !Number.isFinite(size)) continue;

		const bucket = Math.floor(t / bucketSeconds);
		bytesByBucket.set(bucket, (bytesByBucket.get(bucket) ?? 0) + size);
		if (bucket > maxBucket) maxBucket = bucket;
	}

	const samples: BitrateSample[] = [];
	for (let b = 0; b <= maxBucket; b++) {
		const bytes = bytesByBucket.get(b) ?? 0;
		samples.push({ t: b * bucketSeconds, kbps: Math.round((bytes * 8) / 1000 / bucketSeconds) });
	}
	return samples;
}
