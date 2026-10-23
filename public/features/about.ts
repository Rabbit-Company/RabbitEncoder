import type { VersionsReport } from "../types";
import { fetchVersions } from "../api/client";
import { buttonById, byId } from "../shared/dom";
import { errorMessage } from "../shared/errors";
import { versionsText } from "../../src/core/versions-text";

let report: VersionsReport | null = null;

const escapeHtml = (value: unknown): string =>
	String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");

function render(): void {
	if (!report) return;
	byId("about-summary").textContent = `Version ${report.rabbitEncoder}${report.cpuLevel ? `, ${report.cpuLevel} builds` : ""}`;
	const rows = report.tools
		.map(
			(tool) => `<tr>
				<td><a href="${escapeHtml(tool.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(tool.name)}</a></td>
				<td>${tool.version ? escapeHtml(tool.version) : '<span class="about-missing">Not found</span>'}</td>
				<td>${escapeHtml(tool.purpose)}</td>
			</tr>`,
		)
		.join("");
	byId("about-tools").innerHTML =
		`<table class="about-tools"><thead><tr><th>Tool</th><th>Version</th><th>Used for</th></tr></thead><tbody>${rows}</tbody></table>`;
	buttonById("about-copy").disabled = false;
}

export async function openAbout(): Promise<void> {
	byId("about-modal").style.display = "";
	byId("about-result").textContent = "";
	byId("about-error").style.display = "none";
	if (report) return render();
	try {
		report = await fetchVersions();
		render();
	} catch (error) {
		const box = byId("about-error");
		box.textContent = errorMessage(error);
		box.style.display = "";
		byId("about-tools").innerHTML = "";
	}
}

export function closeAbout(): void {
	byId("about-modal").style.display = "none";
}

export function closeAboutIfOutside(event: MouseEvent): void {
	if (event.target === event.currentTarget) closeAbout();
}

export async function copyVersions(): Promise<void> {
	if (!report) return;
	try {
		await navigator.clipboard.writeText(versionsText(report));
		byId("about-result").textContent = "Copied";
	} catch {
		byId("about-result").textContent = "Copying is not allowed here";
	}
}
