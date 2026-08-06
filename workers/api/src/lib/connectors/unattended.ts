/**
 * Unattended credential survivability (#181).
 *
 * Authorization-code OAuth encodes "the user is present and consents right now". A chain firing
 * at 3am from a cron trigger has nobody present. Whether a connector's credential SURVIVES that
 * is a property of the connector, and the platform has to know it before the wiring is saved —
 * not discover it ~24h later from a pile of dead letters.
 *
 * Two distinct things live here, and only one of them has teeth today:
 *
 *  • `classifyDeliveryFailure` — immediate and real. The outbox (0058) treats every failure the
 *    same, so a 401 from an expired grant burns all five attempts across ~4.25 hours before
 *    dead-lettering with a transport-level message. Replay cannot fix an expired credential, so
 *    every one of those attempts was known-doomed at the first. An auth failure should
 *    dead-letter at once, saying "reconnect X".
 *
 *  • `unattendedClassOf` + `unattendedWiringWarning` — the model, currently DORMANT by design.
 *    No connector shipped today is `interactive-only` (see the table below), so the warning has
 *    nothing to fire on yet. It lands first deliberately: `dcr-oauth2` (#180) is what would
 *    introduce the first interactive-only connector, and introducing it into a platform that
 *    cannot express "this cannot run unattended" is how the class of bug in this ticket happens
 *    again.
 *
 * Everything here is pure — no env, no fetch, no D1 — so the bounds and the classification are
 * testable directly.
 */
import type { Connector } from "./registry.js";

/**
 * How well a connector's credential survives with no human present.
 *
 *  yes              — nothing expires from the user's side. A stored machine token, a
 *                     GitHub-App installation token minted per call, or no credential at all.
 *  refresh          — a durable refresh token mints access tokens unattended. Survives, as long
 *                     as the grant itself is not revoked.
 *  interactive-only — the credential can only be obtained with a human at a browser, and it
 *                     expires. Wiring this into anything automatic schedules a future outage.
 */
export type UnattendedClass = "yes" | "refresh" | "interactive-only";

/** Rank for "which is worse" comparisons — higher is more fragile. */
const SEVERITY: Record<UnattendedClass, number> = { yes: 0, refresh: 1, "interactive-only": 2 };

/** The most fragile of a set of classes ("yes" for an empty set — nothing to worry about). */
export function worstUnattendedClass(classes: readonly UnattendedClass[]): UnattendedClass {
	let worst: UnattendedClass = "yes";
	for (const c of classes) if (SEVERITY[c] > SEVERITY[worst]) worst = c;
	return worst;
}

/**
 * A connector's unattended class: its own declaration when it makes one, else derived from the
 * auth type — which is already the thing that determines survivability, so deriving keeps the
 * two from drifting apart:
 *
 *   none  → yes      no cloud credential exists (runner-relay connectors, supervision)
 *   app   → yes      GitHub-App installation tokens are minted per call from the App key
 *   token → yes      a stored opaque/platform token; nothing refreshes because nothing expires
 *   oauth → refresh  a stored refresh token is exactly the durable-credential case
 *
 * Note what is NOT here: no shipped connector derives to `interactive-only`. That is a true
 * statement about the current registry, not an oversight — see the file header.
 */
export function unattendedClassOf(connector: Pick<Connector, "auth" | "unattended">): UnattendedClass {
	if (connector.unattended) return connector.unattended;
	return connector.auth === "oauth" ? "refresh" : "yes";
}

/**
 * Derive the class from a discovered authorization server's `grant_types_supported` (#180).
 *
 * This is where the real signal lives for a user-named endpoint: the operator cannot know at
 * build time whether some MCP server the subscriber points at issues refresh tokens, but the
 * server's own RFC 8414 metadata says so. A server advertising `refresh_token` can be kept
 * connected unattended; one advertising only `authorization_code` cannot, whatever else it
 * supports.
 */
export function unattendedFromGrantTypes(grantTypes: readonly string[]): UnattendedClass {
	return grantTypes.some((g) => g.trim().toLowerCase() === "refresh_token") ? "refresh" : "interactive-only";
}

// ── failure classification ───────────────────────────────────────────────────

/**
 * Why a delivery attempt failed, to the only resolution the outbox cares about.
 *
 *  auth      — the credential is rejected. Retrying is pointless: no amount of backoff makes an
 *              expired grant valid, and a replay of the same row will fail identically. Needs a
 *              human to reconnect.
 *  transient — anything else. The dependency may recover; that is what backoff is for.
 */
