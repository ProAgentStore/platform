# ProAgentStore/platform — agent notes

Operational guidance for coding agents lives in `AGENTS.md`. This file records only the
decisions an agent must know before its first commit.

## Delivery mode

**Straight to `main`.** Commit on `main` and push; do not open a branch or a pull request
unless an issue explicitly asks for one. `main` carries no branch protection or ruleset, and
the `pags-dev` agent definition records the same decision. Fetch first and fast-forward if
`origin/main` has moved.

Note for runs inside the browser-runner checkout: the runner's remote carries a GitHub App
installation token for `proagentstore[bot]`, which can fetch but has **no push permission**.
Push with your own credential instead (the `gh` CLI's token works).
