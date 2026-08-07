/**
 * The trigger CONTRACT — what a trigger IS, with nothing that validates or executes one
 * (#293). A leaf: the only import is `ConnectorProvider`, as a type.
 *
 * `triggers.ts` owns execution, and reaches a long way to do it — `routes/instances-browse`,
 * `routes/push`, `pipeline-run-start`, the connection outbox. Everything that merely needs
 * to NAME an action ("this ticket, when approved, runs `run_pipeline` with this config")
 * was pulling that whole graph in for a string union: `trigger-config.ts` imported
 * `triggers.ts` for two type names while `triggers.ts` imported it back for `applyMapping`.
 *
 * Keeping the vocabulary here means a validator, a ticket, and the connection pump can all
 * speak it without depending on the executor — which is the property that lets a human gate
 * be expressible wherever an automatic edge is (see `actionable-ticket.ts`).
 *
 * `triggers.ts` re-exports every name below, so existing imports still resolve.
 */
import type { ConnectorProvider } from "./connector-grants.js";

export type TriggerType = "webhook" | "cron";
export type TriggerAction = "create_task" | "add_knowledge" | "log_event" | "sync_connector" | "run_pipeline" | "insert_record" | "run_browse";
export type TriggerEventType = TriggerType | "manual";

/**
 * The action vocabulary, as DATA (#358).
 *
 * There were three copies of it: the validator's `ACTIONS` set, the sentence in its own error
 * message, and `ACTION_LABELS` in the console's picker. The console's copy is the one that
 * mattered — it offered every action on every agent, including ones the executor refuses, so a
 * cron trigger that could never do anything saved cleanly and looked healthy in the list.
 *
 * One array, so the picker cannot offer what the validator has never heard of, and an eighth
 * action appears in both by being added here once.
 */
export const TRIGGER_ACTIONS: readonly TriggerAction[] = [
	"create_task",
	"add_knowledge",
	"sync_connector",
	"run_pipeline",
	"insert_record",
	"run_browse",
	"log_event",
];

export interface TriggerRow {
	id: string;
	user_id: string;
	agent_id: string;
	instance_id: string;
	name: string;
	type: TriggerType;
	action: TriggerAction;
	enabled: number;
	secret_token: string | null;
	schedule: string | null;
	config: string;
	last_run_at: string | null;
	next_run_at: string | null;
	failure_count: number;
	last_error: string | null;
	created_at: string;
	updated_at: string;
}

export interface TriggerConfig {
	title?: string;
	description?: string;
	source?: string;
	sourceUrl?: string;
	provider?: ConnectorProvider;
	grantId?: string;
	folderId?: string;
	limit?: number;
	query?: string;
	/** sync_connector (#20): walk subfolders of the granted root, not just its top level.
	 *  Absent/false keeps the exact pre-#20 behaviour, so existing triggers are unchanged. */
	recursive?: boolean;
	/** sync_connector (#20): how deep to walk when `recursive`. Clamped to SYNC_MAX_DEPTH. */
	maxDepth?: number;
	/** sync_connector (#20): keep a NEW document per change instead of updating in place. Opt-in,
	 *  because unexplained duplicates were the bug — an explicit version history is a choice. */
	versioned?: boolean;
	/** run_pipeline: the name of the declarative pipeline (from instance config) to run. */
	pipeline?: string;
	/** insert_record: the target collection for a webhook → collection ingest. */
	collection?: string;
	/** run_browse: the start URL for the scheduled browser task (#172), + optional dry-run. */
	url?: string;
	dryRun?: boolean;
	/** cron: randomise the fire time by ± this many minutes so runs don't land exactly on
	 *  the dot (an automation fingerprint). 0/absent = fire on schedule. */
	jitterMinutes?: number;
	/** cron (#18): the IANA zone the schedule's wall clock is read in. Absent = UTC, which is
	 *  what every trigger predating this did, so absence must keep meaning exactly that. */
	timezone?: string;
	/** #16: map inbound payload paths onto the action's fields, e.g. { title: "lead.name" }.
	 *  Absent = the existing conventions (title/description/content/text). */
	mapping?: Record<string, string>;
	/** Set by the connection pump: the run that emitted the event, so the run this action
	 *  starts can be joined to it in the trace. Not user-configured. */
	traceId?: string;
	/** run_pipeline: static run params belonging to the WIRING rather than the event (e.g.
	 *  which endpoint / which template). Merged UNDER the event payload, so a field present
	 *  on the inbound record always wins. */
	params?: Record<string, unknown>;
}
