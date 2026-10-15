import { authFetch } from "../api/client";
import { API } from "../config/api-base";
import { TRANSLATE_PROVIDER_LABELS } from "../config/options";
import { buttonById, byId, inputById } from "../shared/dom";
import { errorMessage } from "../shared/errors";
import { appState } from "../state";
import { update } from "./polling";

const STORAGE_KEY = "rabbit-library-translate";

let selectedPaths: string[] = [];

interface LastChoice {
	source: string;
	type: string;
	targets: string;
}

function loadLastChoice(): Partial<LastChoice> {
	try {
		return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
	} catch {
		return {};
	}
}

function saveLastChoice(choice: LastChoice): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
	} catch {}
}

function showError(message: string): void {
	const el = byId("library-translate-error");
	el.textContent = message;
	el.style.display = message ? "" : "none";
}

function parseLanguages(value: string): string[] {
	return value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

function renderAiSummary(): boolean {
	const d = appState.defaults;
	const el = byId("library-translate-ai");
	if (!d?.translateBaseUrl?.trim() || !d?.translateModel?.trim()) {
		el.textContent = "No AI provider is set up yet. Add one under Settings, Subtitle handling, Subtitle translation.";
		return false;
	}
	el.textContent = `Uses ${d.translateModel} at ${d.translateBaseUrl} (${TRANSLATE_PROVIDER_LABELS[d.translateProvider ?? "openai"]}). Change it under Settings, Subtitle translation.`;
	return true;
}

export function openTranslateSetup(paths: string[], fileCount: number): void {
	selectedPaths = [...paths];
	const last = loadLastChoice();
	const defaultTargets = appState.defaults?.translateTargetLanguages?.join(", ") ?? "";
	inputById("library-translate-source").value = last.source || "eng";
	byId<HTMLSelectElement>("library-translate-type").value = last.type || "full";
	inputById("library-translate-targets").value = last.targets || defaultTargets;
	byId("library-translate-count").textContent = `${fileCount} video${fileCount === 1 ? "" : "s"} selected`;
	showError("");
	buttonById("library-translate-submit").disabled = !renderAiSummary();
	byId("library-translate-modal").style.display = "";
	inputById("library-translate-targets").focus();
}

export function closeTranslateSetup(): void {
	byId("library-translate-modal").style.display = "none";
}

export function closeTranslateSetupIfOutside(event: MouseEvent): void {
	if (event.target === event.currentTarget) closeTranslateSetup();
}

export async function submitTranslateSetup(): Promise<void> {
	const button = buttonById("library-translate-submit");
	const choice: LastChoice = {
		source: inputById("library-translate-source").value.trim(),
		type: byId<HTMLSelectElement>("library-translate-type").value,
		targets: inputById("library-translate-targets").value.trim(),
	};
	const targetLanguages = parseLanguages(choice.targets);
	if (!choice.source) return showError("Enter the language to translate from");
	if (!targetLanguages.length) return showError("Enter at least one language to translate to");

	button.disabled = true;
	showError("");
	try {
		const res = await authFetch(`${API}/api/library/translate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ paths: selectedPaths, sourceLanguage: choice.source, sourceType: choice.type, targetLanguages }),
		});
		const data = await res.json();
		if (!res.ok) throw new Error(data.error || "Failed to queue translations");
		saveLastChoice(choice);
		const notes: string[] = [];
		if (data.added) notes.push(`Queued ${data.added} translation${data.added === 1 ? "" : "s"}`);
		if (data.skipped) notes.push(`${data.skipped} already queued`);
		byId("library-note").textContent = notes.join(", ") || "No video files found to translate";
		closeTranslateSetup();
		if (data.added) {
			byId("library-modal").style.display = "none";
			void update();
		}
	} catch (error) {
		showError(errorMessage(error));
	} finally {
		button.disabled = false;
	}
}
