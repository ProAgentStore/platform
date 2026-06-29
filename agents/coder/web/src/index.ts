// @proagentstore/coder-web — the coder agent's own UI surface.
//
// The first agent that "owns its screen": its UI lives here, in the agent's own
// directory, and consumes only shared platform services from @proagentstore/sdk.
// The console shell loads it via the surface registry (store/console/src/lib/surfaces.tsx).
// See ../../../PLAN-agent-os.md.

export { default as CodingTab } from "./CodingTab";
