import { findDiscOriginals } from "../api/client";
import { errorMessage } from "../shared/errors";
import { openRepairFolderPicker } from "./repair";

export interface DiscOriginalChoice {
	/** The range the video was made from, empty when none matched. */
	sourcePath: string;
	matched: "tags" | "episode" | "";
	/** Every item of the set, to choose one by hand. */
	sources: { path: string; name: string }[];
}

/**
 * Asks for the folder of a Blu-ray disc set and finds the range `target` was
 * made from, by the disc range in its tags or by its episode number.
 */
export function chooseDiscOriginal(target: string, onFound: (choice: DiscOriginalChoice) => void, onError: (message: string) => void): void {
	openRepairFolderPicker(async (path) => {
		try {
			const found = await findDiscOriginals(path, [target]);
			const pair = found.pairs[0];
			onFound({
				sourcePath: pair?.sourcePath ?? "",
				matched: !pair?.sourcePath ? "" : pair.method === "disc" ? "tags" : "episode",
				sources: found.sources,
			});
		} catch (error) {
			onError(errorMessage(error));
		}
	}, "Choose the Blu-ray discs");
}

/** What was found, for the line under the choice. */
export function discOriginalNote(choice: DiscOriginalChoice): string {
	if (choice.matched === "tags") return "Found by the disc range in the video's tags.";
	if (choice.matched === "episode") return "Matched by episode number and length. Check it is the right item.";
	return choice.sources.length ? "No item of these discs matches this video. Choose the one it was made from." : "These discs have no items to choose from.";
}

const escapeHtml = (value: string): string =>
	value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");

/** The options of a select that lists the items of a disc set. */
export function discOriginalOptions(choice: DiscOriginalChoice, selected: string): string {
	return [
		`<option value=""${selected ? "" : " selected"}>Choose an item of the discs</option>`,
		...choice.sources.map(
			(source) => `<option value="${escapeHtml(source.path)}"${source.path === selected ? " selected" : ""}>${escapeHtml(source.name)}</option>`,
		),
	].join("");
}
