/**
 * The READ-BACK half of the ask-gate: what happens when the owner approves a held-back call
 * (#722 Step 2).
 *
 * ── The invariant this file exists to hold
 *
 * The gate is evaluated when the ticket is WRITTEN and the human clicks LATER — minutes, or days.
 * Everything that made the call permissible can be withdrawn in between: the owner can revoke the
 * connector's write access, switch the tool off, or the creator can ship an agent version that no
 * longer declares it. A ticket that outlives its consent would be a stored, approvable, un-gated
 * write — the sharpest edge in the whole design, and the reason {@link recheckCallToolTicket} runs
 * at APPROVAL time and not only at creation.
 *
 * It re-checks through `instanceToolPolicy`, the same resolution the console's permission panel
 * renders, rather than a second hand-rolled copy of the three questions. A re-check that can
 * disagree with the panel the owner read is worse than none: it would refuse work the UI says is
 * allowed, or allow work the UI says is off.
 */
import type { Env } from "../types.js";
import type { CallToolTicket } from "./actionable-ticket.js";
import { logEvent } from "./events.js";
import { instanceToolPolicy } from "./instance-tool-policy.js";

/**
 * May this queued call still run? Returns a refusal string, or null when it may.
 *
 * Three withdrawals, each checked against live state rather than against what was true when the
 * card was written:
 *   • the agent no longer declares the tool (a creator shipped a narrower version);
 *   • the owner switched the tool off;
 *   • the owner revoked the connector's write access.
 *
 * Fail-closed: a policy that cannot be resolved is a refusal, because the only alternative is
 * dispatching an irreversible call on the strength of a read that did not work.
 */
export async function recheckCallToolTicket(
	env: Env,
	instanceId: string,
	userId: string,
	call: CallToolTicket,
): Promise<string | null> {
	let policy: Awaited<ReturnType<typeof instanceToolPolicy>>;
	try {
		policy = await instanceToolPolicy(env, instanceId, userId);
	} catch {
		return `This agent's tool permissions could not be read, so "${call.tool}" was not run. Try again.`;
	}
	const entry = policy.find((t) => t.name === call.tool);
	if (!entry) return `"${call.tool}" is no longer one of this agent's tools, so this approval was not carried out.`;
	if (entry.disabled || !entry.allowed) {
		return `"${call.tool}" is switched off for this agent, so this approval was not carried out. Switch it back on in Settings if you want this call to run.`;
	}
	if (entry.writeConsent === "required") {
		const label = entry.connector ?? "this connector";
		return `Write access for ${label} has been revoked since this was queued, so "${call.tool}" was not run. Re-grant it if you want this call to go ahead.`;
	}
	return null;
}

/**
 * Run an APPROVED call.
 *
 * `preApproved` is what stops this looping: without it the call would reach the ask-gate again,
 * be queued again, and the owner would approve a card that produces another card forever. It is
 * set HERE and nowhere else, and it is deliberately not a "skip the gate" flag — the gate still
 * requires the consent row to exist, so a revocation between the re-check above and the dispatch
 * below still refuses.
 */
export async function dispatchApprovedToolCall(
	env: Env,
	instanceId: string,
	userId: string,
	call: CallToolTicket,
	ticketId: string,
): Promise<{ name: string; content: string; success: boolean }> {
	const { runRegistryTool } = await import("./tool-registry.js");
	const result = await runRegistryTool(
		call.tool,
		{ env, instanceId, userId, preApprovedTicketId: ticketId },
		call.args,
	);
	await logEvent(env, {
		source: "tool",
		event: "tool_call.approved",
		message: `${call.tool} ran after approval (ticket ${ticketId})`,
		userId,
		instanceId,
		level: result.success ? "info" : "error",
		context: { tool: call.tool, taskId: ticketId, success: result.success },
	}).catch(() => undefined);
	return { name: result.name, content: result.content, success: result.success };
}
