---
description: "Understand AI provider and coding-engine errors, retry behavior, recorded diagnostics, and failures that require your action."
---

# Provider Errors

An agent run talks to AI providers in two places, and a provider refusal can reach it from either one:

| Where | Who calls the provider | Whose credential | Providers |
| --- | --- | --- | --- |
| **The brain** (the Pilot that drives a coding run, an agent's chat and orchestration) | the platform's API worker | your key in **Profile → API Keys** (BYOK) | Anthropic, Cloudflare Workers AI |
| **The coding engine** (the CLI on your machine) | the CLI itself | the subscription the CLI is signed in with on that machine | Claude Code (Anthropic), Codex (OpenAI), Gemini CLI (Google), Grok (xAI), Ollama (local) |

This page says, for every kind of provider error the platform recognises, what it means, what the platform does about it, and what (if anything) you have to do. The rule throughout is: **a failure that fixes itself is waited out or retried, and only a failure that needs you stops and says so, with the provider's own words.**

## What Is Recorded

Every provider error the brain receives keeps the provider's own facts in the message, so they survive into the run's detail, `agent_trace` and `list_errors`:

```
Anthropic (403): Request not allowed [permission_error; request-id req_011CVx…] — Anthropic API key ending in 8QAA was refused. …
Cloudflare Workers AI request failed with HTTP 403: Authentication error [code 10000; request-id 8d1f2a…]
```

- the HTTP status, in parentheses;
- the provider's own message, verbatim;
- in brackets, the provider's **error type** (or code) and its **request id** (Anthropic's `request-id` header, Cloudflare's `cf-ray`). Quote the request id to the provider's support to have them look the request up;
- for a refused or empty Anthropic key, the key's last four characters, never more.

## Brain Errors (Your API Key)

| Provider says | Class | What the platform does | What you do |
| --- | --- | --- | --- |
| Anthropic `400 invalid_request_error` "credit balance is too low" | `provider_credit` | Stops the run (`stopReason: provider_credit`) and pauses automatic starts on that key. Re-checks the key on a backoff while stopped runs wait; continues them once it works. | Top up at console.anthropic.com/settings/billing. Nothing else. |
| Anthropic `401 authentication_error`, `403 permission_error` ("Request not allowed"); Cloudflare 401/403 | `provider_credentials` | Stops the run (`stopReason: provider_credentials`) and pauses automatic starts on that key. **Re-checks the key by itself** (5 min, 15 min, 1 h, then every 6 h, for up to 7 days from the first refusal; each re-check is recorded in the activity log) and, the moment a check passes, lifts the pause and continues the stopped runs. | Usually nothing: a 403 "Request not allowed" has been measured clearing by itself within minutes on a key that works. If it does not clear, check the key and organization at the provider, or replace the key, then press **Verify**. |
| Anthropic `429 rate_limit_error` | `provider_rate_limit` | Not replayed at once (the provider wants a backoff). | Nothing, unless it persists — then raise the key's rate limit at the provider. |
| Anthropic `529 overloaded_error`, any `5xx` | `provider_stall` | Retried at once (one immediate retry), and a run cut off mid-reply is resumed from its journal: only the dropped call is paid for again. | Nothing. |
| A reply that stops arriving, arrives empty, or ends mid tool call | `provider_stall` | Resumed from the journal, bounded. | Nothing. |
| A reply too long to finish | `provider_overrun` | Not retried: an identical attempt ends identically. | Shorten the objective or split the work. |
| Anthropic `404` (model) | `provider_error` | Stops with the hint that the key cannot reach the model. | Use a key with access to the model, or pick another model. |

**The pause on a key.** A credential or credit failure places a hold on *that exact key* (by a one-way fingerprint, never the key itself): automatic starts — auto-pickup, queued objectives, scheduled triage — wait instead of failing one after another. The hold lifts when **any** call with that key succeeds, when you **Verify** it, when you **replace** it, or when the platform's own re-check passes. A replaced key is never held for the old one's failure.

**Verify** — Profile → API Keys → **Verify** (Anthropic and Cloudflare) spends one four-token request against the stored key and shows the result: "Works", or the provider's error with the remedy. A pass lifts the hold. Over MCP, `coding_diagnostics` reports the recorded state (`providerAccount`); a live verify tool is tracked as a known gap.

**Automatic continuing** is on by default and can be turned off per instance or for the whole account (`coding.autoResumeOnCredit` in account preferences — the switch covers both credit and credential stops). It is paced (3 runs per owner per minute), happens once per stopped run, covers runs stopped within 7 days, skips paused instances and runs you have since superseded, and respects the one-run-per-repo lock (a busy repo defers it, never drops it). `coding_loop_status` shows each stopped run's `autoResume` state: `resumed` (with the successor's id), `deferred`, or `gave_up` with the reason.

