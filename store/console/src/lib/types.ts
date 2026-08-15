export interface Agent {
	id: string;
	slug: string;
	name: string;
	description: string;
	category: string;
	model: string;
	visibility: "draft" | "published" | "unlisted";
	status: "active" | "inactive" | "error";
	icon_bg?: string;
	created_at: string;
	updated_at: string;
	/**
	 * The agent's stored config, as it arrives: a JSON **string** (#617).
	 *
	 * This was declared as `{ capabilities?: {…} }`, an object it has never been on the wire.
	 * `GET /v1/agents/my/agents` is `SELECT * FROM agents` (`routes/agents.ts:137`) and the column
	 * is `config TEXT NOT NULL DEFAULT '{}'` (`migrations/0001_init.sql`), so D1 hands back the raw
	 * text; `GET /v1/agents/:id` does not select the column at all (`routes/agents.ts:267`). Nothing
	 * read it, which is the only reason `agent.config?.capabilities?.surfaces` never shipped as a
	 * silent `undefined` — the declaration was an invitation to write exactly that.
	 *
	 * Parse it before use. Capabilities for RENDERING come from `Instance.capabilities`, which the
	 * server resolves; do not re-derive them here.
	 */
	config?: string;
}

/**
 * What a trigger DOES — the console's single copy of `TRIGGER_ACTIONS`
 * (`workers/api/src/lib/trigger-types.ts:34`), served on every trigger by `routes/triggers.ts:63`.
 *
 * Declared here because the console had TWO copies and they disagreed (#617): `TriggersSection`
 * carried all seven, `IndexingTab` carried four. One home means the next action added to the
 * Worker is added once here, and `types.test.ts` fails to compile if this drifts from the
 * Worker's union in either direction.
 */
export type TriggerAction =
	| "create_task"
	| "add_knowledge"
	| "sync_connector"
	| "run_pipeline"
	| "insert_record"
	| "run_browse"
	| "log_event";

export interface CustomSurface {
	id: string;
	label: string;
	icon?: string;
	/** ESM bundle exporting mount(ctx). Loaded by DynamicSurface. */
	bundleUrl: string;
	/**
	 * May this surface replace the page header while it is active? Same capability the built-in
	 * registry declares with `ownsHeader` — a published surface is not a second-class citizen.
	 */
	ownsHeader?: boolean;
}

export interface Instance {
	id: string;
	agent_id: string;
	slug: string;
	name: string;
	description?: string;
	icon?: string;
	icon_bg?: string;
	category?: string;
	status: string;
	created_at: string;
	capabilities?: {
		surfaces: string[];
		runtime?: string;
		workflow?: string;
		/**
		 * The agent's DECLARED tool allowlist (absent when it declares none, meaning the server
		 * grants a per-surface default). Tabs that are only meaningful for certain tools gate on
		 * this — see SurfaceCaps in lib/surfaces.
		 */
		tools?: string[];
		/** Phase 3: agent-published UIs, loaded dynamically from a bundle URL. */
		customSurfaces?: CustomSurface[];
		/**
		 * `boardColumns` and `settingsSchema` are DELIBERATELY not here (#617).
		 *
		 * This interface describes exactly one response — `GET /v1/instances/my/instances`, the only
		 * endpoint any consumer of `Instance` calls — and that route strips both before replying:
		 * `const { boardColumns: _bc, settingsSchema: _ss, ...lightCaps } = fullCaps;`
		 * (`workers/api/src/routes/instances.ts:315`), because the full set measured ~83 KB for 28
		 * instances. That is a considered server decision, not a bug, so the fix is on this side.
		 *
		 * Declaring them anyway bought two dead "fast paths": `InstanceDetail` passed
		 * `capabilities.boardColumns` into `BoardTab` and `capabilities.settingsSchema` into
		 * `SettingsTab`, both permanently `undefined`, so each tab silently fell back to its second
		 * fetch. `SettingsTab`'s own comment called the prop "the fast path" — an optimisation that
		 * had never once fired. Both tabs still read the real values from `/board` and `/settings`.
		 */
		/** Per-surface options; see workers/api/src/lib/surface-options.ts. */
		surfaceOptions?: Record<string, { repos?: string; drive?: boolean; copilot?: boolean }>;
	};
}

/**
 * What the shell knows about this agent's runner, so a surface can render an offline state
 * instead of discovering one by failing a relay round-trip (#378).
 *
 * Read from `GET /v1/instances/:id/runtime/status`, which the page already polls for the header
 * dot — so this is a fact being PASSED DOWN, not a second poll of the console's most expensive
 * endpoint, and the tab cannot end up contradicting the dot above it.
 */
