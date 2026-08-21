// Catalog claims lint (#66): flag catalog copy that promises a RUNTIME capability the agent's
// `capabilities` block can't back — for a store, a description that overstates what the agent
// does is an integrity bug, not polish. Heuristic + overridable, but loud: if the description
// claims a runtime capability (browser / posting / headless / local runner / cron / scheduled)
// while `capabilities.runtime` AND `capabilities.workflow` are both null, it's a mismatch.
// Pure so it can run at publish time and in CI. Consume from the create/update-agent route.
//
// ── Second family: SAFETY claims (#722)
//
// One axis was not enough. The lint checked what an agent CAN do and never what it promises NOT
// to do, so "It never sends or archives anything until you have seen exactly what it is about to
// do." shipped to the live catalog on an agent holding `gmail_send` — a tool whose own
// description to the model ends "This really sends: there is no draft step and no undo." Nothing
// implemented the sentence. The only thing behind it was prompt text in the same seed, which a
// model can decide it has satisfied — including a model reading an injected instruction in the
// untrusted mail it was asked to summarise.
//
// A safety promise is exactly the kind of claim this lint exists for, and it is the more
// dangerous kind: an overstated capability disappoints a subscriber, an overstated protection
// tells them not to watch.

/** The backing an agent declares. Only these fields decide whether a claim is honest; kept
 *  structural so it accepts the full AgentCapabilities. `tools` is the DECLARED allowlist
 *  (absent → the per-surface default, which contains no connector tool at all — see
 *  `toolNamesFor`, whose `FULL` set is memory/KB/files/collections/apply/coding and nothing
 *  reachable outside the platform). */
export interface ClaimsCapabilities {
	runtime: string | null;
	workflow: string | null;
	tools?: string[];
}

/** The copy a subscriber reads before and at first contact. Both carry claims; the welcome
 *  message is not "just UI text" — it is the first sentence of the product. */
export interface ClaimsCopy {
	description?: string | null;
	/** `config.identity.welcomeMessage`. Optional so every existing caller still compiles. */
	welcomeMessage?: string | null;
}

/** A runtime capability a description might claim, with the phrases that signal it. */
const RUNTIME_CLAIMS: Array<{ capability: string; patterns: RegExp[] }> = [
	{ capability: "browser automation", patterns: [/\bbrowser\b/i, /\bplaywright\b/i, /\bheadless\b/i, /logged-in browser/i] },
	{ capability: "posting/publishing via a runner", patterns: [/\bpublishing\b/i, /\bposting\b/i, /\bposts? (to|on)\b/i] },
	{ capability: "a local runner", patterns: [/\blocal runner\b/i, /\bruns? (them|it)?\s*(locally|on your machine)\b/i, /\btmux\b/i] },
	{ capability: "scheduled/cron runs", patterns: [/\bcron\b/i, /\bscheduled\b/i, /after every deploy/i] },
];

/**
 * Tools whose effect leaves this platform, addressed to a third party, and which nothing here
 * can take back. This is the "irreversible" half of the safety rule, and it is a hand-kept set
 * because the tool registry cannot answer the question yet: it declares `scope` and `mutates`,
 * and neither of them means reversible. A declared `reversible` field is #722's Step 3, deferred
 * — when it lands, this set is derived from the registry and deleted.
 *
 * Deliberately UNDER-inclusive rather than over. A lint that cries wolf is turned off, and every
 * name left out has a reason a reviewer can check:
 *
 *   • `gmail_archive` / `gmail_mark_read` — the tool's own description reasons about this
 *     correctly: the message stays in All Mail and can still be found by search. Reversible.
 *   • `github_create_issue` / `github_comment_issue` / `github_update_issue` — an unwanted issue
 *     is closed in a second, and a comment is editable and deletable by its author.
 *   • `sheets_append` — the owner deletes the row.
 *   • `terminal_*` / `tmux_*` / `browser_*` — local, on a machine the owner started a runner on,
 *     and reached only through that runner.
 *   • `http_request` / `mcp_call_tool` — the generic connectors, where the effect is whatever the
 *     configured endpoint does. That genuinely cannot be answered as a fixed fact here, which is
 *     the strongest argument for Step 3 rather than for guessing.
 *
 * There is no delete-mail tool anywhere on the platform, which is why none appears here.
 */
export const IRREVERSIBLE_WRITE_TOOLS: ReadonlySet<string> = new Set([
	"gmail_reply",
	"gmail_send",
	"whatsapp_send_message",
	"instagram_send_dm",
]);

/**
 * Copy that promises a HUMAN GATE ON EACH ACTION — the platform will stop, show the owner what
 * is about to happen, and wait.
 *
 * The line these patterns draw, and the whole design of this family: a claim about a STANDING
 * SWITCH the owner sets is honest, because two such switches exist (the per-agent email
 * permission, and the per-instance connector write consent from #90 — both off by default). A
 * claim about a PER-ACTION pause is not, because nothing anywhere implements one.
 *
 * That is why "consent", "permission" and "access" are absent from every alternation below while
 * "approval", "sign-off" and "before it is sent" are present. The Email Assistant's live
 * description — "It never sends anything without your explicit consent switched on first." —
 * names the switch and must not be flagged; it is the worked example of the honest version of
 * the same sentence, and a test pins it.
 *
 * Each pattern is anchored to an ACT (send/post/submit/archive/reply), never to the gate phrase
 * alone: "both are off until you turn them on" is an accurate sentence about the switches and
 * must survive.
 */
