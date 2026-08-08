/**
 * The CONNECTED TOOLS block — the connector tools an agent has, with the RESOLVED state of the
 * write gate rather than the rule that a gate exists (#399).
 *
 * ── What happened
 *
 * An owner asked a tmux agent to have another agent pull the latest code. It replied that "write
 * access is currently blocked so I can't send commands directly" and sent them to Settings to turn
 * write access on. Write access was already granted: live on that instance,
 * `terminal_run_command`, `terminal_send_keys`, `terminal_new_target` and `terminal_kill_target`
 * all read `allowed:true, reason:"ok", writeConsent:"granted"`. It also never tried — the only
 * execution recorded for the turn is `terminal_list_targets`. The agent declined work it was
 * permitted to do, invented a reason, and sent its owner to switch on a setting that was already
 * on.
 *
 * ── Why
 *
 * The list rendered `[write — needs the connector's consent]` UNCONDITIONALLY, and each tool's own
 * description repeats it ("WRITE: … requires terminal write consent"). So the model was told twice
 * per tool that a gate exists and never once told the gate was satisfied. Asked to run a command,
 * the plainest reading of its own tool list is "I need a consent I do not have" — so it refuses,
 * and helpfully explains how to grant it. Not a hallucination so much as the prompt's most natural
 * interpretation. The platform HAS the answer at that moment: `writeConsentOf` resolves it per tool
 * and `/v1/instances/:id/tools` already serves it. It simply was not put in front of the model.
 *
 * ── The rule
 *
 * State the fact, not the rule. Same family as #395 (the model asserted a platform state it had not
 * checked) and #398 (why a result is indistinguishable from a claim): in all three the platform
 * knows and does not say. A refusal is then accurate, and when it IS genuine so is the remedy —
 * which is why the block also carries, ONCE, what to do when a tool really is blocked, instead of
 * leaving each agent to compose its own version. The reported message named the right tab by luck.
 *
 * One vocabulary: the verdicts come from `writeConsentOf` in instance-tool-policy.ts, the same
 * function the tools listing and the consent gate use. A second opinion about consent living here
 * is how a prompt starts disagreeing with the gate it describes.
 */
import { writeConsentOf, type ToolWriteConsent } from "./instance-tool-policy.js";

/** A connector tool as this module reads it — the fields the verdict and the line are built from. */
export interface PromptTool {
	name: string;
	description: string;
	connector?: string;
	scope?: "read" | "write";
	jsonSchema: unknown;
}

/**
 * The bracketed state after a tool's name. Empty string for a tool with no write gate at all —
 * most tools — so the list stays readable and the label means something where it appears.
 *
 * `granted` says what the agent may DO, not merely that a check passed, because the failure this
 * fixes is an agent reading a permission note as a reason to stop. `required` names the connector:
 * the surface and the consent key are not always the same word — an instance whose surface is
 * `tmux` gets its tools from the `terminal` connector, and granting `tmux` write looks right and
 * does nothing (#351) — so an agent that names the wrong one sends its owner on the same dead
 * errand by a different route.
 */
export function consentLabel(consent: ToolWriteConsent, scope: "read" | "write", connector: string | undefined): string {
	const conn = connector ?? "this";
	if (consent === "granted") {
		return scope === "write" ? " [write — consent GRANTED, you may call this]" : "";
	}
	if (consent === "required") {
		return ` [write — consent NOT granted: this call will be refused until the owner enables write access for the ${conn} connector]`;
	}
	if (consent === "per_call") {
		return scope === "write"
			? ` [write — granted per server: a call to a server the owner has not granted is refused]`
			: ` [reads run; a request that CHANGES anything needs write access for the ${conn} connector]`;
	}
	return "";
}

/**
 * How to behave toward the labels above, stated once for every agent rather than reinvented per
 * refusal.
 *
 * Both halves are load-bearing and they fail in opposite directions. Without the first, a granted
 * tool is still read as gated (the reported defect). Without the second, an agent that genuinely
 * cannot act invents its own instruction and names a console location by luck.
 */
export const CONSENT_RULE =
	"\n\nTrust these labels — they are this agent's CURRENT, resolved permissions, not a general rule." +
	" A tool marked consent GRANTED needs nothing switched on: call it, and report what it actually" +
	" returned. Never decline a granted tool on permission grounds, and never tell the owner to enable" +
	" something without a line above saying it is not granted. When a line DOES say consent is not" +
	" granted, say exactly that, name the connector it names, and point the owner to the console →" +
	" Settings → Connections — do not attempt the call and describe what it would have done.";

/**
 * The whole block, or "" when this agent has no connector tools.
 *
 * `grantedWriteConnectors` is the instance's consent rows, read at prompt-build time. Reading them
 * per turn rather than caching is deliberate: a consent granted mid-conversation must take effect
 * on the next message, and the failure mode of a stale cache here is exactly the bug — an agent
 * insisting it is blocked while the console shows the switch on.
 */
export function connectorToolsPrompt(tools: readonly PromptTool[], grantedWriteConnectors: readonly string[]): string {
	if (tools.length === 0) return "";
	const granted = new Set(grantedWriteConnectors);
	const lines = tools.map((t) => {
		const scope = t.scope ?? "read";
		const verdict = writeConsentOf({ name: t.name, connector: t.connector, scope, description: t.description, jsonSchema: t.jsonSchema }, granted);
		return `- ${t.name}${consentLabel(verdict, scope, t.connector)}: ${t.description}`;
	});
	return (
		"\n\nCONNECTED TOOLS — external actions you can take DIRECTLY by calling the tool" +
		" (never tell the user to do it themselves, and never route it through a terminal/CLI):\n" +
		lines.join("\n") +
		CONSENT_RULE
	);
}
