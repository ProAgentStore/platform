// What an agent is allowed to say about ITSELF — derived from capabilities, never narrated (#254, #255).
//
// The failure this exists to stop, in one line: **an agent that cannot describe its own
// configuration will confabulate about it, in both directions.** The same production instance did
// both within two days:
//
//   • over-reported — asked to "just do it" with no action tool, it invented a pipeline named
//     "coding", failed, and told the user the engine was running (the bug `start_work` fixed)
//   • under-reported — after `start_work` really did run `git pull` on the user's machine, a direct
//     challenge ("did YOU pull it?") flipped it to *"I did not pull anything. I have no ability to
//     run shell commands"*, and it told the user to redo work that was already done
//
// Neither is a wording accident. The prompt asserted, as a NEVER, that the agent could not act —
// written when `drive:false` had removed the engine tools and nothing had replaced them — and kept
// asserting it after `start_work` was added to BASE. Faced with evidence from its own tool results
// contradicting its own instructions, the model believed the instructions.
//
// So the rule here is the same one `toolBlurbFor` states for tools: a self-description that the
// agent's real capability set contradicts is not cosmetic — the model believes the story. Every
// sentence below is therefore DERIVED from the resolved capabilities:
//
//   canStartWork  ← does it have a separate executor `start_work` can hand a goal to?
//   canDrive      ← may its chat type into the engine (`send_to_cli`)?
//   hasCodeIndex  ← does it genuinely have a vector index of code (the `repo` surface)?
//   singleRepo    ← `surfaceOptions.coding.repos === "single"` — read ONLY by the console before
//                   this, so an agent configured to own exactly one repository was never told so.
//   tabs          ← the console tabs it actually has, so it can never send a user to one it lacks.
//
// Pure and exported so the wording is unit-testable and cannot drift per call site.
import { toolNamesFor } from "../agent-do-tools.js";
import { DEFAULT_LOOP_DRIVER, loopDriverFor } from "./loop-drivers.js";
import { optionsFor } from "./surface-options.js";
import type { AgentCapabilities } from "./agent-capabilities.js";

/** What an agent can truthfully say about itself. Every field derived, none configured. */
export interface SelfModel {
	surfaces: readonly string[];
	/** Console tabs this agent actually renders — the only ones it may name. */
	tabs: readonly string[];
	/** Can it hand a goal to a SEPARATE executor (its Pilot) via `start_work`? */
	canStartWork: boolean;
	/** May its chat type into the engine (`send_to_cli`)? `drive:false` says no. */
	canDrive: boolean;
	/**
	 * Can it hand a goal to an agent it SUPERVISES (`delegate_goal`)?
	 *
	 * A third way to act, and the one the #254 prompt had no branch for: a Coder Lead has no
	 * executor of its own and no drive tools, so it fell into "you cannot act at all" — which is
	 * false for the only thing it exists to do, and is half of why it retracted a true delegation
	 * report (#318).
	 */
	canDelegate: boolean;
	/** Does it have a real vector index of code (the `repo` surface / Repo Chat)? */
	hasCodeIndex: boolean;
	/**
	 * Does it have a LOCAL runner at all (`capabilities.runtime !== null`)?
	 *
	 * `pags up` is an instruction about a named capability, and a cloud-only agent has no runner to
	 * start — `up.ts` skips those instances entirely ("None of your agents need a local runner").
	 * Telling their owner to run it is the same failure as naming a tab that is not there, so the
	 * prompt asks this rather than assuming every developer-facing agent has one.
	 */
	hasRunner: boolean;
	/** Does it own exactly ONE repository (`surfaceOptions.coding.repos === "single"`)? */
	singleRepo: boolean;
	/**
	 * The resolved tool set, so a prompt can NAME a tool only when the agent has it.
	 *
	 * Added by #315's guard on its first run, which found two sentences naming tools their reader
	 * did not have: `executionAuthorityPrompt` pointed a Coder Lead at `subordinate_status` (the
	 * Lead declares `list_subordinates`, `delegate_goal`, `check_delegation` — not that one), and
	 * the coding STYLE block told every coding agent to "file a GitHub issue with
	 * `github_create_issue`" when only the Repo Coder declares the GitHub connector. Naming an
	 * absent tool is the over-reporting half of the same failure: the model is told about a schema
	 * it will never be shown, so it either invents a call or deflects the request.
	 */
	tools: ReadonlySet<string>;
	/**
	 * Can it operate the VOICE CHANNEL — start, stop, mute or switch the microphone (#340)?
	 *
	 * False for every agent today, and that is the point of deriving it rather than hardcoding the
	 * denial. Voice is a client feature: the mic belongs to the app the user speaks through, exit
	 * phrases are matched there, and no tool in the catalog reaches it. So an agent replying "Got it.
	 * Stopped." is asserting an action nothing could have performed — and could only have SEEN the
	 * words because the client failed to match them, which makes it a confirmation that fires
	 * exclusively on failure.
	 *
	 * Derived from the resolved tool set against {@link VOICE_CONTROL_TOOLS}, which is empty of real
	 * tools on purpose: it is the hook that makes `no-voice-control` a live check instead of a
	 * constant. #254 is the precedent — "you do not drive the engine" was true when written and went
	 * false the day `start_work` joined BASE, with nothing to notice. If a voice-control tool is ever
	 * added, this flips, the denial becomes a lie, and the guard fails before it ships.
	 */
	controlsVoice: boolean;
}

