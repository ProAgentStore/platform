// Admission-time write-scope refusal (#1402).
//
// The event this exists for: about 15 runs between Oct 22 and 29 were given objectives that named a
// DIFFERENT repository than the one their instance is actually registered for (proappstore-online/hiring,
// ProAgentStore/runner-router, proappstore-online/leads, …). Each one implemented the work, committed it
// locally against its OWN repo's checkout, and only then had `pags-push`'s guard (#1252) refuse at the
// actual `git push` — "this agent session is registered for: X" — with the run already parked on a
// question and finished-but-unpushed commits sitting in a disposable checkout. The guard did its job; it
// just did it as late as a transport can.
//
// This runs earlier, on the objective's own TEXT, before any coding work happens at all: `namedOtherRepo`
// (`issue-tickets.ts`) is the same `owner/repo#N` reading `namesOtherRepo`/`startIssueFor` already use to
// keep an objective's issue-number ambiguous-without-it; this is its admission-time use. It is narrower
// than the #676 act-stream guard (`repo-write-scope.ts`), which halts an actual wrong-repo WRITE command
// after it has already landed — this catches only the case where the objective SAYS it is about a
// different repo than the one admission is about to resolve the run onto, which is exactly the shape of
// every incident in the observed list above.
//
// Unknown is not a refusal, the same rule every write-scope check in this codebase follows: an objective
// naming no repo, or naming the repo this run already resolved to, passes untouched.
import type { Env } from "../types.js";
import { otherCodersOnRepo } from "./coding-duplicate-coder.js";
import { namedOtherRepo } from "./issue-tickets.js";

export interface WriteScopeAdmissionRefusal {
	reason: "write_scope";
	error: string;
	detail: { namedRepo: string; githubRepo: string | null; ownerInstanceId?: string };
}

export async function writeScopeAdmissionRefusal(
	env: Env,
	input: { userId: string; instanceId: string; githubRepo: string | null; objective: string },
): Promise<WriteScopeAdmissionRefusal | null> {
	const namedRepo = namedOtherRepo(input.objective, input.githubRepo);
	if (!namedRepo) return null;
	const others = await otherCodersOnRepo(env, input.userId, input.instanceId, namedRepo).catch(() => []);
	const ownerInstanceId = others[0]?.instanceId;
	const ownerSentence = ownerInstanceId
		? `${others.length === 1 ? "Coder" : `${others.length} coders, including`} ${ownerInstanceId} ${others.length === 1 ? "is" : "are"} registered for it.`
		: "No coder on this account is registered for it.";
	return {
		reason: "write_scope",
		error: `This objective names ${namedRepo}, not ${input.githubRepo ?? "a repository this agent has"} — refusing before any work starts rather than failing at push, the way #1252's guard does once commits already exist. ${ownerSentence}`,
		detail: { namedRepo, githubRepo: input.githubRepo, ...(ownerInstanceId ? { ownerInstanceId } : {}) },
	};
}