export interface RunnerPresence {
	/** `relay.connected` — the live socket, pin-aware (#238). `null` until the first answer lands. */
	online: boolean | null;
	/** The machine that socket is (or would be) on. */
	node?: string;
	/**
	 * `diagnoseAttachment` (#237): why it isn't attached and the one command that fixes it. Absent
	 * when the status probe answered without one (a transient blip), which is why every consumer
	 * must carry its own fallback sentence rather than rendering an empty line.
	 */
	attachment?: { message?: string; remedy?: string | null } | null;
}

/** One option of a select settings field (mirrors the server type). */
export interface SettingsFieldOption {
	value: string;
	label: string;
}

/** One typed setting a subscriber configures per-instance (mirrors the server type). */
export interface SettingsField {
	id: string;
	label: string;
	description?: string;
	type: "select" | "text" | "number" | "toggle";
	options?: SettingsFieldOption[];
	default?: string | number | boolean;
	/** Saving this field also sets the voice language (option values are BCP-47 tags). */
	voiceLanguage?: boolean;
}

/** One kanban column on an agent's single work board (mirrors the server type). */
export interface BoardColumn {
	id: string;
	title: string;
	color: string;
	statuses?: string[];
	catchAll?: boolean;
}

/** A message's translation + transliteration (the Assistant's learning display). */
export interface MessageGloss {
	translation: string;
	transliteration?: string;
	/** Word-by-word [original, romanization] pairs for the interlinear grid. */
	pairs?: Array<[string, string]>;
}

export interface Message {
	id?: string;
	role: "user" | "assistant" | "system";
	content: string;
	createdAt?: string;
	/** Per-turn id of this message's saved voice audio (R2); the speaker button replays it. */
	audioKey?: string;
	/** What the live recognizer heard at end-of-turn, when it differs from `content` (#319).
	 *  Present only on voice turns where there is a second reading worth comparing. */
	dictation?: string;
	/** The turn this message belongs to, matching `agent_events.trace_id` (#514). Absent on
	 *  messages written before it existed and on the WebSocket chat path, which mints no turn id —
	 *  feedback captured on one of those keeps its snapshot and simply offers no trace link. */
	traceId?: string;
	/** Cached gloss attached server-side (renders in the same paint as the message —
	 *  only uncached messages translate client-side). */
	gloss?: MessageGloss;
	/** The API stamped this assistant message as claiming a tool result no tool produced (#406).
	 *  Computed server-side on every read, so it appears on rows written before the guard that
	 *  catches this at generation time (#395) existed. The text is still shown — the user acted on
	 *  it and deleting it would rewrite the record — but it must not read as a real answer, and the
	 *  agent no longer reads it at all. */
	fabricated?: boolean;
}

export interface RuntimeTask {
	id: string;
	type: string;
	status: string;
	title?: string;
	description?: string;
	/** The *why* behind the ticket — pipeline/audit provenance, rendered on the detail page. */
	reasoning?: string;
	input?: Record<string, unknown>;
	output?: Record<string, unknown>;
	error?: string;
	createdAt?: string;
	updatedAt?: string;
	completedAt?: string;
	/**
	 * Four fields were removed here in #617, all of them invented on this side and emitted by
	 * nothing — the mirrored payload is a `RunnerTask` verbatim
	 * (`packages/browser-runner/src/types.ts:35`, copied by `instances-runtime.ts:240`):
	 *
	 * · `result` — the runner emits `output` and `error`, both now declared above.
	 * · `needs_human` — a `TaskStatus` VALUE (`runner.ts` sets `task.status = "needs_human"`),
	 *   never a boolean field. `RunDetail` read `status === "needs_human" || task?.needs_human`,
	 *   so the dead half was masked by a correct first half.
	 * · `handoff_reason` — read nowhere.
	 * · `handoff_field` — the costly one. `RunDetail.tsx` opened its "what does it need from you"
	 *   label with `task?.handoff_field || <regex over the message> || "your answer"`. The left
	 *   operand can never win, so the prompt a user is asked to answer has ALWAYS been scraped out
	 *   of prose or defaulted to the words "your answer". Restoring it needs the runner to emit a
	 *   structured field; until then the fallback is the real implementation, not a fallback.
	 */
}

export interface RuntimeEvent {
	id: string;
	type: string;
	message?: string;
	/**
	 * There is no `timestamp` (#617), and the comment that used to sit here gave it away: it said
	 * the field "is often absent" while DECLARING IT REQUIRED. It is not often absent, it is always
	 * absent — the producer is `RunnerEvent` (`packages/browser-runner/src/types.ts:57`), which
	 * emits `createdAt`, and a repo-wide grep finds nothing writing `timestamp` onto a runtime event
	 * on either side. Readers carried `e.createdAt ?? e.timestamp` and the right operand never ran.
	 *
	 * Declared required, it also promised every FUTURE reader a string that never arrives, which is
	 * an `Invalid Date` waiting to be written.
	 */
	createdAt?: string;
	/** Runtime events carry taskId at the top level (not under data). */
	taskId?: string;
	data?: Record<string, unknown>;
}