/**
 * Tools that would let an agent operate the microphone or voice mode.
 *
 * Deliberately empty. The platform has no such tool and no plan for one — voice lives entirely in
 * the client (`packages/sdk/src/voice/*`), which is why an exit phrase never reaches the model at
 * all. Named and consulted anyway so that adding one is what turns `controlsVoice` true, rather than
 * someone remembering that a prompt line elsewhere needs revisiting.
 */
export const VOICE_CONTROL_TOOLS: readonly string[] = [];

/**
 * The tabs a set of capabilities renders, mirroring `store/console/src/lib/surfaces.tsx`.
 *
 * A second copy of a predicate is a drift risk, and normally the answer would be to share one
 * module. It cannot be shared here: the registry's entries are React components in the console
 * bundle, and the Worker cannot import them. What CAN be shared is the decision, which is a pure
 * function of `surfaces` + `tools` — so this table restates only that, and `agent-self-description.test.ts`
 * pins the result for every first-party agent so a divergence shows up as a failing test rather
 * than as an agent telling a user to open a tab that is not there.
 */
const KB_TOOLS = ["search_knowledge", "list_knowledge", "read_knowledge", "add_knowledge", "update_knowledge", "delete_knowledge"];
const COLLECTION_TOOLS = ["create_collection", "list_collections", "insert_record", "query_records", "update_record", "delete_record"];

export function tabsFor(capabilities: AgentCapabilities): string[] {
	const s = capabilities.surfaces ?? [];
	const declared = capabilities.tools;
	// "Not declared" is permissive, exactly as the console's `canUse` treats it: an agent that
	// declared no allowlist gets the per-surface default server-side, so the tab set cannot be
	// narrowed from a declaration that does not exist.
	const canUse = (names: readonly string[]) => !declared || names.some((n) => declared.includes(n));
	const tabs = ["Assistant"];
	if (s.includes("apply")) tabs.push("Apply");
	if (!s.includes("apply") && !s.includes("repo")) tabs.push("Board");
	if (s.includes("repo")) tabs.push("Repo");
	if (s.includes("coding")) tabs.push("Coding");
	if (s.includes("tmux")) tabs.push("Terminal");
	// Stats is universal, exactly like Behaviour: the console registers it with `show: () => true`
	// (#312), deliberately NOT gated on "has cards", because the empty state is where a subscriber
	// finds out the tab exists. It was missing here — the console shipped it in #311 and this table
	// was not updated — so every agent was being told "your console has exactly these tabs" with
	// Stats absent, while `get_stats`' own description points at "the Stats tab". That is the #315
	// class, live and found by the guard this comment ships with, six hours after it appeared.
	tabs.push("Activity", "Stats", "Knowledge", "Behaviour");
	if (s.includes("repo") || canUse(KB_TOOLS)) tabs.push("Indexing");
	if (canUse(COLLECTION_TOOLS)) tabs.push("Data");
	tabs.push("Settings");
	return tabs;
}

