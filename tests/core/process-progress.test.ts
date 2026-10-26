import { expect, test } from "bun:test";
import { run } from "../../src/core/process";

test("run streams progress lines and retains stdout", async () => {
	const lines: string[] = [];
	const result = await run(["sh", "-c", "printf '#GUI#progress 10%%\\r#GUI#progress 20%%\\n'"], { onStdoutLine: (line) => lines.push(line) });
	expect(result.code).toBe(0);
	expect(lines).toEqual(["#GUI#progress 10%", "#GUI#progress 20%"]);
	expect(result.stdout).toContain("#GUI#progress 20%");
});