const GATE_CLAIMS: Array<{ label: string; pattern: RegExp }> = [
	// "It never sends or archives anything until you have seen exactly what it is about to do."
	{ label: "never … until you", pattern: /\bnever\s+(?:sends?|posts?|submits?|emails?|replies|archives?)\b[^.]*\buntil\s+(?:you|the user)\b/i },
	// "…and — only once they have approved — send or archive."
	{ label: "only once you have approved", pattern: /\bonly\s+once\s+(?:you|they|the user)\s+(?:have\s+|has\s+)?approved?\b/i },
	// "I will show you anything before it is sent."
	{ label: "shows you … before", pattern: /\bshows?\s+(?:you|the user)\s+(?:it|them|anything|everything|what|each|every)\b[^.]*\bbefore\b/i },
	// "…show you the reply before anything is sent." — the same promise with a different noun,
	// which is why the noun is not what this family matches on.
	{ label: "before it is sent", pattern: /\bbefore\s+(?:it|they|anything|everything|the\s+\w+)\s+(?:is|are|gets?)\s+(?:sent|posted|submitted|emailed|archived)\b/i },
	// "It never posts without your explicit approval." — note: NOT "without your consent".
	{ label: "without your approval", pattern: /\bwithout\s+your\s+(?:explicit\s+)?(?:approval|say-so|sign-?off|go-ahead|confirmation)\b/i },
	// "It asks you first before sending anything."
	{ label: "asks you before", pattern: /\basks?\s+(?:you|first)\b[^.]*\bbefore\s+(?:it|anything|sending|posting|submitting|replying)\b/i },
];

/**
 * Does the agent declare a per-action approval gate?
 *
 * Always false, honestly: no such gate exists anywhere on the platform today. #722's Step 2 is
 * the design that would add one — a third position on the per-instance connector consent
 * (`instance_connector_consent.mode` = off · ask · always), enforced in `runRegistryTool` where
 * every surface already passes. When that ships, THIS is the function to change, and the fact it
 * must consult is an AGENT-level declaration, because that is all a publish-time lint can see:
 * the consent row is per-INSTANCE and does not exist yet when an agent is created. So a creator
 * who wants to make this promise would declare it on the agent (a capability field), the console
 * would default new grants to it, and this function would read the declaration.
 *
 * Stubbing it as `false` rather than dropping the concept is deliberate: it keeps the rule
 * readable as "promises a gate ∧ holds an irreversible tool ∧ declares no gate", which is what it
 * will still be after Step 2 — instead of a rule that silently means something narrower.
 */
function declaresPerActionGate(_capabilities?: ClaimsCapabilities | null): boolean {
	return false;
}

/** The declared tools that send something outward and cannot be recalled. */
function irreversibleToolsOf(capabilities?: ClaimsCapabilities | null): string[] {
	return (capabilities?.tools ?? []).filter((t) => IRREVERSIBLE_WRITE_TOOLS.has(t));
}

/** Runtime-claim family (#66) — unchanged, including both of its early returns. */
function lintRuntimeClaims(desc: string, capabilities?: ClaimsCapabilities | null): string[] {
	if (!desc.trim()) return [];
	const backed = !!(capabilities && (capabilities.runtime || capabilities.workflow));
	if (backed) return []; // has a runtime/workflow → any runtime claim is plausibly honest
	const violations: string[] = [];
	for (const { capability, patterns } of RUNTIME_CLAIMS) {
		const hit = patterns.find((p) => p.test(desc));
		if (hit) {
			violations.push(
				`Description claims ${capability} (matched ${hit.source}) but capabilities declare no runtime/workflow. Wire the capability or rewrite the copy.`,
			);
		}
	}
	return violations;
}

/** Safety-claim family (#722) — a per-action gate promised over an irreversible tool. */
function lintSafetyClaims(copy: ClaimsCopy, capabilities?: ClaimsCapabilities | null): string[] {
	const irreversible = irreversibleToolsOf(capabilities);
	// Nothing irreversible to gate → the promise costs nothing and is nobody's business here.
	if (!irreversible.length) return [];
	if (declaresPerActionGate(capabilities)) return [];
	const fields: Array<{ field: string; text: string }> = [
		{ field: "Description", text: (copy.description || "").toString() },
		{ field: "Welcome message", text: (copy.welcomeMessage || "").toString() },
	];
	const violations: string[] = [];
	for (const { field, text } of fields) {
		if (!text.trim()) continue;
		const hit = GATE_CLAIMS.find(({ pattern }) => pattern.test(text));
		if (!hit) continue;
		violations.push(
			`${field} promises a per-action human gate ("${hit.label}", matched ${hit.pattern.source}) but the agent declares ${irreversible.join(", ")}, which sends outside the platform with no undo — and nothing on this platform stops a call to show it to the owner first (#722). Describe the switches that DO exist (the per-agent email permission, the per-instance connector write consent) or build the gate.`,
		);
	}
	return violations;
}

/**
 * Lint one agent's catalog copy against its declared capabilities. Returns a list of human
 * violation messages (empty = OK).
 *
 * Two families, deliberately independent:
 *  • RUNTIME (#66) — copy claims a capability no `runtime`/`workflow` backs. A runtime claim is
 *    honest as long as the agent declares ANY runtime or workflow (we don't check which — that's
 *    the overridable, heuristic part).
 *  • SAFETY (#722) — copy promises a per-action human gate over a tool that cannot be undone.
 *
 * Advisory in both: warnings ride alongside a 200/201, they never block the write.
 */
export function lintAgentClaims(input: ClaimsCopy & { capabilities?: ClaimsCapabilities | null }): string[] {
	const desc = (input.description || "").toString();
	return [...lintRuntimeClaims(desc, input.capabilities), ...lintSafetyClaims(input, input.capabilities)];
}
