/**
 * #1143 — through the REAL machine wiring (`machineSecureTypeDeps`), with `node:child_process` itself
 * mocked: no `execFileSync` call made while typing a secret has the value in its argument list.
 */
import { describe, expect, it, vi } from "vitest";

const { execFileSync } = vi.hoisted(() => ({ execFileSync: vi.fn((..._a: unknown[]) => "") }));
vi.mock("node:child_process", async (orig) => ({ ...(await orig<typeof import("node:child_process")>()), execFileSync }));

const { machineSecureTypeDeps, secureType } = await import("./secure-type.js");

const SECRET = "4/0AVG7fiQ-VERIFICATION-CODE-7f3a";

describe("no execFileSync argv carries the secret (#1143)", () => {
	for (const target of ["gcloud-setup", "tmux:gcloud-setup", "kitty:7"]) {
		it(`typing into ${target}`, async () => {
			execFileSync.mockClear();
			await secureType({ target, value: SECRET }, await machineSecureTypeDeps());
			expect(execFileSync).toHaveBeenCalled();
			for (const [file, args] of execFileSync.mock.calls as Array<[string, string[]]>) {
				expect(`${file} ${(args ?? []).join(" ")}`).not.toContain(SECRET);
			}
			// And it did reach the terminal — on stdin.
			expect((execFileSync.mock.calls as Array<[string, string[], { input?: string }]>).some(([, , o]) => o?.input === SECRET)).toBe(true);
		});
	}
});
