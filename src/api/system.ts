import type { Web } from "@rabbit-company/web";
import type { AppConfig } from "../core/types";
import { getSystemStats } from "../core/system";
import { listOpenClDevices } from "../video/opencl";
import { listVulkanDevices } from "../video/vulkan";
import { listAvdDevices } from "../video/avd";

export function registerSystemRoutes(app: Web, config: AppConfig): void {
	app.get("/api/system", async (c) => {
		const stats = await getSystemStats(config.tempDir);
		return c.json(stats);
	});

	app.get("/api/opencl-devices", async (c) => {
		const devices = await listOpenClDevices();
		return c.json({ devices });
	});

	app.get("/api/vulkan-devices", async (c) => {
		const devices = await listVulkanDevices();
		return c.json({ devices });
	});

	app.get("/api/avd-devices", async (c) => {
		const devices = await listAvdDevices();
		return c.json({ devices });
	});
}
