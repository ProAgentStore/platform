import { describe, expect, it } from "vitest";
import { RESUMABLE_STOP_REASONS } from "../../../api/src/lib/stop-reasons.js";
import { registerCompositionTools } from "./composition.js";

/**
 * A description is the only documentation an MCP caller reads (#1019): `continue_instance_run` must name every stop
 * reason the API actually continues, so an agent is never told a continuable run cannot be continued. Read against
 * the API's own `RESUMABLE_STOP_REASONS`, so a reason added there turns this red until the description says it.
 */
describe("continue_instance_run describes exactly what continues", () => {
	const described = new Map<string, string>();
	registerCompositionTools({ tool: (name: string, description: string) => described.set(name, description) } as never, {
		env: { API_BASE: "https://api.test" },
		tokenFor: () => "session-token",
		safetyFor: () => ({ env: { API_BASE: "https://api.test" }, subject: "user-1", scopes: ["read"] }),
	} as never);
	const description = described.get("continue_instance_run") ?? "";
	// The API's own list, imported from the import-free table (#1354) rather than regex-read out of its source.
	const resumable: readonly string[] = RESUMABLE_STOP_REASONS;

	it("names every resumable stop reason, including engine_auth and constraint_refused", () => {
		expect(resumable).toEqual(expect.arrayContaining(["engine_auth", "constraint_refused"]));
		for (const reason of resumable) expect(description, reason).toContain(`\`${reason}\``);
	});

	it("says what is refused instead of a blanket 'anything else'", () => {
		expect(description).not.toContain("anything else is refused");
		for (const verdict of ["done", "cancelled", "escalated", "no_progress", "budget"]) expect(description, verdict).toContain(`\`${verdict}\``);
	});
});
