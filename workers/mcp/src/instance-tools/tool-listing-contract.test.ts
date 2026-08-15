import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { McpEnv } from "../http.js";
import type { SafetyContext } from "../safety.js";
import { registerBaseTools, TOOL_TIERS } from "./base.js";

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

	it("defines every `tier` value it can return (#569)", () => {
		const d = describeTool("list_instance_tools");
		// G1: the vocabulary itself is asserted before it is iterated. An empty TOOL_TIERS would
		// otherwise pass this arm by examining nothing — the exact shape ADR 0002 exists for.
		expect(TOOL_TIERS.length, "the tier vocabulary is empty — this arm is measuring nothing").toBe(4);
		for (const [id, gloss] of TOOL_TIERS) {
			expect(d, `tier "${id}" is returned but not defined in the description`).toContain(`${id} = ${gloss}`);
		}
		console.log(`✓ #569: all ${TOOL_TIERS.length} tier values are defined in the description`);
	});

	it("keeps its copy of the tier vocabulary equal to the API worker's (#569)", () => {
		// This Worker cannot import from `workers/api` — separate deployables — so the vocabulary is
		// a copy, and a copy nobody compares is a copy that drifts. Read the source of truth as TEXT,
		// which is the only channel there is.
		const src = readFileSync(new URL("../../../api/src/lib/builtin-tool-policy.ts", import.meta.url), "utf8");
		const m = src.match(/export const TOOL_TIERS = \[([^\]]*)\] as const;/);
		// G3: a parse failure is REPORTED, never skipped — a moved declaration would otherwise turn
		// this guard off silently while it kept printing a tick.
		expect(m, "could not find `export const TOOL_TIERS = [...] as const;` in workers/api/src/lib/builtin-tool-policy.ts — the guard cannot see the source of truth any more").not.toBeNull();
		const apiTiers = [...(m as RegExpMatchArray)[1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
		expect(apiTiers.length, "parsed no tier names out of the API's TOOL_TIERS").toBeGreaterThan(0);
		expect(TOOL_TIERS.map(([id]) => id), "the MCP copy of the tier vocabulary has drifted from workers/api").toEqual(apiTiers);
		console.log(`✓ #569: MCP tier vocabulary matches the API's ${apiTiers.length}-value ToolTier`);
	});

	/**
	 * The reach advice, and why it needs its own arm (#585).
	 *
	 * #584 measured that "names a connector" is not "reaches outside the platform", in BOTH
	 * directions: `fetch_url` names no connector and reaches the internet — which is how 10 of 34
	 * instances were told they had nothing reaching outside the platform while it was `allowed` on
	 * all ten — and every `supervision` tool names one and never leaves. It shipped `reach` as the
	 * field that answers it, and the description kept recommending the disproven proxy.
	 *
	 * That is the identical failure the first arm in this file exists for (`scope` offered as the
	 * read-only answer), one clause later, in the same sentence, corrected in the same release for
	 * the neighbouring claim and missed here. Neither guard that might have caught it is at fault:
	 * `docs-drift` compares numbers and names, and #573's hash excludes `description` by design.
	 * Prose going stale against a field is simply a class neither covers, so it is asserted here.
	 */
	it("names `reach` as the answer to 'what can it get to', and stops offering `connector` (#585)", () => {
		const d = describeTool("list_instance_tools");
		expect(d).toContain("`reach`");

		// Every value it can return is defined, read from the API's own vocabulary as TEXT — the
		// same channel and the same reason as the tier arm above: this Worker cannot import it.
		const src = readFileSync(new URL("../../../api/src/lib/tool-reach.ts", import.meta.url), "utf8");
		const m = src.match(/export const TOOL_REACHES = \[([^\]]*)\] as const;/);
		// G3: a parse failure is reported, never skipped.
		expect(m, "could not find `export const TOOL_REACHES = [...] as const;` in workers/api/src/lib/tool-reach.ts — the guard cannot see the source of truth any more").not.toBeNull();
		const reaches = [...(m as RegExpMatchArray)[1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
		// G1: the vocabulary is asserted before it is iterated.
		expect(reaches, "parsed no reach values out of the API's TOOL_REACHES").toEqual(["platform", "machine", "internet"]);
		for (const value of reaches) {
			expect(d, `reach value "${value}" is returned but not defined in the description`).toContain(`\`${value}\``);
		}

		// THE REGRESSION ITSELF. Not "does not mention connector" — `connector` is a real field and
		// the description names it for other reasons. What must not recur is recommending it as the
		// way to audit REACH, which is the sentence #584 disproved.
		expect(d, "the description still offers `connector` as the way to audit external reach — #584 measured that proxy wrong in both directions").not.toMatch(
			/(audit|verify|check)[^.]*(reach|external)[^.]*filter[^.]*`connector`/i,
		);
		console.log(`✓ #585: description names reach (${reaches.join(" | ")}) and no longer offers connector as the proxy`);
	});
});
