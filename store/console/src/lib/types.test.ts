import { describe, expect, it } from "vitest";
import type { KnowledgeDoc as WorkerKnowledgeDoc } from "../../../../workers/api/src/agent-types";
import type { RunnerEvent, RunnerTask } from "../../../../packages/browser-runner/src/types";
import type { Credential, KnowledgeDoc, Notification, RuntimeEvent, RuntimeTask, TriggerAction } from "./types";

/**
 * The console's API-response types, checked against the Worker declarations they copy (#617).
 *
 * ## Why this file is types, not assertions
 *
 * The divergence class this pins is invisible at runtime by construction. Both sides declared the
 * field OPTIONAL, so a console reading `doc.createdAt` off a body carrying `addedAt` type-checked
 * on both sides, threw nothing, logged nothing, and produced `undefined` forever. A unit test that
 * feeds a hand-written fixture through a reader cannot catch it either — the fixture is written
 * from the same wrong belief as the code, so it agrees with the bug.
 *
 * What catches it is comparing the two DECLARATIONS, which is what `Extra<>` below does. Each
 * assignment is a compile error when the console grows a field its producer does not have, and
 * `store/console/tsconfig.json` has `include: ["src"]`, so CI's `tsc --noEmit` compiles this file
 * and the error is a build failure rather than a comment.
 *
 * ## Scope, honestly
 *
 * Only import-safe producers are covered by type assertions: `workers/api/src/agent-types.ts` (zero
 * imports) and `packages/browser-runner/src/types.ts`. Two others were tried and cannot be reached
 * from this project, which is itself worth recording so nobody repeats it:
 *
 * · `lib/trigger-types.ts` imports `ConnectorProvider` from `connector-grants.ts`, which reaches
 *   `Env` and therefore `D1Database`/`R2Bucket`/`Workflow` — globals the console's `lib` array does
 *   not (and should not) have. A type-only import still type-checks the module.
 * · The D1-shaped responses (`Notification`, `Credential`, `Agent`) come from `SELECT *`, so their
 *   real "declaration" is a migration, not a TypeScript type.
 *
 * Those are pinned by NAME below against the column list. That is weaker, and saying so is the
 * point — the honest gap is exactly what #616 has to close, and this file deliberately does not
 * build that guard.
 */

/** The console field names the producer does not have. `never` when the two agree. */
type Extra<Console, Producer> = Exclude<keyof Console, keyof Producer>;

// ── KnowledgeDoc ─────────────────────────────────────────────────────────────────────────────
//
// The headline defect: `createdAt` here vs `addedAt` on the wire, so the doc viewer's date stamp
// (`tabs/KnowledgeTab.tsx`) rendered for nobody. Restoring either `createdAt` or `type` to the
// console interface makes the next line "Type 'string' is not assignable to type 'never'", naming
// the offending key in the error.
const _knowledgeDocHasNoInventedFields: Extra<KnowledgeDoc, WorkerKnowledgeDoc> extends never
	? true
	: never = true;

// ── RuntimeTask / RuntimeEvent ───────────────────────────────────────────────────────────────
//
// `mirrorRuntimeTask` stringifies the task whole, so the payload is a `RunnerTask` — EXCEPT for
// rows the cloud synthesises itself, which is a real second producer and not a loophole. Its one
// extra field is `reasoning` (`routes/instances-tasks.ts:328`, rendered as the WHY on the card).
// Naming it explicitly is what keeps this assertion exact: widen `CloudAdded` and you have to say
// which route writes the field and where it is read.
type CloudAdded = { reasoning?: string };

// Four invented fields lived here before #617. `handoff_field` was the expensive one — it headed a
// `||` chain in `pages/RunDetail.tsx` whose first operand could never win, so the prompt a user is
// asked to answer has always been scraped out of prose. #621 fixed it: the structured field now
// comes from the `agent.needs_input` event's `data.field` (`RuntimeEvent.data`).
const _runtimeTaskHasNoInventedFields: Extra<RuntimeTask, RunnerTask & CloudAdded> extends never
	? true
	: never = true;
const _runtimeEventHasNoInventedFields: Extra<RuntimeEvent, RunnerEvent> extends never ? true : never = true;

