// @proagentstore/coder-web — the coder agent's own UI surface.
//
// The first agent that "owns its screen": its UI lives here, in the agent's own
// directory, and consumes only shared platform services from @proagentstore/sdk.
// The console shell loads it via the surface registry (store/console/src/lib/surfaces.tsx).
// See ../../../PLAN-agent-os.md.

export { default as CodingTab } from "./CodingTab";
export { default as BusyHoldNotice } from "./BusyHoldNotice";
export { type LastLoopStart, postLoopStart } from "./loop-start";
export { busyHoldFrom, type BusyHold, LOOP_WATCH_BADGE_CLASS, engineSigninRefusal, LOOP_START_PENDING, loopEndLabel, loopQueuedNotice, loopRequestKey, type LoopStartAnswer, loopWatchBadge, readLoopStart, type LoopWatchBadge } from "./coding-loop-run";
export { isTransientStatus, relayVerdict, type RuntimeStatusAnswer } from "./runner-online";
