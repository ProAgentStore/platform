/**
 * "Why is my agent not working", answered on the Runner card (#929 finding 7).
 *
 * `GET /v1/instances/:id/coding/diagnostics` is the one read that puts the live runner verdict
 * (#880/#922), the machine's warnings (#924) and every session and sign-in problem in one list,
 * each with its fix — and until now only MCP read it. Pure, so the wording is asserted directly.
 */
import { humanDetail } from "./runnerPanel";

export interface DiagnosticIssue {
	severity: "error" | "warn" | "info";
	message: string;
	fix?: string;
}

/** The part of the diagnostics answer this card reads (worker: `routes/coding-diagnostics.ts`). */
export interface CodingDiagnostics {
	summary: {
		runnerOnline: boolean;
		/** The ONE live status — never the registration's last word (#880). */
		runnerStatus: string;
		activeSessions: number;
		healthySessions: number;
		needsReauth: boolean;
		issueCount: number;
	};
	issues: DiagnosticIssue[];
}

/** One sentence over the list: the live status and how many problems are worth reading. */
export function diagnosticsHeadline(d: CodingDiagnostics): string {
	const s = d.summary;
	const runner = s.runnerOnline ? "Runner online" : `Runner ${s.runnerStatus}`;
	const sessions = s.activeSessions ? ` · ${s.healthySessions} of ${s.activeSessions} active sessions healthy` : "";
	const signIn = s.needsReauth ? " · the coding engine is waiting for you to sign in" : "";
	const problems = s.issueCount ? ` · ${s.issueCount} problem${s.issueCount === 1 ? "" : "s"} found` : " · no problems found";
	return `${runner}${sessions}${signIn}${problems}`;
}

/** A fix in the console's words: the MCP tool names it carries are this card's own controls. */
export function consoleFix(fix: string | undefined): string {
	return humanDetail(fix)
		.replace(/\s*\(set_instance_runner_node\)/g, " (Runs on, below)")
		.replace(/\bset_instance_runner_node\b/g, "Runs on")
		.replace(/\bcall runner_update\b/gi, "update its CLI from Terminals")
		.replace(/\brunner_update\b/g, "Update CLI on Terminals");
}

/** Errors first, then warnings, then notes — the order a reader should act in. */
export function orderedIssues(issues: readonly DiagnosticIssue[]): DiagnosticIssue[] {
	const rank = { error: 0, warn: 1, info: 2 } as const;
	return [...issues].sort((a, b) => rank[a.severity] - rank[b.severity]);
}
