import { afterEach, describe, expect, it, vi } from "vitest";
import { buildInspectTools, executeInspectTool, INSPECT_TOOL_NAMES } from "./coding-inspect.js";

const calls: Array<{ path: string; body: unknown }> = [];
vi.mock("./runner-client.js", () => ({
	callRunner: vi.fn(async (_conn: unknown, path: string, body: unknown) => {
		calls.push({ path, body });
		if ((body as { cmd?: string }).cmd === "diff") return { output: "diff --git a/x b/x\n+changed" };
		if ((body as { cmd?: string }).cmd === "status") return { output: " M src/app.ts" };
		if (path === "/coding/read-file") return { content: "export const x = 1;" };
		if (path === "/coding/tree") return { entries: [{ path: "src", type: "dir" }, { path: "src/app.ts", type: "file" }] };
		return {};
	}),
}));

const target = { conn: {} as never, sessionId: "s1", workDir: "/repo" };

describe("buildInspectTools", () => {
	it("offers exactly the four read-only tools", () => {
		const names = buildInspectTools().map((t) => t.function.name);
		expect(new Set(names)).toEqual(INSPECT_TOOL_NAMES);
	});
});

describe("executeInspectTool", () => {
	afterEach(() => {
		calls.length = 0;
	});

	it("git_diff → /coding/git {cmd:'diff'} and reports the change", async () => {
		const out = await executeInspectTool(target, { name: "git_diff", arguments: {} });
		expect(calls[0]).toMatchObject({ path: "/coding/git", body: { cmd: "diff", sessionId: "s1", workDir: "/repo" } });
		expect(out).toMatch(/changed/);
	});

	it("read_file → /coding/read-file with the path", async () => {
		const out = await executeInspectTool(target, { name: "read_file", arguments: { path: "src/app.ts" } });
		expect(calls[0]).toMatchObject({ path: "/coding/read-file", body: { path: "src/app.ts" } });
		expect(out).toMatch(/export const x/);
	});

	it("list_files → /coding/tree, rendered as a path list", async () => {
		const out = await executeInspectTool(target, { name: "list_files", arguments: {} });
		expect(calls[0].path).toBe("/coding/tree");
		expect(out).toMatch(/src\//);
		expect(out).toMatch(/src\/app\.ts/);
	});

	it("read_file without a path is refused cleanly (no runner call)", async () => {
		const out = await executeInspectTool(target, { name: "read_file", arguments: {} });
		expect(out).toMatch(/needs a `path`/);
		expect(calls.length).toBe(0);
	});

	it("degrades honestly when the runner endpoint 404s (old runner)", async () => {
		const rc = await import("./runner-client.js");
		(rc.callRunner as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(new Error("Runner /coding/git → 404 Not found"));
		const out = await executeInspectTool(target, { name: "git_status", arguments: {} });
		expect(out).toMatch(/isn't available on this runner/i);
		expect(out).toMatch(/say you couldn't check/i);
	});
});
