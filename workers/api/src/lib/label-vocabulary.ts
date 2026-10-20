/**
 * The GitHub label vocabulary an agent files and triages with (#1245) — one source, rendered into every
 * tool that sets or filters labels.
 *
 * ── Why it exists
 *
 * An agent filing or triaging issues through `call_instance_tool` (`github_create_issue`,
 * `github_update_issue`, `github_list_issues`) had no in-band statement of which labels exist or what
 * they DO. They do a lot: `needs-human` keeps an issue out of every automatic pickup, and `P0`..`P3`
 * decide which issue the next run starts. A label an agent invents, or spells differently, silently
 * does neither.
 *
 * ── Static, not per repo (decided on #1245)
 *
 * A tool's description is published text: it is read at `tools/list`, cached by clients, and is part of
 * the surface a version locks. A per-repo list would be a GitHub labels request per listing, and still
 * could not say what a label MEANS — most of a repo's labels carry no description, including the two
 * that matter most. So this is the vocabulary the PLATFORM acts on (the lists below are the ones code
 * reads: the auto-pickup excludes and priorities, the triage's needs-human test) plus the area labels
 * ProAgentStore/platform itself uses, said to be that repo's own. A repo's real labels are still one
 * `github_read_issue` away.
 *
 * ── Kept equal to the code, not to a memory of it
 *
 * The two lists the platform reads are DEFINED here and imported by `auto-pickup.ts`, so they cannot
 * drift from the sentence that describes them. `label-vocabulary.test.ts` holds the rest to the code:
 * `fleet-snapshot.ts`'s `isNeedsHumanLabel`, the auto-pickup ordering, and the MCP worker's copy of the
 * text (`workers/mcp/src/label-guidance.ts` — that worker cannot import this one).
 */

/** Labels that keep an issue out of auto-pickup, whatever the owner adds (#1233). Compared case-insensitively, exactly. */
export const BUILTIN_EXCLUDE_LABELS = ["needs-human", "blocked-on-serge", "blocked", "question", "wontfix"] as const;

/** Priority labels, highest first. A label matches one exactly, or as a prefix followed by `:`, ` ` or `-` (`P1: blocks external users`). */
export const DEFAULT_PRIORITY_LABELS = ["P0", "P1", "P2", "P3"] as const;

/** The area labels ProAgentStore/platform uses, with the one-line meaning its own label list gives them. */
export const AREA_LABELS: ReadonlyArray<readonly [name: string, meaning: string]> = [
	["mcp", "the MCP server surface"],
	["runner", "the browser-runner and CLI"],
	["coder", "the coding agents"],
	["connectors", "the connector and tool framework"],
	["pipelines", "pipelines, triggers and the event pump"],
	["board", "the board a subscriber reads"],
	["voice", "voice, STT and TTS"],
	["observability", "a displayed value the code cannot produce"],
	["contracts", "a declaration nothing compares to its implementation"],
	["testing", "guards, test doubles and coverage"],
	["security", "hardening and audit findings"],
	["frontend", "UI work"],
	["backend", "Worker and API work"],
];

/**
 * How to write a label list at the point of use. The registry validates input against the declared
 * schema, and these fields are declared `string`, so an ARRAY is refused (`Field "labels" must be a
 * string`) — the #1241 seam's array/string conversion covers a tool's own arguments, not the nested
 * input of `call_instance_tool`. Checked in `label-vocabulary.test.ts` against the real validator.
 */
export const LABEL_LIST_FORMAT =
	'A comma-separated STRING, e.g. "bug,P1: blocks external users" — not an array (an array is refused). Spaces and colons inside a name are fine; a name containing a comma cannot be given.';

/** What the platform does with each group of label, in the words an agent needs to choose one. */
export const LABEL_VOCABULARY = [
	"Labels the platform acts on:",
	"`needs-human`, `human-only`, `blocked` and `blocked-…` (e.g. `blocked-on-serge`) mean a person has to act — the coder's product-owner triage and the fleet snapshot leave them to the owner.",
	`Auto-pickup never starts an issue labelled ${BUILTIN_EXCLUDE_LABELS.map((l) => `\`${l}\``).join(", ")}.`,
	"Priority, highest first: `P0` (wrong today), `P1` (blocks external users), `P2` (correctness), `P3` (later) — auto-pickup starts the highest first, and the repo's labels read like `P1: blocks external users`.",
	"Kind: `bug` is started before an unlabelled issue, `enhancement` after.",
	`Area labels in ProAgentStore/platform (other repos have their own): ${AREA_LABELS.map(([n, m]) => `\`${n}\` (${m})`).join(", ")}.`,
	"Use an existing label rather than a new spelling; github_read_issue shows what a similar issue carries.",
].join(" ");

/** The short form for a tool that FILTERS by label: which labels mean what, and the format. */
export const LABEL_FILTER_HINT =
	"Labels with meaning: `needs-human`, `human-only`, `blocked`, `blocked-…` = waiting on a person; `P0`..`P3` = priority, highest first; `bug` / `enhancement` = kind; `question`, `wontfix` = never auto-picked.";
