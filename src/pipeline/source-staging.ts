const NETWORK_FILESYSTEM_TYPES = new Set([0x6969, 0xff534d42, 0xfe534d42]);

/** NFS and SMB sources are staged only when the working directory is local. */
export function shouldStageSource(sourceFilesystem: number, tempFilesystem: number): boolean {
	return NETWORK_FILESYSTEM_TYPES.has(sourceFilesystem >>> 0) && !NETWORK_FILESYSTEM_TYPES.has(tempFilesystem >>> 0);
}