## Coding Engine Errors (The CLI On Your Machine)

When an engine's turn fails, its own output is read before the failure is counted. Sign-in failures are recognised first (see *Before A Coding Run Starts: The Engine Must Be Signed In* in [Run Lifecycle](/docs/run-lifecycle/)); then provider failures, in this order:

| Kind | What it means | Examples the platform recognises | What the platform does |
| --- | --- | --- | --- |
| **billing** | The account the CLI is signed in with has no credit or quota left. | Claude Code "You're out of usage credits", "Your org is out of usage · add funds to continue", "You've hit your monthly spend limit", "Credit balance is too low"; Codex `insufficient_quota`, "You exceeded your current quota", "Your workspace is out of credits", "You hit your spend cap"; Grok "You've hit the credit limit for your plan", "out of credits or over your spending limit" | Ends the run at once (`engine_error`) with the provider's words and where to fix it — not after three strikes. |
| **limit** | A usage or rate window that reopens by itself. | Claude Code "You've hit your session limit · resets 3am" (and weekly/Opus/Sonnet limits), `rate_limit_error`; Codex "You've hit your usage limit", `rate_limit_exceeded`, `usage_limit_reached`; Gemini `RESOURCE_EXHAUSTED`, "You have exhausted your capacity on this model", "Usage limit reached for all Pro models"; Grok "You've hit your team's API rate limit", "You hit your weekly limit"; any CLI's "API Error: 429" | Parks the run (`waitingReason: engine_limit`) and continues by itself when the window reopens — 15 min, 30 min, then 1 h when no reset time is known; at most 3 parks and 6 h per run. The first turn after the park is a real retry. |
| **transient** | The provider is overloaded, erroring or unreachable. | Claude Code `overloaded_error` (529), `api_error` (500), "Server is temporarily limiting requests", "API Error: Connection error." / "Request timed out."; Codex "Selected model is at capacity", "experiencing high demand", "last status: 500", "stream disconnected before completion"; Gemini "(Status: INTERNAL)", "(Status: UNAVAILABLE)"; Grok "Model is temporarily overloaded", "The service is busy"; any CLI's "API Error: 5xx" | The first one is **not** counted against the engine: the Pilot is told to resend the same instruction. A second in a row parks like a limit, then retries. |

The examples are the CLIs' own wording, read out of Claude Code 2.1.310, Codex 0.164.0, Gemini CLI 0.57.0 and Grok 1.0.62. Gemini's free-tier 429 reuses OpenAI's "You exceeded your current quota … billing" sentence but carries `RESOURCE_EXHAUSTED`; it is read as the rate window it is, not as billing.

Anything else — an engine that refuses to run for its own reasons (a bad flag, an untrusted directory, an invalid model) — is an ordinary failed turn: reported to the Pilot, and three in a row end the run as `engine_error` with the engine's own last output.

Only phrases the CLIs frame as their own errors are matched ("API Error: 503"), never a bare status code, so a project's own failing test that prints "expected status 200, got status 500" is not mistaken for a provider outage. The table lives in `workers/api/src/lib/engine-provider-error.ts`, one row per provider; a reworded CLI message is a one-line change there plus a test case.

## The Machine Between Them

A coding run also depends on the runner on your machine answering. When a read (a terminal capture) times out at the relay because the runner is connected but not answering — a machine under load, a wedged runtime — the run **waits for the runner to answer its health check** rather than ending. If the runner stays silent past the poll, the run **parks** (`waitingReason: runner_away`) with its work intact and continues when the runner answers again, typically after its supervisor restarts it. A capture changes nothing in the checkout or the engine, so re-sending it is safe; the one cost is that if the timed-out capture did reach the runner, the usage and activity records it collected are not recorded. A command that may have changed something is never re-sent on a guess.

## When A Change Ships

Push to `main` deploys the API worker (tests and migrations first). Nothing above needs a migration, and nothing needs to be re-entered:

- Holds already in place when the change ships are re-checked on the next cron tick (every minute), so a key paused by a refusal before the deploy is probed and lifted by itself if it works.
- Runs that stopped on a refused key before the deploy carry `stopReason: failed`, not `provider_credentials`, so they are not continued automatically; press **Continue** on them (or `continue_instance_run`).
- Runs in flight keep going: their journalled steps replay unchanged.
