export type JobAction = "edit" | "remove" | "dismiss" | "retry" | "cancel" | "preview" | "sub-preview" | "audio-preview" | "mediainfo" | "bitrate";

export interface JobActionHandlers {
	edit(id: string): void | Promise<void>;
	remove(id: string): void | Promise<void>;
	dismiss(id: string): void | Promise<void>;
	retry(id: string): void | Promise<void>;
	cancel(id: string): void | Promise<void>;
	preview(id: string): void | Promise<void>;
	"sub-preview"(id: string): void | Promise<void>;
	"audio-preview"(id: string): void | Promise<void>;
	mediainfo(id: string): void | Promise<void>;
	bitrate(id: string): void | Promise<void>;
}

export function dispatchJobAction(action: string | undefined, id: string | undefined, handlers: JobActionHandlers): void {
	if (!action || !id) return;
	if (!isJobAction(action)) return;
	void handlers[action](id);
}

function isJobAction(action: string): action is JobAction {
	return ["edit", "remove", "dismiss", "retry", "cancel", "preview", "sub-preview", "audio-preview", "mediainfo", "bitrate"].includes(action);
}
