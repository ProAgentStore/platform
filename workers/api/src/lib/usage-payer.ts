// Who pays for a usage row (#346) — the axis `cost_source` was mistaken for.
//
// `cost_micros` is NOTIONAL VALUE on every row without exception: tokens × published list price.
// Ours is computed in `ai-pricing.ts`; Claude Code's `total_cost_usd` is computed by the CLI. Both
// are the same kind of object. Anthropic's docs are explicit that the CLI's figure is priced "at
// standard list rates", "may differ from your actual bill", and that for Max/Pro subscribers "the
// session cost figure isn't relevant for billing purposes" (https://code.claude.com/docs/en/costs).
//
// So a dollar total answers "what would this have cost on the API?", never "what was anyone
// charged?". The second question needs the payer, and only the payer.
//
// Kept pure and free of D1 so the mapping — especially the one that must NOT be made — is a unit
// test rather than a claim in a comment.


/**
 * Who a row's notional value is actually charged to.
 *
 * Deliberately not derived from `provider`: `anthropic` is the VENDOR, and the same vendor is
 * reached both by a metered API key and by a subscription that meters tokens instead of dollars.
 */
/**
 * How an engine session authenticated, as the runner resolved it from the child process's merged
 * spawn env. Defined HERE, not in coding-engines.ts, because both modules need it and the runtime
 * importing the contract while the contract imports the runtime is the cycle #293 exists to
 * forbid. coding-engines.ts re-exports it, so no call site moved.
 */
export type EngineAuthResolved = "subscription" | "api-key" | "machine-login";

export type Payer = "byok-api" | "subscription" | "platform";

/** Stored as NULL: we could not establish the payer. A first-class answer, never a guess. */
export type PayerOrUnknown = Payer | null;

const PAYERS = new Set<string>(["byok-api", "subscription", "platform"]);

/**
 * The payers that correspond to money someone is actually charged.
 *
 * `subscription` is excluded because there is no marginal charge — a plan allowance is consumed
 * in tokens over a rolling window, not in dollars. Unknown (NULL) is excluded because a charge we
 * cannot establish is not a charge we may enforce; it is bounded in tokens instead.
 */
export const CHARGED_PAYERS: readonly Payer[] = ["byok-api", "platform"];

/** True when this row represents money someone owes. */
export function isCharged(payer: unknown): boolean {
	return typeof payer === "string" && (CHARGED_PAYERS as readonly string[]).includes(payer);
}

/**
 * The SQL predicate restricting an aggregate to rows that are money.
 *
 * Exported as one literal, and asserted present in every dollar aggregate by a source test,
 * because the failure mode here is a NEW sum written without it — which is exactly how #343
 * happened: `SUM(cost_micros)` with no filter, in a function whose name said "spend".
 */
export const CHARGED_SQL = "payer IN ('byok-api', 'platform')";

/** Normalize a stored value; anything unrecognised reads as unknown rather than as a payer. */
export function asPayer(v: unknown): PayerOrUnknown {
	return typeof v === "string" && PAYERS.has(v) ? (v as Payer) : null;
}

/**
 * Map what the runner OBSERVED about an engine's credential to a payer.
 *
 * The load-bearing line is the last one. `machine-login` does not mean "subscription" — it means
 * neither credential was present in the merged spawn env, so the CLI used whatever login it has
 * stored, which may be a claude.ai plan OR an API key configured inside the CLI itself. Mapping it
 * to `subscription` would be a confident inference from an absence, which is the species of error
 * this whole column exists to remove. It is also the MOST COMMON resolution (it is what the
 * default `auto` mode produces), so getting it wrong would be wrong most of the time.
 */
export function payerForEngineAuth(resolved: EngineAuthResolved | null | undefined): PayerOrUnknown {
	if (resolved === "api-key") return "byok-api";
	if (resolved === "subscription") return "subscription";
	return null;
}

/** The bucket key an unknown payer aggregates under (D1 NULL has no key). */
export const UNKNOWN_PAYER_KEY = "unknown";

/** Headline label per payer, phrased as the answer to "was I charged for this?". */
export const PAYER_LABEL: Record<string, string> = {
	"byok-api": "Billed to your API key",
	subscription: "Drawn from a subscription",
	platform: "Paid by ProAgentStore",
	[UNKNOWN_PAYER_KEY]: "Payer not established",
};

/**
 * The caveat each payer carries, for a surface with room to state it.
 *
 * The `subscription` note names usage credits on purpose: a subscriber past their allowance IS
 * being charged, we cannot detect it, and saying "no charge" flatly would trade one confident
 * wrong answer for another.
 */
export const PAYER_NOTE: Record<string, string> = {
	"byok-api": "Real money on your provider account. Estimated at list prices — see your provider's dashboard for the bill.",
	subscription: "No per-token charge; it draws your plan's allowance, which is measured in tokens over a rolling window. If you are past the allowance and drawing on usage credits, you ARE being charged and we cannot see it.",
	platform: "Our Workers AI and platform models. Costs you nothing.",
	[UNKNOWN_PAYER_KEY]: "A coding engine signed in with a login stored on your machine. That may be a subscription or an API key configured in the CLI — we cannot tell from outside, so we do not guess.",
};
