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
 * The list is CLOSED (#493).
 *
 * ── What happened
 *
 * An owner asked a tmux Operator four times for the open GitHub issues. It has seven tools, all
 * `tmux_*`, and no `github_*` at any scope. It answered: "Can you tell me the GitHub organisation
 * or repo name so I can pull up the issues right now?" — was given the repo — and asked for it
 * again. It never had a tool that could pull up an issue, with or without the name.
 *
 * ── Why
 *
 * Nothing said the list was exhaustive. `CONSENT_RULE` above is entirely about tools the agent
 * HAS; the block header describes what is listed and says nothing about what is not. Meanwhile
 * `selfDescriptionPrompt` closes the console TAB list with an explicit NEVER ("if a tab is not in
 * that list, it does not exist for you"). One enumeration in the prompt is closed and the other is
 * not, so the model reads the open one as illustrative — and under an owner insisting three times
 * that the capability exists, the plainest available reading is "I must be missing a parameter".
 * So it asked for one.
 *
 * ── The claim, and the one it is deliberately NOT making
 *
 * "You have no way to reach it" would be FALSE, and the issue proposed it. `fetch_url` is in BASE
 * (`agent-do-tools.ts`), and BASE is seeded even under a declared `capabilities.tools` allowlist,
 * so every agent can fetch a public URL — a public repo's issues included. Closing the list on an
 * absolute the platform cannot honour would install exactly the class of false statement this
 * fixes. What IS true, and sufficient: nothing outside this list has a DEDICATED tool, so the
 * offer to look it up is a promise about a call that cannot be made. Hence the last clause, which
 * is the operative one — a general-purpose attempt has to happen in the same reply and be
 * reported, rather than announced for a turn that never comes.
 *
 * ── Why it says not to send the owner to Settings
 *
 * It sits next to a rule that ends by pointing at console → Settings → Connections, which is the
 * right remedy for a listed tool whose consent is not granted and the wrong one here: a subscriber
 * can DISABLE tools (`config.disabledTools`) but cannot add one — `toolNamesFor` resolves the set
 * from the agent's definition. "Ask your owner to connect GitHub in Settings" is the same wasted
 * errand as the original, by a different route.
 */
export const TOOL_LIST_CLOSED =
	"\n\nThis list is COMPLETE: it names every external system you are connected to. A system that is" +
	" NOT on it — a code host, an issue tracker, a chat platform, a database — is one you have no tool" +
	" for. Say so plainly and name what you do have instead; do NOT send the owner to Settings for it," +
	" because this toolset is fixed by the agent's definition and is not a switch they can flip." +
	" Never ask for a detail (a repo, an org, an account, a URL) that only a tool absent from this list" +
	" could use, and never offer to look something up in a system that is not listed. If you mean to" +
	" try a general-purpose tool you DO hold, call it in the SAME reply and report what it returned —" +
	" never promise a lookup you have not made.";

/**
 * Protocol for driving interactive CLIs (Claude Code, Codex, Grok, REPLs) through a terminal
 * connector. Stated once here and injected into every agent that carries terminal/tmux tools so
 * the rule is not rediscovered per-incident.
 *
 * The three rules correspond to the three distinct failure points seen in production (#483):
 *   1. False "ready" — the CLI was launched but the TUI had not painted yet. The agent reported
 *      "up and ready" and the user's first message was silently dropped.
 *   2. Missing Enter — the text was sent but never submitted because `send_keys` was called with
 *      text only, without a trailing Enter. `tmux_send_message` encodes the correct sequence.
 *   3. No confirmation — after sending, the agent reported success without re-capturing the pane,
 *      so it could not tell whether the message had actually landed.
 *
 * `tmux_send_message` (from #482) encodes the correct text+Enter+quiesce sequence, making the
 * first two rules tool-enforced rather than prompt-only. The re-capture step remains prompt-only
 * because the tool already returns the post-settle pane; the rule is about how to interpret the
 * `changed` field rather than what to call.
 */
export const TERMINAL_CLI_PROTOCOL =
	"\n\nINTERACTIVE CLI PROTOCOL — follow this every time you drive an interactive CLI" +
	" (Claude Code, Codex, Grok, a REPL, or any program that paints its own input prompt):" +
	"\n1. WAIT FOR READY: after launching a CLI, do NOT assume it is ready. Re-capture the pane" +
	" until its own input prompt is visible (e.g. '>' or the CLI's cursor). Never report" +
	" 'ready' or 'up' based on the launch call alone — the TUI takes time to paint." +
	"\n2. SUBMIT WITH ENTER: to send a message or instruction to the CLI, use `tmux_send_message`" +
	" (text + Enter in one atomic call). If that tool is not available, send the text first" +
	" then call `tmux_send_keys` with keys:\"Enter\" — never send text without a following Enter." +
	"\n3. CONFIRM IT LANDED: check the result's `changed` field. If changed is false, the input" +
	" did not land — the CLI was not at its input prompt. Re-capture, wait, and resend." +
	" Never report success when changed is false.";

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
	const hasTerminalTools = tools.some((t) => t.connector === "terminal" || t.connector === "tmux");
	return (
		"\n\nCONNECTED TOOLS — external actions you can take DIRECTLY by calling the tool" +
		" (never tell the user to do it themselves, and never route it through a terminal/CLI):\n" +
		lines.join("\n") +
		CONSENT_RULE +
		// After CONSENT_RULE, not before: the two cover disjoint cases and each names its own
		// trigger ("a line DOES say consent is not granted" vs "a system NOT on it"), but the
		// closure is the stronger statement and reads as one only at the end of the enumeration.
		TOOL_LIST_CLOSED +
		(hasTerminalTools ? TERMINAL_CLI_PROTOCOL : "")
	);
}