// Coding types (CodingRepo/CodingSession/CodingEngine) live in @proagentstore/coder-web.

/**
 * A knowledge-base document, as `GET /v1/instances/:id/knowledge` sends it.
 *
 * Mirrors `KnowledgeDoc` in `workers/api/src/agent-types.ts:74`. The field names below are the
 * producer's; `types.test.ts` fails to compile if this grows one the producer does not have.
 *
 * It used to declare `createdAt`, which the producer has never sent — it writes `addedAt`
 * (`agent-do-knowledge.ts:80`, `:245`). Both sides had it optional, so nothing threw and the doc
 * viewer's date simply never appeared (#617). `type` was likewise invented here; the producer's
 * provenance fields are `source` and `sourceUrl`.
 */
export interface KnowledgeDoc {
	id: string;
	title: string;
	content?: string;
	source?: string;
	/** Where an imported doc came from — set for `source: "url"`/`"google-docs"`/`"webhook"`. */
	sourceUrl?: string;
	addedAt?: string;
	updatedAt?: string;
}

/**
 * A task in the instance Durable Object's `task:` store — the agent's own list, injected into
 * its prompt every turn (#337). Distinct from `RuntimeTask`, which is the Board.
 */
export interface AgentTaskEntry {
	id: string;
	title: string;
	description?: string;
	status: string;
	/** Provenance: "user" is owner-written and marked (user-set) in the prompt. */
	assignedBy?: "user" | "self" | "system";
	createdAt?: string;
	updatedAt?: string;
	/** Server-computed: too old to still be injected, but not deleted. */
	stale?: boolean;
}

export interface MemoryEntry {
	key: string;
	type: string;
	content: string;
	updatedAt?: string;
	source?: string;
}

/**
 * A vault credential, as `GET /v1/instances/:id/credentials` sends it — never with its secrets.
 * Mirrors `CredentialSummary` in `workers/api/src/lib/credentials.ts:24`.
 *
 * `history` was declared here and is called `recoveryHistory` on the wire
 * (`credentials.ts:107`, from the `recovery_history` column). Unlike the `KnowledgeDoc` date, this
 * one cost the user nothing yet: no component reads either name — the card renders `domain` and
 * `username` only (`tabs/KnowledgeTab.tsx:737-738`). It is fixed because the WRONG name is what a
 * future reader would have reached for, and it would have rendered blank forever.
 */
export interface Credential {
	id: string;
	domain: string;
	loginUrl?: string;
	username?: string;
	comments?: string;
	recoveryHistory?: string;
	createdAt?: string;
}

export interface Notification {
	id: string;
	type: string;
	title: string;
	body?: string;
	/**
	 * D1 has no boolean: the column is `read INTEGER NOT NULL DEFAULT 0`
	 * (`migrations/0006_notifications.sql:9`) and `SELECT *` hands back `0`/`1`. Declared as a bare
	 * `boolean` this was a lie that happens to be harmless — `0` is falsy — until someone writes
	 * `read === false`, which is never true for an unread row. `lib/nextAgent.ts:36` mirrors the
	 * same row and already had it right (#617).
	 */
	read: boolean | number;
	/**
	 * There is no `instanceId` (#617). The table's column is `agent_id`
	 * (`migrations/0006_notifications.sql:8`) and it holds an AGENT id — `routes/instances.ts:264`
	 * passes `agent.id`. So `Notifications.tsx` fell through a branch that could never be taken.
	 *
	 * This is the one row in this sweep where renaming the consumer to match the producer would
	 * have been WRONG: `navigate(`/instances/${agent_id}`)` is a broken route, not a fixed one.
	 * Modern rows carry `url` and route correctly through it (#338); a pre-#338 row with neither
	 * stays unclickable, which is a real gap and is filed separately rather than guessed at here.
	 */
	/**
	 * `/v1/notifications` returns rows straight from D1, so the wire shape is snake_case — see
	 * `NotificationLike` in lib/nextAgent.ts, which had it right. The camelCase fields below are
	 * what the page WISHED for: `createdAt` was always undefined, so every row rendered
	 * "Invalid Date". Both are declared, and readers must tolerate either.
	 */
	created_at?: string;
	createdAt?: string;
	/**
	 * `alert` = a run has stopped and is waiting for you; `update` = news (#361). Absent on rows
	 * written before migration 0093.
	 */
	kind?: "alert" | "update";
	/**
	 * Where clicking it should land — the same same-origin console path the push notification
	 * carries (#338). Stored per row since migration 0026 and returned by `SELECT *`; the list
	 * simply never read it, so an in-app row for a deploy did nothing.
	 */
	url?: string;
	/**
	 * No `data` field: the table's columns are `id, user_id, type, title, body, agent_id, read,
	 * created_at` (0006) plus `url` (0026) and `dedupe_key, pushed_at, kind` (0093). There has
	 * never been a `data` column, and `SELECT *` cannot invent one — removed in #617.
	 */
}
