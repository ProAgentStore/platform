import { describe, expect, it } from "vitest";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { registerBaseTools } from "./base.js";

/**
 * What `list_instance_tools` PROMISES, held to what it returns (#563, #569).
 *
 * A tool description is the only documentation a calling model reads, and nothing checked this
 * one. Two defects were measured against production instance bd43f4de-… on 2026-08-15:
 *
 *   • it offered `scope` as the way to "verify an agent is read-only", and `scope` answers a
 *     different question — nine mutating tools report `read` because they have no connector to
 *     consent to (#563);
 *   • it defined 2 of the 4 `tier` values it returns, so a caller filtering on the documented
 *     pair silently dropped 34 of 104 rows, including every `runtime` tool (#569).
 *
 * Both are the same failure: prose that fell behind the data and nothing measuring the gap.
 */

const env: McpEnv = { API_BASE: "https://api.test" };

/** The registered description of one base tool, read off a real registration run. */
function describeTool(name: string): string {
	const descriptions = new Map<string, string>();
	registerBaseTools(
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake MCP server
		{ tool: (n: string, d: string) => descriptions.set(n, d) } as any,
		{
			env,
			tokenFor: (t?: string) => t || "session-token",
			safetyFor: (): SafetyContext => ({ env, subject: "u1", scopes: ["read"] }),
			groups: new Set<string>(),
		},
	);
	// G1: the harness itself is asserted. A registrar that silently registered nothing would
	// otherwise make every arm below pass against an empty string.
	expect(descriptions.size, "registerBaseTools registered nothing — this file is measuring nothing").toBeGreaterThanOrEqual(7);
	const d = descriptions.get(name);
	expect(d, `${name} is not registered by registerBaseTools`).toBeDefined();
	return d as string;
}

describe("list_instance_tools describes the fields it returns", () => {
	it("names `mutates` as the answer to 'does it change anything', and disowns `scope` (#563)", () => {
		const d = describeTool("list_instance_tools");
		expect(d).toContain("`mutates`");
		// The sentence that made an imprecise field into a wrong answer. It read "Use this to
		// verify an agent is read-only" with `scope` as the only mutation-ish field on offer.
		expect(d, "the read-only claim must name the field that answers it").toMatch(/read-only[^.]*`mutates`|`mutates`[^.]*read-only/);
		// And `scope`'s own gloss has to say what `scope` is: the consent gate, not mutation.
		expect(d, "`scope` must be glossed as the write-CONSENT gate").toMatch(/`scope`[^,]*\([^)]*[Cc]ONSENT|`scope`[^,]*\([^)]*consent/);
		console.log(`✓ #563: list_instance_tools description is ${d.length} chars and names mutates`);
	});
});
