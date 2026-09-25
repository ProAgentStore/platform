# Codex `exec resume <id>` spike, 2026-09-25

Issue: #730. Follow-up build slice: #848. This is evidence only; it does not add runner-side
resume support.

## Result

**Pass** on `codex-cli 0.151.0`. An explicit ID captured from a JSON `thread.started` event
carried semantic context across a second turn and was not hijacked after an unrelated `codex exec`
ran in the same working directory. The supported write-enabled JSON argv is:

```text
codex exec resume <captured-thread-id> --json --dangerously-bypass-approvals-and-sandbox <turn-text>
```

`codex exec resume --help` advertises `--json` and
`--dangerously-bypass-approvals-and-sandbox`; it does not advertise `--sandbox <mode>`. All four
commands exited zero.

## Method

The probe used a new temporary git repository and synthetic, public fixture markers only. No source
content, user prompts, or credentials were used. Stdout was captured as raw JSONL; stderr was
intentionally not retained because local CLI diagnostics can contain connector/account details.

1. Ran `codex exec --json --sandbox danger-full-access <first synthetic prompt>` and captured
   `thread.started.thread_id` as `01a0d811-35aa-7fc1-bd23-f39d943db79a`.
2. Ran `codex exec resume <captured-id> --json --dangerously-bypass-approvals-and-sandbox <second
   synthetic prompt>`. Its `thread.started.thread_id` equals the captured ID and its agent message
   exactly recalls `C730-ORCHID-MAPLE-482917`; a clean session could not derive that marker from the
   second prompt.
3. Ran a separate `codex exec --json --sandbox danger-full-access <unrelated synthetic prompt>` in
   the same CWD. It started `01a0d812-0531-7c02-b742-7ce3e5b9aaea`, a distinct thread ID.
4. Ran the same explicit-ID resume as step 2. It again reported the original captured ID and
   answered `ORIGINAL CONTEXT RECALLED C730-ORCHID-MAPLE-482917`, not the unrelated marker.

This proves the required semantic carry and rules out the known `--last`-class same-CWD hijack for
the observed explicit-ID form. It does not make engine-owned history authoritative: #848 must retain
the #693 platform-timeline continuity direction as the eventual replacement.

## Privacy-safe raw fixtures and deterministic checks

These files are raw stdout JSONL, with no redaction or transformed event fields:

| Step | Fixture | SHA-256 |
|---|---|---|
| Initial turn | `packages/browser-runner/src/coding/fixtures/codex-json-0.151.0/resume-by-id-first.jsonl` | `5e6b31bf6a2f419bea946efd656f644f9aad696105c5cce575941954ac8c13c7` |
| Explicit-ID turn | `packages/browser-runner/src/coding/fixtures/codex-json-0.151.0/resume-by-id-second.jsonl` | `b8d043a660295c3df2e31aee6e4708215c7bb8f0d213e844566f3f837575fdbb` |
| Unrelated turn | `packages/browser-runner/src/coding/fixtures/codex-json-0.151.0/resume-by-id-unrelated.jsonl` | `50495f38f90cfa880279cb0000f584f69d765c477501971ace57ba717e43a644` |
| Original ID after unrelated turn | `packages/browser-runner/src/coding/fixtures/codex-json-0.151.0/resume-by-id-after-unrelated.jsonl` | `96e23e9b73f4021372e9e6eafc1cde62813f21f7289b0bfe6741e0040a155c9a` |

To reproduce the deterministic fixture checks without executing a live model turn:

```sh
shasum -a 256 packages/browser-runner/src/coding/fixtures/codex-json-0.151.0/resume-by-id-*.jsonl
node -e '
const fs=require("node:fs"); const d="packages/browser-runner/src/coding/fixtures/codex-json-0.151.0";
const f=["resume-by-id-first.jsonl","resume-by-id-second.jsonl","resume-by-id-unrelated.jsonl","resume-by-id-after-unrelated.jsonl"];
const p=Object.fromEntries(f.map(n=>[n,fs.readFileSync(`${d}/${n}`,"utf8").trim().split("\\n").map(JSON.parse)]));
const id=n=>p[n].find(e=>e.type==="thread.started").thread_id;
const msg=n=>p[n].find(e=>e.item?.type==="agent_message").item.text;
const original=id(f[0]);
if (!f.every(n=>p[n].some(e=>e.type==="turn.completed")) || id(f[1])!==original || id(f[2])===original || id(f[3])!==original || msg(f[1])!=="CONTEXT RECALLED C730-ORCHID-MAPLE-482917" || msg(f[3])!=="ORIGINAL CONTEXT RECALLED C730-ORCHID-MAPLE-482917" || msg(f[3]).includes("C730-UNRELATED-CEDAR-771204")) process.exit(1);
'
```

The check succeeds only if every fixture is JSONL-complete, both explicit resumes use the original
ID, the unrelated turn has a distinct ID, and the exact semantic assertions remain true.

## Build boundary

The passing result authorizes the narrow runner implementation in #848 only: persist the captured
ID, construct a dedicated explicit-ID argv path in `runOneShot`, and fall back to a fresh one-shot
turn when state is absent or invalid. It must never invoke `--last`. This spike intentionally does
not implement any of that behavior.
