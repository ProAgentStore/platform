// Goes and looks at what the signed-in user has, for the landing decision (#794).
//
// The DECISION is `lastRoute.ts`'s `landingRoute`; this module only reads the two counts it
// takes. Split that way because the decision is the part worth testing as a value and the
// fetching is the part that cannot be — the same seam the rest of the console's `lib/` follows.
//
// Each count is read independently, so one failing endpoint cannot erase the other's answer, and
// a failure is reported as `null` rather than `0`. That distinction is the whole point: `0` says
// "this account has none", which is what would route a user with fifty instances to the public
// catalogue; `null` says nobody could look, and `landingRoute` falls back to Instances for it.

import { api } from "@proagentstore/sdk/client";
import type { LandingCounts } from "./lastRoute";
import type { Agent, Instance } from "./types";

async function instanceCount(): Promise<number | null> {
	try {
		const d = await api<{ instances: Instance[] }>("/v1/instances/my/instances");
		return (d.instances || []).length;
	} catch {
		// NULL, never 0 — see the header. `api()` has already filed the durable error row.
		return null;
	}
}

async function agentCount(): Promise<number | null> {
	try {
		const d = await api<{ agents: Agent[] }>("/v1/agents/my/agents");
		return (d.agents || []).length;
	} catch {
		// NULL, never 0 — see the header. `api()` has already filed the durable error row.
		return null;
	}
}

/** Both counts, in parallel. Never throws: a failed read arrives as `null`. */
export async function readLandingCounts(): Promise<LandingCounts> {
	const [instances, agents] = await Promise.all([instanceCount(), agentCount()]);
	return { instances, agents };
}
