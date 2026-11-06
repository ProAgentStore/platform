# Native browser baseline recording

This recorder sits between a stdio MCP client (including the Claude CLI) and the installed native Playwright MCP server. It forwards the original bytes in both directions and native stderr, without tool filtering, answer interpretation, added deadlines or PAGS account calls. Recording adds local disk I/O latency.

Use a **new log directory for each run**. Existing recording files are never overwritten. The recorder inherits the caller's environment for the child but does not log environment variables or command arguments. The directory is mode `0700`; recording files are `0600`.

```sh
node scripts/browser-baseline/mcp-recording-proxy.mjs /tmp/browser-run-unique -- \
  node packages/browser-runner/node_modules/@playwright/mcp/cli.js \
  --browser chrome --isolated --caps vision,pdf,devtools --image-responses allow \
  --timeout-action 600000 --timeout-navigation 600000
```

For Claude, put the same command in a private MCP configuration file, using absolute paths:

```json
{
  "mcpServers": {
    "native_browser": {
      "command": "node",
      "args": [
        "/ABS/REPO/scripts/browser-baseline/mcp-recording-proxy.mjs",
        "/ABS/PRIVATE/NEW-LOG-DIRECTORY",
        "--",
        "node",
        "/ABS/REPO/packages/browser-runner/node_modules/@playwright/mcp/cli.js",
        "--browser", "chrome", "--isolated",
        "--caps", "vision,pdf,devtools", "--image-responses", "allow",
        "--timeout-action", "600000", "--timeout-navigation", "600000"
      ]
    }
  }
}
```

Point the CLI at that file with `--strict-mcp-config --mcp-config /ABS/PRIVATE/mcp.json`; set `MCP_TOOL_TIMEOUT=600000` in its environment for the 600-second client budget. The native action/navigation budgets above are independently configurable; the recorder adds no timeout. Select the model and permissions explicitly in the client; the recorder neither selects them nor grants permission. Run only the user's authorized browser task. Native arbitrary code is not a sandbox, and tool visibility does not enforce fill-only behavior or prove that no submission occurred.

Files:

- `client-to-server.raw`: exact request bytes, including notifications and non-JSON bytes.
- `server-to-client.raw`: exact response bytes, including image payloads and JSON-RPC errors.
- `native-stderr.raw`: exact stderr bytes, including invalid UTF-8.
- `events.jsonl`: timestamped parsed records, typed request/response correlation, tool names/arguments, result text, error flags and decoded image byte counts/SHA-256 hashes. UTF-8 decoding spans chunk boundaries; final lines without a newline are inspected when the child closes.

**These recordings are private and may contain personal data, credentials, page contents or arbitrary tool arguments.** Do not commit or publish them. The absence of environment/argument metadata does not redact secrets present in MCP traffic or native stderr. Transport timestamps describe observation by the proxy. Image hashes prove received payload identity, not that the acting model understood an image. The parsed sidecar is for newline-delimited JSON MCP; raw forwarding and logs do not depend on successful parsing.

For a local read-only timeline:

```sh
node scripts/browser-baseline/trace-viewer.mjs /ABS/PRIVATE/LOG-DIRECTORY
```

Open the printed loopback URL. Its random URL capability is required; keep it private and stop the viewer when done. It serves only the fixed directory's parsed events, showing the newest 200 complete records and their total count, with no raw-file downloads or arbitrary path endpoint. It polls once per second. This is a tool-call trace: operations inside `browser_run_code`, evaluation or another arbitrary-code tool remain inside that tool, rather than becoming individual recorded browser actions.

Behavioral tests:

```sh
pnpm exec vitest run --project unit scripts/browser-baseline/mcp-recording-proxy.test.mjs scripts/browser-baseline/trace-viewer.test.mjs --maxWorkers 1
```

For the opt-in live review-approval test, build the runner, then run:

```sh
pnpm --filter @proagentstore/browser-runner build
PAGS_ENGINE_SMOKE=1 node scripts/browser-baseline/review-approval-smoke.mjs
```

It uses machine-authenticated Codex, the production local runtime and two isolated local forms with
fake applicant data. It checks missing-answer continuation, retained review, scoped approval, one
engine/page/browser and exactly one fixture submission after approval. Reports are written into a
fresh private temporary directory. The supervisor is synthetic: this is not a deployed MCP test or
an employer submission. It does not change the owner's application pipeline or browser profile.