/** Resolve what this agent actually is. */
export function resolveSelfModel(capabilities: AgentCapabilities): SelfModel {
	const tools = toolNamesFor(capabilities);
	return {
		surfaces: capabilities.surfaces ?? [],
		tabs: tabsFor(capabilities),
		// BOTH conditions: `start_work` is in BASE so every agent HAS the tool, but its handler
		// refuses on an agent whose only executor is this same chat ("recursion dressed as
		// delegation"). Telling such an agent it can hand work to an executor would be exactly the
		// story-the-tools-contradict failure this module exists to prevent.
		canStartWork: tools.has("start_work") && loopDriverFor(capabilities).id !== DEFAULT_LOOP_DRIVER.id,
		canDrive: tools.has("send_to_cli"),
		canDelegate: tools.has("delegate_goal"),
		hasCodeIndex: (capabilities.surfaces ?? []).includes("repo"),
		hasRunner: (capabilities.runtime ?? null) !== null,
		tools,
		singleRepo: optionsFor(capabilities, "coding")?.repos === "single",
		controlsVoice: VOICE_CONTROL_TOOLS.some((t) => tools.has(t)),
	};
}

/**
 * What this agent may claim about work being done — the direct fix for #254.
 *
 * Three genuinely different agents, three different truths, and the previous prompt gave all of
 * them the strictest one:
 *
 *   • an executor agent (Repo Coder): it does not type into the terminal, but `start_work` really
 *     does run commands on the user's machine. "NEVER claim you ran commands" is right; "you do
 *     not drive the engine" was read as "nothing you do reaches it", which is false.
 *   • a driving agent (legacy Coder): it types into the pane itself.
 *   • an agent with neither: the strict version, unchanged.
 *
 * The last clause matters most. Retracting a TRUE report is a failure mode of its own, and the
 * cure is a way to look rather than an instruction to be careful — hence the pointer to
 * `check_work` (#256), which answers the challenge from the run record.
 */
export function executionAuthorityPrompt(model: SelfModel): string {
	// Composed, not a three-way switch. The legacy Coder has BOTH — an executor and the drive tools
	// — and an if/else chain silently told it about only whichever branch came first. Describing
	// half of an agent's real reach is the same class of error as describing none of it.
	if (!model.canStartWork && !model.canDrive && !model.canDelegate) {
		return (
			"\nWHAT YOU CAN ACTUALLY DO: you cannot run shell commands, drive the coding engine, or change code." +
			" From this chat you explain and summarize. Never claim you ran a command, made a commit, or fixed a" +
			" bug. If asked to do such work, say plainly that you cannot and name where it happens."
		);
	}
	const lines: string[] = ["\nWHAT YOU CAN ACTUALLY DO:"];
	if (model.canStartWork) {
		lines.push(
			"- You never type into the terminal yourself. You hand a GOAL to your own executor with `start_work`," +
				" and it really does drive the coding engine on the user's machine — running commands, editing files," +
				" making commits. That is real work, done by you, through it.",
			"- DO say plainly when you have started work, and report what the run reports back.",
		);
	}
	if (model.canDelegate) {
		lines.push(
			"- You do not run commands yourself. You hand a GOAL to an agent you supervise with `delegate_goal`," +
				" and it really does that work — on its machine, in its repository. A run you delegated is work" +
				" YOU started, and reporting it as something you did is accurate, not an over-claim.",
			// The direct cause of #318: the run lives on the SUBORDINATE, so "nothing on my own
			// instance" is the normal state for a supervisor and says nothing about what it did.
			//
			// The detail tools are NAMED only when granted. The first version listed
			// `subordinate_status` unconditionally and the Coder Lead does not declare it — so the
			// fix for #318 shipped with the over-reporting half of the same bug in it, which is
			// exactly how durable this class is without a check.
			"- Your runs are recorded on the agent that ran them, never on you. `check_work` reports both yours and" +
				` the ones you delegated${detailToolClause(model)}.` +
				" NEVER conclude from an empty record on your own instance that you delegated nothing.",
		);
	}
	if (model.canDrive) {
		lines.push(
			"- You can send input to the coding engine (`send_to_cli`) and read its terminal (`read_terminal`)." +
				" The engine runs the commands; you steer it. Report what the terminal actually shows, and never" +
				" describe an outcome you have not seen.",
		);
	}
	lines.push(
		"- Never say that YOU personally ran a command, made a commit, or fixed a bug.",
		// The clause that matters most for #254. Retracting a TRUE report is a failure mode of its
		// own, and the cure is a way to LOOK rather than an instruction to be careful.
		"- Never retract a report your own tool results support. If the user challenges whether something" +
			" happened, call `check_work` and answer from the run record — not from memory, and not from these" +
			" instructions. Denying real work is as wrong as inventing it.",
		"- Never tell the user to redo by hand something a run of yours already did.",
	);
	return lines.join("\n");
}

