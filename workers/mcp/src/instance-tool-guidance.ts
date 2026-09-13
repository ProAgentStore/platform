/**
 * How to call a nested tool, and when a call beats a run (#774).
 *
 * Its own module because TWO channels carry these sentences — `SERVER_INSTRUCTIONS`, read at
 * `initialize`, and `PLATFORM_GUIDE`, which reaches a client whose `tools/list` is cached (#703) —
 * and a rule typed out twice is a rule that drifts. Not in `tool-metadata.ts`, because nothing but
 * the server wiring may import that module (`index.test.ts` fails the build otherwise).
 *
 * NESTED_TOOL_SEQUENCE. #743 named the pattern but not its sequence, and the sequence is where the
 * measured failure sat: an orchestrator guessed `issue_number` for a field the schema calls `number`,
 * and retried on memory before discovering it. `SERVER_INSTRUCTIONS`' "read its input schema from
 * tools/list" sentence covers only THIS surface's tools; a nested tool's schema is not in `tools/list` at all. And it is
 * not in `list_instance_tools` either unless asked for — `schemas` is off by default (#569/#578) —
 * so the sentence names the flag, not just the tool. `invocableBy` is named because a row reading
 * `allowed: true` can still be chat-only, and `call_instance_tool` refuses it.
 *
 * DIRECT_BEFORE_RUN. The other half of #774: an issue-driven workflow was read as "every action goes
 * through a coding run", so filing an issue cost an autonomous run. The #743 sentence contrasts the
 * direct path only with `coding_session_message`; `coding_loop_start` is the costlier thing to
 * reach for, and was reached for. The two examples are real tool names (`github_create_issue`,
 * `repo_read_file`), because a rule illustrated with an invented name teaches a guess.
 */
export const NESTED_TOOL_SEQUENCE =
	"To call one, first run list_instance_tools with schemas:true, then pass call_instance_tool the exact tool name and an input object whose field names are the ones that schema declares — never guessed from memory or from a similar tool — and only for a tool whose invocableBy lists call_instance_tool.";

export const DIRECT_BEFORE_RUN =
	"Something that needs no code change — reading, filing or commenting on a GitHub issue (github_create_issue), reading a file (repo_read_file) — is one such call, not a coding run: keep coding_loop_start for work that must change the repository.";

