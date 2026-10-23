/**
 * How large the MCP tool surface is — one place, checked against reality.
 *
 * `GET /health` answered `tools: 41` for months while the server actually
 * registered 124. That number is the only machine-readable size signal the server
 * publishes, and three docs quote the same figure in prose, so a hand-maintained
 * literal in the handler was guaranteed to rot: nothing failed when a tool was
 * added, and nothing connected the handler's number to the docs' number.
 *
 * These constants are the source both sides read, and they are asserted twice:
 *
 *  - `index.test.ts` runs the REAL registration path and compares
 *    `tools.size` — with every surface gated on, and with none — against
 *    {@link MCP_TOOL_COUNT} and {@link MCP_TOOL_ALWAYS_ON}. Add a tool, that test
 *    fails until the number here moves.
 *  - `scripts/docs-drift.mjs` compares every "N tools" claim in
 *    `platform-docs/mcp.md`, `store/llms-full.txt` and `workers/mcp/README.md`
 *    against {@link MCP_TOOL_COUNT}, and the per-surface gated table against
 *    {@link MCP_TOOL_GATED}.
 */

/** Every tool the server can register, with all surfaces gated on. */
export const MCP_TOOL_COUNT = 389;

/** Registered for every connection, whatever the user is subscribed to. */
export const MCP_TOOL_ALWAYS_ON = 362;

/** Registered only when the user has an agent with the matching console surface
 *  (`apply`, `repo`, `coding`) — so a Repo Chat user never sees `apply_to_job`. */
export const MCP_TOOL_GATED = MCP_TOOL_COUNT - MCP_TOOL_ALWAYS_ON;

/**
 * How large the surface is ALLOWED to be (#1241): {@link MCP_TOOL_COUNT} may not exceed the last
 * entry's `count`. Append-only — growing the surface means appending an entry that says why, so each
 * new tool is a recorded decision, not a drift the count test merely follows. Merging or retiring
 * tools needs no entry: the ceiling stays and the count drops under it.
 *
 * Before appending, check the tool you are adding has no sibling that already calls the same API
 * route — the #1241 audit found four such pairs (`docs/mcp-tool-audit.md` §4).
 */
export const TOOL_COUNT_CEILINGS: ReadonlyArray<{ count: number; issue: string; date: string; reason: string }> = [
	{ count: 366, issue: "#1241", date: "2026-10-20", reason: "Baseline recorded by the MCP tool surface audit." },
	{ count: 367, issue: "#1247", date: "2026-10-20", reason: "gmail_scout_scan_log: one scan's per-email decisions, paged — too large for gmail_scout_status's receipts, which link to it." },
	{ count: 369, issue: "#1267", date: "2026-10-21", reason: "list_instance_mcp_accounts / set_instance_mcp_account: per-instance account pinning for the generic MCP connector, now that an endpoint can hold several labelled accounts." },
	{ count: 372, issue: "#1275", date: "2026-10-21", reason: "get/set/reset_machine_thresholds: a machine's admission thresholds and session limit are the machine's own and had no tool at all (setGateThresholds was never called). Not siblings of set_machine_policy: that one is auto-update, naming and cleanup; these read and write the gate's lines, with partial updates and a reset." },
	{ count: 378, issue: "#1277", date: "2026-10-21", reason: "Six tools to manage a worker-backed (Cloudflare) mail connection over MCP: get_instance_email_worker (state + named blockers), begin/complete_email_worker_enrollment (secure secret handoff through the console, since no tool may carry the bridge secret), test_email_worker_connection, set_instance_email_worker_account and set_email_worker_identities. Not siblings of the generic connector tools: its secret is a per-endpoint bridge credential the model must never hold, and sender/reply identity is Cloudflare-specific." },
	{ count: 380, issue: "#1279", date: "2026-10-22", reason: "get/set_instance_gmail_identity: the verified send-as sender and inbound recipient scope an instance's Gmail is pinned to. Not siblings of set_instance_connector_account (which picks WHICH connected mailbox): this decides which address that mailbox writes as and which recipient address it may read, and is read back with the live alias list and named blockers." },
	{ count: 383, issue: "#1268", date: "2026-10-22", reason: "approval_status / get_approval_gate / set_approval_gate: the per-account approval gate. Not siblings of the permission-request tools: those resume one blocked call after a re-grant on one instance, these follow an exact held ACCOUNT change to its end and set the gate itself. Deliberately no approve or deny tool - that stays the owner's act at the console or the push link." },
	{ count: 387, issue: "#1313", date: "2026-10-23", reason: "calendar_connection_status / list_instance_calendar_grants / grant_instance_calendar / revoke_instance_calendar_grant: the owner side of the read-only Google Calendar connector (live connection state and exact-calendar grants per agent). Not siblings of the Discord or Slack grant tools: those hold bot tokens and channels; these hold an OAuth connection and calendar ids, and `grant_instance_calendar` verifies the calendar against Google with the owner's connection before storing it." },
	{ count: 389, issue: "#1312", date: "2026-10-23", reason: "get_machine_capabilities / check_capability_requirements: a machine's reported capability record (OS, browsers that actually launch, iOS/Android/Docker, Node/Playwright, a bounded tool inventory) and a dry check of job requirements against it. Not siblings of get_machine_thresholds (how loaded a machine may get) or native_preflight (a live probe of one native-control backend): this is the stored, versioned, change-tracked record the start gate reads, and the check runs that same gate without starting anything." },
];