/**
 * "; `check_delegation` and `subordinate_status` report theirs in more detail" — but only for the
 * tools this agent actually has, and nothing at all when it has neither.
 */
function detailToolClause(model: SelfModel): string {
	const names = ["check_delegation", "subordinate_status"].filter((t) => model.tools.has(t)).map((t) => `\`${t}\``);
	if (!names.length) return "";
	const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
	return `; ${list} report${names.length > 1 ? "" : "s"} theirs in more detail`;
}

/** One attached repository, as much of it as the prompt needs. */
export interface AttachedRepo {
	name: string;
	githubRepo?: string | null;
	workdir?: string | null;
}

/**
 * "What you are" — ownership and surfaces, stated as fact (#255).
 *
 * Before this, a Repo Coder's only sense of owning a repository came from a seeded `goal` MEMORY
 * string ("Deliver the objectives you are given in your repository…"). Memory is narrative;
 * capabilities are fact; only the narrative reached the prompt. So the agent could describe itself
 * correctly one day and contradict its own configuration the next — and did, telling a user to
 * "attach a repository in the Repo tab" on an agent whose declared surfaces are `["coding"]` and
 * which therefore has no Repo tab at all.
 *
 * `repoSetting` is the typed `repo` setting the subscriber filled in; `attached` is what is really
 * in `coding_repos`. Both are stated because they can disagree, and an agent that can see the
 * disagreement can say so instead of guessing which is real.
 */
export function selfDescriptionPrompt(
	model: SelfModel,
	ctx: { repoSetting?: string | null; attached?: readonly AttachedRepo[] } = {},
): string {
	const lines: string[] = [];
	const attached = ctx.attached ?? [];
	const setting = (ctx.repoSetting ?? "").trim();

	if (model.singleRepo) {
		const repo = attached[0];
		const label = repo
			? `${repo.name}${repo.githubRepo ? ` (${repo.githubRepo})` : ""}${repo.workdir ? ` at ${repo.workdir}` : ""}`
			: setting || null;
		lines.push(
			label
				? `You are responsible for exactly ONE repository: ${label}. You do not manage any other repository and cannot add one.`
				: "You are responsible for exactly ONE repository, and it is not set yet. You cannot add one yourself — the subscriber sets it in the Settings tab, under Agent settings.",
		);
		// Only when there is something to disagree about. Saying "the setting and the attached repo
		// agree" on every turn is noise; saying nothing when they DON'T is how an agent ends up
		// working confidently on the wrong checkout.
		if (repo && setting && !repoMatchesSetting(repo, setting)) {
			lines.push(
				`NOTE: the \`repo\` setting says "${setting}" but the repository actually attached is ${repo.name}. Say so rather than assuming which one is meant.`,
			);
		}
		if (attached.length > 1) {
			lines.push(
				`NOTE: ${attached.length} repositories are attached even though you own one. Work on ${attached[0].name} and tell the subscriber about the others.`,
			);
		}
	}

	if (model.tabs.length) {
		lines.push(
			`Your console has exactly these tabs: ${model.tabs.join(", ")}. NEVER refer the user to any other tab —` +
				" if a tab is not in that list, it does not exist for you, and sending them there is a wrong answer.",
		);
	}

	return lines.length ? `\n\n## What you are\n${lines.map((l) => `- ${l}`).join("\n")}` : "";
}

/**
 * Does an attached repo plausibly correspond to the `repo` setting?
 *
 * Deliberately loose. The setting is free text a human typed — `~/dev/my-repo`, `owner/name`,
 * `my-repo` — and the attached row carries a name, a `owner/name` and a workdir. A strict compare
 * would fire the mismatch note constantly and train the agent to ignore it; the note only earns
 * its place if it is rare.
 */
export function repoMatchesSetting(repo: AttachedRepo, setting: string): boolean {
	const norm = (s: string) => s.trim().toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "");
	const tail = (s: string) => norm(s).split("/").pop() ?? "";
	const want = norm(setting);
	const wantTail = tail(setting);
	if (!want) return true;
	const candidates = [repo.name, repo.githubRepo ?? "", repo.workdir ?? ""].filter(Boolean).map(norm);
	return candidates.some((c) => c === want || c.endsWith(`/${want}`) || tail(c) === wantTail);
}
