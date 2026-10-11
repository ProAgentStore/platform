/**
 * What the platform VERIFIED about where a run's objective came from — never who typed it (#1019).
 * Mirrors the runner's type (browser-runner coding/run-objective.ts).
 *
 * `account`: submitted through the owner's authenticated account, which may be an assistant on an MCP
 * client. `supervisor`: a supervising agent's delegation. `trigger`: composed by a trigger from another
 * run's facts. There is no "owner wrote it" kind, because nothing verifies human authorship.
 *
 * A leaf on purpose: the goal type (coding-loop.ts) and the delivery state (coding-objective-delivery.ts)
 * both need it, and the delivery state already depends on the goal's action type.
 */
export type ObjectiveOrigin = { kind: "account" | "supervisor" | "trigger" | "unverified"; by?: string };
