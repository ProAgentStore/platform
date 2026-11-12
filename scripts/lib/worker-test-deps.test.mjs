import { describe, expect, it, vi } from "vitest";
import { createWorkerTestDeps } from "./worker-test-deps.mjs";

describe("scoped Worker test dependencies", () => {
	const plugin = createWorkerTestDeps({
		apiEntry: "/repo/workers/api/src/index.ts",
		hostIndex: "C:\\repo\\workers\\host\\src\\index.ts",
		hostPagesStub: "/repo/pages.test-stub.ts",
	});
	// Invariant: template Hono imports resolve through the API on either importer separator.
	it.each([
		"/repo/templates/agent/src/index.ts",
		"C:/repo/templates/agent/src/index.ts",
		"C:\\repo\\templates\\agent\\src\\index.ts",
	])("resolves Hono for %s", async (importer) => {
		const resolve = vi.fn().mockResolvedValue({ id: "resolved-hono" });
		expect(await plugin.resolveId.call({ resolve }, "hono", importer)).toEqual({ id: "resolved-hono" });
		expect(resolve).toHaveBeenCalledWith("hono", "/repo/workers/api/src/index.ts", { skipSelf: true });
	});
	it.each([undefined, "/repo/workers/api/src/index.ts", "/repo/my-templates/src/index.ts"])(
		"leaves non-template importer %s alone",
		async (importer) => {
			const resolve = vi.fn();
			expect(await plugin.resolveId.call({ resolve }, "hono", importer)).toBeNull();
			expect(resolve).not.toHaveBeenCalled();
		},
	);
	it("leaves other template dependencies alone", async () => {
		const resolve = vi.fn();
		expect(await plugin.resolveId.call({ resolve }, "other-package", "/repo/templates/agent/index.ts")).toBeNull();
		expect(resolve).not.toHaveBeenCalled();
	});
	it("recognizes the host importer with normalized separators", async () => {
		expect(await plugin.resolveId("./pages.js", "C:/repo/workers/host/src/index.ts")).toBe("/repo/pages.test-stub.ts");
		expect(await plugin.resolveId("./pages.js", "C:/repo/workers/other/src/index.ts")).toBeNull();
	});
});
