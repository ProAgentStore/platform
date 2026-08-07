/**
 * Can this agent actually perform this trigger action? (#358)
 *
 * PURE — no D1, no Env. The capabilities are fetched by the caller (`capabilitiesForInstance`);
 * the judgement lives here so it is testable without a database stub, matching
 * `supervision-capability.ts` (#354) and `subordinate-connectivity.ts` (#259).
 *
 * Why it exists: `run_browse` needs the agent to declare `workflow: "BROWSER_TASK"` —
 * `startBrowserTask` checks it explicitly — and on one real account exactly ONE of 26 instances
 * declares it. The console offered "Run browser task" on all 26 from a hardcoded label list, and
 * the store route accepted any action for any instance, so a schedule that could never do
 * anything saved cleanly and then sat in the list looking healthy.
 *
 * So it is refused at WIRING time, for the reason `create_connection` gives for validating its
 * routing filter at create time: a filter that silently never matches stops the chain while the
 * connection still looks healthy. Identical failure, and the human is present NOW.
 *
 * Derived from the resolved capability registry rather than a second list of agent slugs, so the
 * picker and the validator read the SAME fact and cannot drift into the state this ticket is
 * about — one saying yes while the other says no.
 */
import type { AgentCapabilities } from "./agent-capabilities.js";
import { classifySubordinateConnectivity } from "./subordinate-connectivity.js";
import { TRIGGER_ACTIONS, type TriggerAction } from "./trigger-types.js";

/** What the console's action picker calls each action. Server-owned so there is one vocabulary. */
const ACTION_LABELS: Record<TriggerAction, string> = {
	create_task: "Create task",
	add_knowledge: "Add knowledge",
	log_event: "Log event",
	sync_connector: "Sync folder",
	run_pipeline: "Run pipeline",
	insert_record: "Insert record",
	run_browse: "Run browser task",
};

/**
 * The capability an action's executor demands, when it demands one.
 *
 * Only actions whose executor REFUSES appear here. `create_task`, `add_knowledge`, `log_event`,
 * `insert_record` and `run_pipeline` dispatch into the instance's own Durable Object, which every
 * instance has — being an instance is the whole requirement, exactly as being delegated TO is not
 * a capability in `supervision-capability.ts`.
 *
 * `workflow` is the fact the executor itself reads (`startBrowserTask`), not a restatement of it,
 * so a second workflow-backed action is one entry here and needs no edit in the console.
 */
interface ActionRequirement {
	/** The `capabilities.workflow` value the executor requires. */
	workflow: NonNullable<AgentCapabilities["workflow"]>;
	/** What the action does, phrased for a refusal sentence. */
	does: string;
}

const REQUIREMENTS: Partial<Record<TriggerAction, ActionRequirement>> = {
	run_browse: { workflow: "BROWSER_TASK", does: "drive a browser" },
};

/** The capability an action needs, as one short phrase — null when it needs nothing declared. */
export function triggerActionRequirement(action: TriggerAction): string | null {
	const req = REQUIREMENTS[action];
	return req ? `capabilities.workflow = "${req.workflow}"` : null;
}

/**
 * The wiring-time refusal, or null when this instance can run the action.
 *
 * A capabilities lookup that came back NULL resolves to ALLOW — the deliberate asymmetry #354
 * documents. Ownership of the instance has already been proven by the time this runs, so a null
 * is a failed read, not evidence; refusing on evidence we do not have would turn a transient D1
 * blip into "your agent cannot do this", which is the same confidently-wrong answer this ticket
 * is about, pointed the other way. The runtime gate is unaffected: `startBrowserTask` still
 * checks the workflow before it starts anything.
 */
export function triggerActionDenial(action: TriggerAction, capabilities: AgentCapabilities | null | undefined): string | null {
	const req = REQUIREMENTS[action];
	if (!req || !capabilities) return null;
	if (capabilities.workflow === req.workflow) return null;
	const declared = capabilities.workflow ? `"${capabilities.workflow}"` : "no workflow at all";
	// The cloud-only half is said HERE rather than left for the user to discover at 3am, because
	// the reflex for a runtime-shaped failure on this platform is `pags up` — and for an agent
	// with no runtime that command is a false remedy (#321, #259). Same vocabulary as
	// `classifySubordinateConnectivity`: an agent that needs no runner has no machine to fix.
	const cloudOnly = capabilities.runtime == null
		? ` ${cloudOnlyNote()} — running \`pags up\` cannot make this work.`
		: "";
	return `This agent cannot ${req.does}: doing that needs an agent declaring ${triggerActionRequirement(action)}, and this one declares ${declared}.${cloudOnly} Declare it on the agent, or pick an action this agent can run.`;
}

/** True when the instance can perform the action (the boolean half of {@link triggerActionDenial}). */
export function canRunTriggerAction(action: TriggerAction, capabilities: AgentCapabilities | null | undefined): boolean {
	return triggerActionDenial(action, capabilities) === null;
}

/** One row of the action picker: what it is called, and whether this agent can run it. */
export interface TriggerActionOffer {
	action: TriggerAction;
	label: string;
	available: boolean;
	/** Why not, in the same words the save path would use. Null when available. */
	reason: string | null;
	/** The capability the agent would have to declare, when the action needs one. */
	requires: string | null;
}

/**
 * The whole vocabulary, annotated for ONE instance — what the console renders its picker from.
 *
 * Unavailable actions are RETURNED, not filtered out. A picker that silently drops options
 * teaches nothing: the user's question is "why can't I schedule a browser run here?", and the
 * answer is the `reason` on a disabled row. It also keeps this list identical for every agent,
 * so the UI is not quietly different per instance for reasons nobody can see.
 */
export function triggerActionOffers(capabilities: AgentCapabilities | null | undefined): TriggerActionOffer[] {
	return TRIGGER_ACTIONS.map((action) => {
		const reason = triggerActionDenial(action, capabilities);
		return {
			action,
			label: ACTION_LABELS[action],
			available: reason === null,
			reason,
			requires: triggerActionRequirement(action),
		};
	});
}

/** The shared "there is no machine here" sentence, from the one place it is worded. */
function cloudOnlyNote(): string {
	return classifySubordinateConnectivity({ requiresRunner: false, hasRuntimeRow: false, relayConnected: false }).message;
}

/**
 * What to tell the owner when a scheduled browser run could not start because nothing answered.
 *
 * The old text was unconditional: "your runner is offline — run `pags up`. It'll try again next
 * schedule." For a cloud-only agent every word of that is wrong — `pags up` skips instances whose
 * `capabilities.runtime` is null, so following it prints "None of your agents need a local
 * runner" and the trigger keeps skipping — while the same agent's Settings tab says it needs no
 * runner. Two surfaces contradicting each other, and the wrong one was the one on a schedule.
 */
export function runnerSkipMessage(triggerName: string, capabilities: AgentCapabilities | null | undefined): string {
	if (capabilities && capabilities.runtime == null) {
		return `${triggerName}: ${cloudOnlyNote()} A browser run needs one, so this schedule cannot run here — check the agent's declared capabilities (runtime + workflow), or delete the trigger.`;
	}
	return `${triggerName}: your runner is offline — run \`pags up\`. It'll try again next schedule.`;
}
