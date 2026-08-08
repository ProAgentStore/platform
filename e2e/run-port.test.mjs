import { describe, expect, it } from "vitest";
import { PORT_BASE, PORT_SPREAD, resolveE2EPort } from "./run-port.mjs";

describe("resolveE2EPort (#452)", () => {
	it("honours an explicit E2E_PORT, so the escape hatch actually moves the run", () => {
		// Before #452 this variable moved the SERVER and nothing else: the server bound it while
		// Playwright's baseURL and webServer.url both stayed 4273 — someone else's server.
		const env = { E2E_PORT: "5001" };
		expect(resolveE2EPort(env, 1234)).toBe(5001);
		expect(env.E2E_PORT).toBe("5001");
	});

	it("does not default to a fixed port — a fixed default IS the collision", () => {
		// Several full suites run on this machine at once by design (#253). Two runs on one port
		// is not a hypothetical: it was reproduced end to end.
		const a = resolveE2EPort({}, 1000);
		const b = resolveE2EPort({}, 1001);
		expect(a).not.toBe(b);
		for (const p of [a, b]) {
			expect(p).toBeGreaterThanOrEqual(PORT_BASE);
			expect(p).toBeLessThan(PORT_BASE + PORT_SPREAD);
		}
	});

	it("resolves the SAME port when re-evaluated with a different pid", () => {
		// THE load-bearing case. Playwright loads playwright.config.ts in every worker process,
		// so this runs again in a process whose pid is not the parent's. A bare
		// `4273 + (process.pid % 500)` gave parent 4282 and workers 4288/4289 — three ports, one
		// server. Publishing the decision into the inherited env is what makes the second call
		// read it instead of making a new one. Delete that write and this test fails.
		const env = {};
		const parent = resolveE2EPort(env, 1000);
		const worker = resolveE2EPort(env, 1006);
		expect(worker).toBe(parent);
	});

	it("survives a pid larger than the spread", () => {
		const p = resolveE2EPort({}, 987654);
		expect(p).toBeGreaterThanOrEqual(PORT_BASE);
		expect(p).toBeLessThan(PORT_BASE + PORT_SPREAD);
	});

	it("ignores an empty E2E_PORT rather than resolving port 0", () => {
		// `E2E_PORT=` in a shell exports an empty string, not an absent variable. Treating that as
		// explicit would bind port 0 (any free port) and then wait on it forever.
		const env = { E2E_PORT: "" };
		expect(resolveE2EPort(env, 1000)).toBe(PORT_BASE + 1000 % PORT_SPREAD);
	});
});
