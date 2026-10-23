/** The versions of Rabbit Encoder and its tools as plain text for bug reports. Shared with the dashboard. */
export function versionsText(versions: { rabbitEncoder: string; cpuLevel: string | null; tools: { name: string; version: string | null }[] }): string {
	return [
		`Rabbit Encoder ${versions.rabbitEncoder}${versions.cpuLevel ? ` (${versions.cpuLevel})` : ""}`,
		...versions.tools.map((tool) => `${tool.name} ${tool.version ?? "not found"}`),
	].join("\n");
}
