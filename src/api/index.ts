import type { Web } from "@rabbit-company/web";
import { registerSystemRoutes } from "./system";
import { registerJobRoutes } from "./jobs";
import { registerPreviewRoutes } from "./previews";
import { registerSettingsRoutes } from "./settings";
import { registerTranslateRoutes } from "./translate";
import { registerQueueRoutes } from "./queue";
import { registerBenchmarkRoutes } from "./benchmark";
import { registerLibraryRoutes } from "./library";
import { registerFontRoutes } from "./fonts";
import { registerVsPresetRoutes } from "./vs-presets";
import { registerRepairRoutes } from "./repair";
import type { AppConfig } from "../core/types";

export function registerApiRoutes(app: Web, config: AppConfig): void {
	registerSystemRoutes(app, config);
	registerJobRoutes(app, config);
	registerPreviewRoutes(app, config);
	registerSettingsRoutes(app, config);
	registerTranslateRoutes(app);
	registerQueueRoutes(app);
	registerBenchmarkRoutes(app, config);
	registerLibraryRoutes(app, config);
	registerFontRoutes(app, config);
	registerVsPresetRoutes(app);
	registerRepairRoutes(app, config);
}