// ── TriggerAction ────────────────────────────────────────────────────────────────────────────
//
// `trigger-types.ts` cannot be imported here (see the header), so this restates `TRIGGER_ACTIONS`
// with its citation and checks the console's union against it exhaustively in BOTH directions: the
// console may neither drop a member (`IndexingTab` had four of the seven) nor invent one the
// validator would reject. `Record<TriggerAction, true>` is what makes it exhaustive — a member
// added to the union and not to the list fails to compile, and vice versa.
const WORKER_TRIGGER_ACTIONS: Record<TriggerAction, true> = {
	create_task: true,
	add_knowledge: true,
	sync_connector: true,
	run_pipeline: true,
	insert_record: true,
	run_browse: true,
	log_event: true,
};

describe("console response types match the Worker declarations they copy (#617)", () => {
	it("compiles — the assertions above are the test", () => {
		// The `const` assignments are erased at runtime; this arm exists so the file is a test and
		// not a silently-unrun module, and so a reader looking for the guard finds it named.
		expect([
			_knowledgeDocHasNoInventedFields,
			_runtimeTaskHasNoInventedFields,
			_runtimeEventHasNoInventedFields,
		]).toEqual([true, true, true]);
	});

	it("declares every trigger action the Worker's TRIGGER_ACTIONS has, and no more", () => {
		// The runtime half of the assertion above: the exhaustive Record catches a MISSING member at
		// compile time, and this catches the list drifting from `lib/trigger-types.ts:34` in size.
		expect(Object.keys(WORKER_TRIGGER_ACTIONS).sort()).toEqual([
			"add_knowledge", "create_task", "insert_record", "log_event", "run_browse", "run_pipeline", "sync_connector",
		]);
	});

	/**
	 * The D1-shaped responses, pinned by NAME against their migrations.
	 *
	 * Weaker than the type assertions above and deliberately so: `SELECT *` has no TypeScript
	 * declaration to compare with, so this restates the column list with its citation. It fails if
	 * someone reinstates a name the table does not have, which is the mistake that was actually
	 * made three times here.
	 */
	it("declares no notification field the notifications table lacks", () => {
		// EXHAUSTIVE on purpose. An `Array<keyof Notification>` would have been a second hand-written
		// list — the very thing this file exists to stop — and re-adding `instanceId` to the
		// interface would not have touched it. `Record<keyof Notification, true>` cannot be built
		// without naming every declared field, so a field added to the interface fails HERE, at
		// compile time, until someone names the column it comes from.
		const declared: Record<keyof Notification, true> = {
			id: true, type: true, title: true, body: true, read: true,
			created_at: true, createdAt: true, kind: true, url: true, agent_id: true,
		};
		// 0006 create + 0026 url + 0093 dedupe_key/pushed_at/kind. Note `agent_id`, NOT `instance_id`:
		// the console declared `instanceId`, so `pages/Notifications.tsx` carried a navigation branch
		// that could never be taken — and matching the producer's NAME would have been wrong too,
		// because the value is an agent id and the branch routed to /instances/. `agent_id` is now
		// declared (#622) as the fallback navigation target when `url` is absent.
		const columns = ["id", "user_id", "type", "title", "body", "agent_id", "read", "created_at", "url", "dedupe_key", "pushed_at", "kind"];
		const camelToSnake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
		for (const field of Object.keys(declared)) {
			expect(columns, `\`${field}\` is declared on Notification but the table has no such column`)
				.toContain(camelToSnake(field));
		}
	});

	it("declares the credential recovery field under the producer's name", () => {
		// `lib/credentials.ts:107` maps `recovery_history` -> `recoveryHistory`. The console called it
		// `history`. Nothing rendered it either way, so this cost the user nothing YET — it is fixed
		// because the wrong name is what the next person to build the UI would have reached for.
		const declared: Record<keyof Credential, true> = {
			id: true, domain: true, loginUrl: true, username: true,
			comments: true, recoveryHistory: true, createdAt: true,
		};
		// `CredentialSummary` (`workers/api/src/lib/credentials.ts:24`), which also carries hasPassword
		// / hasPin / hasRecoveryCodes / updatedAt / lastUsedAt. Declaring FEWER fields than the
		// producer sends is fine — this guard is about fields the console invents.
		const wire = ["id", "domain", "loginUrl", "username", "comments", "recoveryHistory", "hasPassword", "hasPin", "hasRecoveryCodes", "createdAt", "updatedAt", "lastUsedAt"];
		for (const field of Object.keys(declared)) {
			expect(wire, `\`${field}\` is declared on Credential but toView() never sets it`).toContain(field);
		}
	});
});
