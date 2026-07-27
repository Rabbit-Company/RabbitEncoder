import { mkdirSync } from "fs";
import { Web } from "@rabbit-company/web";
import { cors } from "@rabbit-company/web-middleware/cors";
import { bearerAuth } from "@rabbit-company/web-middleware/bearer-auth";
import indexHtml from "../public/index.html";
import { registerApiRoutes } from "./api";
import { vsRegistry } from "./video/vs-filters";
import { fontRegistry } from "./fonts/fonts";
import { loadConfig } from "./core/config";
import { initStore } from "./queue/store";
import { startWatcher } from "./queue/watcher";
import { Logger } from "./core/logger";

export const config = await loadConfig();

vsRegistry.configure(
	process.env.VS_PRESETS_STOCK_DIR ?? "/app/vapoursynth/presets",
	process.env.VS_PRESETS_USER_DIR ?? "/config/vapoursynth/presets",
	process.env.VS_RABBIT_MODULE_DIR ?? "/app/vapoursynth",
);
vsRegistry.reload();

fontRegistry.configure(process.env.FONTS_STOCK_DIR ?? "/app/fonts", process.env.FONTS_USER_DIR ?? "/config/fonts");
fontRegistry.seed(["Noto Sans", "Noto Serif"]);
await fontRegistry.reload();

const hashedPassword = new Bun.CryptoHasher("blake2b512").update(`rabbitencoder-${process.env.PASSWORD || "rabbitencoder"}`).digest("hex");

mkdirSync(config.inputDir, { recursive: true });
mkdirSync(config.outputDir, { recursive: true });
mkdirSync(config.tempDir, { recursive: true });
mkdirSync(config.fontsUserDir, { recursive: true });

initStore(config);

startWatcher(config.inputDir);

const app = new Web();
app.use(cors());
app.use(
	bearerAuth({
		validate(token, ctx) {
			if (token.length !== hashedPassword.length) {
				return !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(token));
			}

			return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(hashedPassword));
		},
	}),
);

registerApiRoutes(app, config);

Logger.info(`Rabbit Encoder started on http://0.0.0.0:${config.port}`);

if (config.libraryDirs.length > 0) {
	Logger.info(`Library directories: ${config.libraryDirs.join(", ")}`);
}

Bun.serve({
	hostname: "::",
	port: config.port,
	idleTimeout: 255,
	routes: {
		"/": indexHtml,
	},
	fetch: app.handleBun,
});
