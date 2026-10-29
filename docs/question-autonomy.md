# Question autonomy: `questions: "ask" | "decide"` (#1385)

A coding run that reaches a decision it cannot make from the issue asks the owner, parks at zero compute and waits. For work the owner has
already scoped, most of those questions are reversible engineering calls ("push now or wait?", "which table layout?"), and each park costs hours.
`questions` says what a run does instead.

| Value | A reversible decision question |
|---|---|
| `ask` (default) | Parks and waits for the owner, exactly as before. |
| `decide` | The run answers it itself with the **most reversible** option, the platform posts the decision on the linked issue, and the run continues. No park, no push, no card change. |

## Where it is set

- **Per run:** `questions` on `POST /v1/instances/:id/loop`, MCP `coding_loop_start` and `start_instance_loop`.
- **Per instance:** `questions` in the instance loop limits (`PUT /v1/instances/:id/loop-limits`, MCP `set_instance_loop_limits`; `null` clears it). `GET` returns it with `effectiveQuestions`.
- A start's own value wins, then the instance default, then `ask`. An unrecognised value is a 400 and starts nothing.
- A queued start keeps its value through the wait; a start that named nothing takes the instance default when the queue starts it. A continue inherits `decide`.

## What `decide` never takes

These park exactly as under `ask`, whatever the options look like:

- a **credential, token, secret or permission** (granting or widening access);
- a **destructive or irreversible** act (delete, drop, destroy, wipe, force-push);
- **spend over a limit**: the iteration-cap approval is never decided, and neither is a question about more iterations;
- **money** (payments, billing, refunds, subscriptions);
- anything that needs the **owner's computer**: a stuck handoff is never offered to the policy;
- a question whose **every option** hands it back to the owner ("give me the id", "your call") or is one of the above.

A guarded or owner-only option among otherwise safe ones is set aside and listed as not considered; the run decides among the rest. The check is
on the question text first: a question that is itself about a guarded act parks. Questions about pricing/branding or the git workflow are
ordinary calls here, not parks.

## What the run's own words have ruled out (#1390)

Reversibility is ranked only among options consistent with the run's objective and the owner's hints. Run 31555ee5's objective said *close #243
only if CI, deploy and a production E2E are all green, otherwise leave it open and report*; the E2E failed, and `decide` took "close" as the
most reversible option, because nothing in it knew the objective.

When the objective, a hint sent mid-run or the standing rules **make closing conditional or forbid it** ("close … only if / unless / once … is
green", "only close …", "do not / never close", "leave it / keep it open"), an option that closes is never chosen for the run. The platform cannot
tell whether "the E2E is green" — that is a fact about the run's own work, which the run checks — so it does not guess in favour of closing. The
closing options are set aside and listed as not considered, with the objective's own sentence quoted as the reason; the rest compete on
reversibility as usual (so "leave it open and report" wins over "close and note"). A bare "yes" to a question that asks whether to close counts
as closing. When nothing is left — every option closes — or a closing question offers no options at all, it parks for the owner. The run can still
close the issue itself once its condition holds; the policy only declines to do it on its behalf.

The check is deliberately narrow: it fires on phrases that plainly gate or forbid closing, an option that says *not* to close is not a closing
option, and an objective that closes unconditionally ("fix it and close #N when done") is unaffected. It covers closing only; other constraints
in an objective are not read here.

## "Most reversible"

A plain ranking of the options left: recording, deferring, keeping, leaving as is, staying local and similar words score up; redeploying,
migrating, renaming, rewriting, publishing and pushing score down; reaching into another repo scores down more. Ties go to the first option
offered. A question with no options is handed back to the run with the guardrails restated. The ranking is deliberately inspectable, not
a model call: it cannot talk itself into a guarded act.

## What is recorded

- The run resumes with a note attributed to the platform (never the owner) naming the decision, why, the alternatives not taken and what to do if it cannot work.
- A comment on the linked issue carries the question, the options, the decision, the alternatives and the options left for the owner. A run with no linked issue records in its commits instead.
- `run_question_decisions` keeps one row per (run, round), including questions `decide` **kept** (outcome `parked`, with the guardrail), so "why did it stop?" has an answer. Retries and replays record and comment once.
- `GET /v1/instances/:id/loop/:runId` and `coding_loop_status` return `questions` and `decisions`.

## Unchanged

`ask` runs take no new workflow step, write no row and post nothing. Runs started before the setting existed read as `ask`.
