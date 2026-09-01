# Codex exec --json spike, 2026-09-01

Issue: #729.

## Environment

- Platform: `Darwin Sergeys-Mac-mini.local 24.6.0 Darwin Kernel Version 24.6.0: Tue Apr 21 20:17:54 PDT 2026; root:xnu-11417.140.69.710.16~1/RELEASE_X86_64 x86_64`
- Codex CLI: `codex-cli 0.151.0`
- Test directory: temp git repo with one committed file, `note.txt`, containing `alpha-spike`.
- Auth mode: machine Codex sign-in from the local environment; no API key was added for the spike.
- Prompts used `--model gpt-5.6-luna` to keep the probe bounded.

## Help evidence

`codex exec --help` advertises:

```text
Usage: codex exec [OPTIONS] [PROMPT]
       codex exec [OPTIONS] <COMMAND> [ARGS]
...
  -s, --sandbox <SANDBOX_MODE>
          [possible values: read-only, workspace-write, danger-full-access]
...
      --json
          Print events to stdout as JSONL
```

`codex exec resume --help` advertises:

```text
Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]
...
      --last
          Resume the most recent recorded session (newest) without specifying an id
...
      --dangerously-bypass-approvals-and-sandbox
          Skip all confirmation prompts and execute commands without sandboxing.
...
      --json
          Print events to stdout as JSONL
```

Notably, `exec resume` does not list `--sandbox <mode>`, matching the warning in #730.

## Captured fixtures

Combined process-output captures are stored in:

- `packages/browser-runner/src/coding/fixtures/codex-json-0.151.0/basic-success.combined-output.txt`
- `packages/browser-runner/src/coding/fixtures/codex-json-0.151.0/command-success.combined-output.txt`
- `packages/browser-runner/src/coding/fixtures/codex-json-0.151.0/command-failure.combined-output.txt`

The connector name in OAuth refresh errors is redacted. The plaintext lines are intentionally kept:
they prove that normal one-shot process output from this configured Codex environment is not pure
JSONL once stderr is merged into the same runner path.

## Schema map

Observed event paths:

| Meaning | Observed path |
|---|---|
| Session/thread id | `type == "thread.started"`, `thread_id` |
| Turn start | `type == "turn.started"` |
| Assistant text | `type == "item.completed"`, `item.type == "agent_message"`, `item.text` |
| Command/tool start | `type == "item.started"`, `item.type == "command_execution"`, `item.id`, `item.command`, `item.status == "in_progress"` |
| Command/tool result | `type == "item.completed"`, `item.type == "command_execution"`, `item.id`, `item.command`, `item.aggregated_output`, `item.exit_code`, `item.status` |
| Successful command | `item.status == "completed"` and `item.exit_code == 0` |
| Failed command | `item.status == "failed"` or non-zero `item.exit_code` |
| Turn completion | `type == "turn.completed"` |
| Usage | `turn.completed.usage.input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens` |

No model id or dollar cost field was observed on `turn.completed.usage`.

## Parser requirements before implementation

- Skip or surface plaintext/non-JSON lines without wedging the turn, especially if the runner keeps
  merging stderr into the same parser path.
- Drop empty `agent_message` text; it appears before command execution in the command fixture.
- Map `command_execution` start/result by stable `item.id`; do not correlate by order alone.
- Treat non-zero `exit_code` or `status == "failed"` as a failed tool result.
- Treat `turn.completed` as the turn boundary.
- Do not write a dollar-cost usage row for Codex from this fixture alone; the CLI did not report cost.

## Decision

The #729 premise passes enough to proceed to a fixture-driven Codex adapter. A parallel dev-agent
probe using `--ignore-rules -C <TEMP_REPO>` also captured parseable JSONL-only stdout with the same
event paths. The next implementation slice should parse these exact fields and keep the generic raw
adapter as the fallback for older or incompatible Codex CLI output.

#730 remains a separate spike. This run proved a `thread_id` exists, not that
`codex exec resume <thread_id> --json <prompt>` carries context or avoids wrong-session resume.
