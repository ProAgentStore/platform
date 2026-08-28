# ADR 0006 — Text the platform did not author is fenced before a model reads it

**Status:** Accepted (2026-08-23) · **Owner decision** · Supersedes nothing.

## Context

`lib/untrusted-fence.ts` exists because a model cannot tell our words from a stranger's. It wraps
text in a marked block, tells the model the block is DATA, and neutralizes any fence marker inside
the body so the text cannot close its own block early. `agent-think.ts` states what it is for:

> Retrieved RAG content is UNTRUSTED — documents, ingested URLs, repo files and public webhook
> payloads, any of which an attacker can author. Fence it so the model treats it as data, not
> instructions: the front line against prompt-injection that would otherwise chain read-tools +
> fetch_url into an exfiltration of the owner's private data.

The mechanism has never been in doubt. What has repeatedly failed is knowing *where it applies*.

#263 fenced MCP `resources/read` and `prompts/get`. #308 fenced `fetch_url`, `http_request` and
`web_search`, and recorded in its own body that the fence "is applied in exactly two places today"
— an observation, not a list. #725 found Gmail message bodies afterwards, by accident. A sweep on
2026-08-23 that enumerated ingresses deliberately found six more: GitHub issue and PR bodies
(#746), `search_knowledge`/`read_knowledge`/`read_file` (#747), `mcp_call_tool` and
`mcp_get_prompt`'s head (#748), the apply and browse page snapshots (#749), every `ai_generate`
interpolation (#750), and the repo-local and terminal readers (#751).

Two of those sit in the same file as a correctly-fenced sibling. `mcp.ts` fenced
`mcp_read_resource` thirty lines below where `mcp_call_tool` did not; `retrieval.ts` fences the
automatic RAG block over the same corpus the knowledge tools returned bare. Nobody was careless.
Each author reasoned carefully about what their file was for — write privilege, access control,
result size, `$ref` binding — and the fence was simply not one of the questions the file posed.

Three further facts shaped this decision:

- **The guard did not catch any of it.** `lib/security-invariants.test.ts` pinned four module names
  and asserted each still called `fenceUntrusted` *at least once*. A module not in the map was
  invisible; a module in the map passed on one call site while another in the same file returned
  remote text bare. It was green throughout, and by the day it was deleted it named four of the
  eight modules that fenced — a fraction getting smaller, not larger.
- **A second wording appeared.** `lib/coding-copilot.ts` fenced repo content with its own sentence,
  carrying no marker-neutralisation. The sibling guard — "the fence tag appears only in
  `lib/untrusted-fence.ts`" — cannot see a wording that avoids the tag.
- **The fence must be applied at the SOURCE, not at the chat surface.** One handler answers chat, a
  pipeline step, `POST /v1/instances/:id/tools/:name` and MCP. `lib/untrusted-fence.ts` records
  this; fencing in `agent-think.ts` alone would cover one of four.

## Decision

**Text the platform did not author is wrapped by `fenceUntrusted` before any model reads it, at the
point it enters the platform — and every surface that can produce such text states, in code, either
its origin or that it produces none.**

**F1 — What counts as text we did not author.** Anything whose bytes were chosen by someone other
than this codebase: a remote HTTP or MCP response, a search result, a GitHub issue or PR body, an
email, a knowledge document or vector chunk (their sources are ingested URLs, repos, uploads and
the unauthenticated webhook route), a repository file or git output, a terminal pane, a rendered web
page, a payload arriving on a trigger or connection. The owner's own typed message is NOT in this
set. Neither is our own framing: a status line, a refusal, a truncation note, a "showing 50 of 812".

**F2 — Our framing stays outside the block.** A platform sentence placed inside a fence teaches the
model that a fence marks nothing in particular, which costs more than the sentence was worth.
Equally, remote prose placed just outside one — as `mcp_get_prompt`'s head did with 1000 characters
of a server's `description` — defeats the block it precedes. Both directions are violations, and
both were live. A refusal is the sharpest case: a fence tells the model not to obey what is inside
it, so a refusal placed inside one is an instruction we have asked the model to disregard.

**F3 — Every registry tool declares its answer, and the compiler asks.**
`ToolDef.untrustedOutput` is a required `boolean`. A new connector tool cannot ship undeclared. The
wrap is applied once, in `runRegistryTool`, so the declaration covers all four surfaces at once —
and handlers therefore must NOT fence themselves, because a second wrap nests and
`unfenceUntrusted` strips exactly one layer, which would leave the pipeline binder's `$ref` bound to
a fenced fragment that parses as neither JSON nor prose.

The question the field asks is **"does a result from this tool INTRODUCE such text"**, not "could
such text ever pass through it". A transform step (`map`, `filter`, `slice`) re-emits data an
ingress tool already produced and adds nothing of its own, and the binder deliberately UNWRAPS a
fence so `$ref` can bind JSON — so the re-fence for those belongs where the value meets a model
(F6), not on the step. Answering "introduces" keeps the field meaning one thing; answering "touches"
would make it true of nearly everything and therefore say nothing.

Three fields on `RegistryToolResult` carry what a per-tool boolean cannot:

- **`head` / `tail`** — the platform's own sentences, rendered outside the block. They are a PAIR
  because several notes are positioned deliberately and moving them would undo a decision: #534 puts
  the "which lines you got, and the literal call for the next window" disclosure ABOVE the body so a
  second cut cannot remove it, and #508 puts "this machine's runner ignored the `path` filter" AFTER
  the output it qualifies.
- **`origin`** — the specific provenance ("the API at `<url>`", "an email from `<sender>`", "the
  tmux session `<name>` on your machine"). Only the handler knows it; when absent the dispatcher
  derives one from the tool and its connector, which is always true and merely less specific.

Two per-RESULT facts narrow the per-TOOL declaration, and neither is an opt-out flag — a flag is a
thing an author has to remember, which is the failure mode this whole mechanism removes:

1. **An empty body has nothing to wrap.** A tool whose particular answer is entirely ours —
   `gmail_search` finding nothing, `repo_tree` on an empty folder — returns that sentence as `head`
   and leaves `content` empty. #725's test that "No messages matched" is NOT fenced still passes.
2. **A failure is the platform's own report unless the handler names an origin.** Nearly every
   `success: false` in a handler is a refusal or a diagnosis we wrote. The exceptions announce
   themselves: `http_request` returns the remote `{status,data}` envelope on a 4xx and
   `mcp_call_tool` returns the server's payload on `isError`, and both set `origin`.

**F4 — A non-registry ingress fences at its own seam, and says so where it is.**
`lib/knowledge-result.ts` (#747), `lib/prompt-interpolation.ts` for `ai_generate` (#750), the
apply/browse decide-loops (#749), `lib/confirmation-link-result.ts`, `read_terminal` in
`lib/storage-tools.ts` (#751) and `lib/terminal-label.ts` (#751) do not pass through
`runRegistryTool`. Each fences locally and carries a comment naming this ADR, so the next reader of
that file finds the question already posed. Three of those are not tool results at all — one is a
loop's own per-turn observation, one is a value the binder deliberately unfenced, and one is the
SYSTEM PROMPT itself — which is exactly why the registry declaration is one enforcement point for
the property and not the whole of it.

`lib/terminal-label.ts` is the sharpest of them and the reason this clause is not a footnote.
`agent-think.ts` appends up to 1200 characters of terminal pane to the system prompt on **every**
turn of a coding-capable instance, with no tool call involved, and the next sentence of that prompt
tells the model to trust each terminal line's label literally. So a pane line wearing the label's
own vocabulary was interpolated *into* the label — text we did not author, arriving in the
platform's own voice, which is a strictly worse position than a tool result that at least announces
itself as one. It is the same defect #749 found on the browser loops' `CURRENT PAGE` line. The
labels stay outside the block for F2's reason, and here that reason is load-bearing rather than
tidy: those labels exist to stop stale scrollback being read as live.

**F5 — There is ONE fence, and it is `fenceUntrusted`.** No hand-written wrapper, no second wording,
no "REFERENCE (untrusted …):" prefix. A copy will not carry `neutralizeFenceMarkers`, which is the
half that does the work, and two wordings only have to disagree once.

**F6 — Unwrapping is for non-model readers only.** `unfenceUntrusted` exists so the pipeline binder
can `JSON.parse` a fenced result for `$ref`. A value that has been unwrapped and is then rendered
into a prompt is back in F1's scope and is fenced again there. Unwrapping is not a decision that the
text became trustworthy.

**F7 — "The model probably discounts tool output anyway" is not an argument.** #308 recorded and
rejected it: "that is a property of the model, not of our prompt, and it is the same argument that
was true of RAG before the fence was added there."

## Consequences

- **~40 tokens of preamble per fenced result.** Real on high-frequency tools; accepted. Where it is
  not — a tight per-record loop such as `ai_generate` over 200 leads — the fix is to fence the
  substitutions rather than the whole message, not to skip it.
- **A new connector tool costs one more decision.** That is the point: the decision is cheap when
  the tool is written and expensive to discover later.
- **A per-tool boolean is coarser than the per-result judgement some handlers used to make.** The
  two narrowings above are what buys that back, and they are exercised: `gmail_search` had a test
  asserting its "no matches" sentence stays unfenced, and it was the test that found the gap.
- **`head`/`tail` split a result into three parts, and the split is load-bearing in both
  directions.** A result carrying a head is NOT unwrappable — `unfenceUntrusted`'s regex is anchored
  at both ends — so `http_request`, `web_search` and `mcp_call_tool` deliberately carry no head and
  ride their status fields inside the block. Adding a status line to one of those would silently
  break every downstream `$ref`; a test asserts it.
- **Some results become harder to read in a transcript.** The console shows a marker block around a
  tool result. Preferable to the alternative, and the origin string makes provenance visible where
  it previously was not.
- **This ADR does not claim the fence stops prompt injection.** It claims the platform knows where
  it is applied. A fence is a mitigation whose strength is a model's; an enumeration is ours.

## Enforcement

- **The compiler, first.** `untrustedOutput` is required and not optional, so a new `ToolDef`
  literal that omits it does not typecheck. This is the enforcement; everything below covers what a
  compiler cannot see.
- **`lib/security-invariants.test.ts` — no `lib/connectors/*` module calls `fenceUntrusted`.**
  Exhaustive over the DIRECTORY rather than over a list, so a connector added tomorrow is covered
  because of where it lives. This is what replaced the four-name `FENCES_REMOTE_TEXT` map; a
  pin-list was the defect, not the fix.
- **`lib/security-invariants.test.ts` — every tool in the REAL registry has a boolean.** The gap the
  compiler cannot reach: `compileConnector` builds a `ToolDef` from `ManifestTool` data, and
  `sanitizeConnectorManifest` builds one of those from untrusted JSON, where the value is hardcoded
  `true` because that whole class IS a third-party API call.
- **`lib/untrusted-output.test.ts`** drives the dispatcher directly: a declaring tool fences and an
  abstaining one does not; a handler returning bare text still fences; `head`/`tail` land outside the
  block; a body containing the closing marker yields exactly one; a fenced envelope still unwraps for
  the binder; and the ingresses this closed are named individually, so deleting a declaration names
  the issue it reopens.
- **Keep the tag-uniqueness test** ("the fence tag appears only in `lib/untrusted-fence.ts`"). It is
  exhaustive by construction and it fires — it caught a hand-spelled `<untrusted_reference_material>`
  in #749 on its first full run.
- **Review.** The question to ask of any new code that puts a string in front of a model: *who chose
  these bytes?* If the answer is not "this codebase" or "the owner", it is fenced.

## Known outside this ADR's enforcement

**#754 — a webhook trigger's payload becomes a task in the SYSTEM PROMPT**, labelled `(user-set)`.
It is F1 text and it is not a tool result, so no per-tool declaration reaches it. Its cause is a
domain that is complete over the wrong space: `assignedBy` has two values, owner and agent, and no
way to say "a stranger". Recorded here rather than left implicit, because a rule whose gaps are
unnamed reads as a rule with none.

With `lib/terminal-label.ts` fenced under F4, **#754 is the only known system-prompt ingress still
outside this ADR's enforcement**. That is an enumeration, not a proof: this ADR's whole history is
that the fence was never in doubt and its coverage always was, so the claim is worth exactly as
much as the next sweep that tries to break it.
