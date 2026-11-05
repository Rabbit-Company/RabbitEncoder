import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Web } from "@rabbit-company/web";
import type { AppConfig } from "../../src/core/types";
import { registerFontRoutes } from "../../src/api/fonts";
import { fontRegistry } from "../../src/fonts/fonts";

const LIBERATION = "/usr/share/fonts/liberation-sans-fonts/LiberationSans-Regular.ttf";
const hasTools = !!Bun.which("fc-scan") && existsSync(LIBERATION);

(hasTools ? test : test.skip)(
	"stores an uploaded font in the library, in a group named after its family unless one is given",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "rabbit-font-library-"));
		try {
			fontRegistry.configure(join(root, "stock"), join(root, "fonts"));
			await fontRegistry.reload();
			const app = new Web();
			registerFontRoutes(app, { tempDir: join(root, "temp"), systemFontDirs: [] } as unknown as AppConfig);
			const upload = (query: Record<string, string>, body: Uint8Array<ArrayBuffer>) =>
				app.handle(new Request(`http://localhost/api/fonts/upload?${new URLSearchParams(query)}`, { method: "POST", body }));
			const bytes = new Uint8Array(readFileSync(LIBERATION)) as Uint8Array<ArrayBuffer>;

			const own = await upload({ fileName: "LiberationSans-Regular.ttf" }, bytes);
			expect(own.status).toBe(201);
			expect(await own.json()).toEqual({ label: "Liberation Sans", fileName: "LiberationSans-Regular.ttf", family: "Liberation Sans" });
			expect(existsSync(join(root, "fonts", "Liberation Sans", "LiberationSans-Regular.ttf"))).toBe(true);

			// The same font again is kept once.
			const again = (await (await upload({ fileName: "Copy.ttf" }, bytes)).json()) as any;
			expect(again.fileName).toBe("LiberationSans-Regular.ttf");
			expect(readdirSync(join(root, "fonts", "Liberation Sans")).filter((f) => f.endsWith(".ttf"))).toEqual(["LiberationSans-Regular.ttf"]);

			const grouped = (await (await upload({ group: "Signs", keys: "latin, jpn" }, bytes)).json()) as any;
			expect(grouped).toEqual({ label: "Signs", fileName: "Liberation Sans.ttf", family: "Liberation Sans" });

			const listed = (await (await app.handle(new Request("http://localhost/api/fonts"))).json()) as any;
			const signs = listed.fonts.find((f: any) => f.label === "Signs");
			expect(signs.faces[0]).toMatchObject({ fileName: "Liberation Sans.ttf", family: "Liberation Sans", size: bytes.length });
			expect(signs.faces[0].names).toContain("liberation sans");
			expect(signs.faces[0].keys).toEqual(expect.arrayContaining(["latin", "jpn"]));

			const notFont = await upload({}, new TextEncoder().encode("not a font at all") as Uint8Array<ArrayBuffer>);
			expect(notFont.status).toBe(400);
			expect(((await notFont.json()) as any).error).toContain("not a TrueType or OpenType font");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
	30_000,
);