export type DeliveryFailureKind = "auth" | "transient";

/**
 * Auth-failure signatures, matched against a failure message.
 *
 * Deliberately narrow. Misclassifying a transient failure as `auth` throws away the retry that
 * would have succeeded, which is a worse outcome than the status quo — so anything ambiguous
 * stays `transient` and simply retries as it does today.
 */
const AUTH_STATUS = /\b(401|403)\b/;
const AUTH_PHRASES = [
	"unauthorized",
	"unauthorised",
	"forbidden",
	"invalid_token",
	"invalid token",
	"invalid_grant",
	"invalid grant",
	"token expired",
	"token has expired",
	"expired token",
	"access token expired",
	"credential expired",
	"is not connected",
	"reconnect it in settings",
	"rejected the credential",
	"no credential connected",
	"authentication failed",
	"revoked",
];

/**
 * Classify a failed attempt. `status`, when the caller has one, is authoritative; otherwise the
 * message is matched.
 *
 * A bare 401/403 appearing in a message is treated as auth even without a phrase, because the
 * platform's own connector errors carry the status and little else ("Could not refresh
 * google_sheets access (401). Reconnect it in settings.").
 */
export function classifyDeliveryFailure(message: string, status?: number): DeliveryFailureKind {
	if (status === 401 || status === 403) return "auth";
	const m = String(message ?? "").toLowerCase();
	if (!m) return "transient";
	if (AUTH_STATUS.test(m)) return "auth";
	return AUTH_PHRASES.some((p) => m.includes(p)) ? "auth" : "transient";
}

/**
 * The dead-letter message for an auth failure. Says the one thing the reader can act on —
 * five backoff attempts against a 401 are noise; "reconnect X" is a task.
 */
export function reconnectMessage(label: string, detail?: string): string {
	const base = `${label} needs to be reconnected — its credential was rejected, and retrying cannot fix that.`;
	const d = String(detail ?? "").trim();
	return d ? `${base} (${d.slice(0, 300)})` : base;
}

// ── wiring-time warnings ─────────────────────────────────────────────────────

/** The kind of edge a connector is being wired into. Both run with nobody present. */
export type UnattendedEdge = "cron" | "connection";

const EDGE_LABEL: Record<UnattendedEdge, string> = {
	cron: "a scheduled (cron) trigger",
	connection: "an agent-to-agent connection",
};

/**
 * The warning for wiring `connectorLabel` into an unattended edge, or null when it will survive.
 *
 * A warning, not a rejection: the wiring may still be what the user wants (they may intend to
 * reconnect daily, or be testing), and refusing it would be the platform overruling an owner
 * about their own automation. The failure mode being prevented is not knowing.
 */
export function unattendedWiringWarning(
	connectorLabel: string,
	klass: UnattendedClass,
	edge: UnattendedEdge,
): string | null {
	if (klass !== "interactive-only") return null;
	return `${connectorLabel} can only be authorized with you present at a browser, and its access expires. Wired into ${EDGE_LABEL[edge]} it will run until the credential lapses and then stop until you reconnect it.`;
}

/**
 * Every connector a pipeline's steps reach, in declaration order, de-duplicated.
 *
 * `resolve` maps a registry tool name to its connector id (the registry is the authority; it is
 * injected rather than imported so this stays pure and testable). A tool the registry does not
 * know is skipped — validating tool names is the pipeline validator's job, not this one's.
 */
export function connectorsUsedByPipeline(
	steps: readonly { tool?: unknown }[] | undefined,
	resolve: (tool: string) => string | undefined,
): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const step of steps ?? []) {
		const tool = typeof step?.tool === "string" ? step.tool.trim() : "";
		if (!tool) continue;
		const connector = resolve(tool);
		if (!connector || seen.has(connector)) continue;
		seen.add(connector);
		out.push(connector);
	}
	return out;
}

/**
 * Warnings for wiring a whole pipeline into an unattended edge — one per fragile connector it
 * reaches. Empty means every credential on that path survives with nobody present.
 */
export function pipelineWiringWarnings(
	connectorIds: readonly string[],
	lookup: (id: string) => Pick<Connector, "label" | "auth" | "unattended"> | undefined,
	edge: UnattendedEdge,
): string[] {
	const out: string[] = [];
	for (const id of connectorIds) {
		const connector = lookup(id);
		if (!connector) continue;
		const warning = unattendedWiringWarning(connector.label, unattendedClassOf(connector), edge);
		if (warning) out.push(warning);
	}
	return out;
}
