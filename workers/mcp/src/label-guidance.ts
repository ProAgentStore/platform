/**
 * The label vocabulary, as `platform_guide` carries it (#1245).
 *
 * A COPY of `workers/api/src/lib/label-vocabulary.ts` — this worker cannot import the API worker. That
 * file is the source: it defines the lists the platform's code reads and renders the same text into
 * `github_create_issue`, `github_update_issue` and `github_list_issues`, which an agent reaches through
 * `call_instance_tool`. `label-guidance.test.ts` fails when the two disagree, so a change goes in the
 * API file first and is pasted here.
 *
 * It is its own module, like `instance-tool-guidance.ts`, so `platform-guide.ts` interpolates it: the
 * guide guard reads that file's source and would otherwise count the connector tool names in this text
 * as phantom MCP tools.
 */
export const LABEL_LIST_FORMAT =
	'A comma-separated STRING, e.g. "bug,P1: blocks external users" — not an array (an array is refused). Spaces and colons inside a name are fine; a name containing a comma cannot be given.';

export const LABEL_VOCABULARY =
	"Labels the platform acts on: `needs-human`, `human-only`, `blocked` and `blocked-…` (e.g. `blocked-on-serge`) mean a person has to act — the coder's product-owner triage and the fleet snapshot leave them to the owner. Auto-pickup never starts an issue labelled `needs-human`, `blocked-on-serge`, `blocked`, `question`, `wontfix`. Priority, highest first: `P0` (wrong today), `P1` (blocks external users), `P2` (correctness), `P3` (later) — auto-pickup starts the highest first, and the repo's labels read like `P1: blocks external users`. Kind: `bug` is started before an unlabelled issue, `enhancement` after. Area labels in ProAgentStore/platform (other repos have their own): `mcp` (the MCP server surface), `runner` (the browser-runner and CLI), `coder` (the coding agents), `connectors` (the connector and tool framework), `pipelines` (pipelines, triggers and the event pump), `board` (the board a subscriber reads), `voice` (voice, STT and TTS), `observability` (a displayed value the code cannot produce), `contracts` (a declaration nothing compares to its implementation), `testing` (guards, test doubles and coverage), `security` (hardening and audit findings), `frontend` (UI work), `backend` (Worker and API work). Use an existing label rather than a new spelling; github_read_issue shows what a similar issue carries.";

/** The `platform_guide` section: which tools set labels, the vocabulary, and the list format. */
export const LABEL_GUIDANCE = `What to put on an issue you file or triage with the GitHub tools (github_create_issue, github_update_issue, github_list_issues — reached with call_instance_tool). ${LABEL_VOCABULARY} List format for the labels and exclude_labels fields: ${LABEL_LIST_FORMAT}`;
