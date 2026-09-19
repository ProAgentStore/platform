# subrequest-reset-probe (throwaway — refs #814)

One question: **does a Cloudflare Workflow's subrequest counter reset across a `step.sleep`?**

`workers/api/src/lib/coding-idle-poll.ts` rejected #814's fix (chunk the Pilot's idle poll across
`step.sleep` boundaries) because the limits page says subrequests are counted "per Workflow
instance". The page does **not** say what a sleep or a step boundary does to that count, so "a
`step.sleep` does NOT reset the counter" is an inference. This measures it. The reasoning and the
three modes are written out in `src/index.ts`.

**This is not part of the platform.** It is outside `pnpm-workspace.yaml`, is not built,
typechecked or linted by CI, and no workflow in `.github/` deploys it. It has no route, no
`workers.dev` hostname and no preview URL. Nobody has deployed it — it was written to be run once,
by the account owner, and deleted.

**Cost:** about 300 tiny fetches to `cloudflare.com/cdn-cgi/trace` in total, and a few minutes.
Needs the **paid** Workers plan (the free plan's subrequest limit is 50, below one burst) — the
PAGS account is paid. Run everything from this directory; `npx` fetches wrangler, nothing is
installed into the repo.

## 1. Deploy

```bash
cd scratch/subrequest-reset-probe && npx wrangler@4 deploy
```

## 2. Trigger — three runs, and read each result

`trigger` only prints an instance id; the answer is in `describe`, under the instance's **Output**
(`verdict` is the one-line reading, `bursts` is the evidence).

```bash
npx wrangler@4 workflows trigger subrequest-reset-probe '{"mode":"control"}'
npx wrangler@4 workflows instances describe subrequest-reset-probe latest

npx wrangler@4 workflows trigger subrequest-reset-probe '{"mode":"sleep","sleep":"1 second"}'
npx wrangler@4 workflows instances describe subrequest-reset-probe latest

npx wrangler@4 workflows trigger subrequest-reset-probe '{"mode":"sleep","sleep":"2 minutes"}'
# wait ~2.5 minutes for this one to finish before describing it
npx wrangler@4 workflows instances describe subrequest-reset-probe latest
```

**Run `control` first, and do not skip it.** It does 120 fetches in ONE step against a configured
limit of 100, so it must be cut off near the 100th. If it reports `LIMIT NOT HONOURED`, Cloudflare
ignored a `[limits]` value that low, and the `sleep` runs would "succeed" with or without a reset —
they prove nothing. In that case raise `subrequests` in `wrangler.toml` and `CONFIGURED_LIMIT` /
`BURST` in `src/index.ts` together (keep `BURST` < limit < 2 × `BURST`), redeploy, and start again.

Two `sleep` runs because a 1-second sleep may be served without the instance leaving memory, while
2 minutes makes hibernation — a genuinely new invocation — far more likely. If they disagree, that
difference is the finding. Optional fourth run, same price: `'{"mode":"step"}'` (a `step.do`
boundary with no sleep), which the repo's comment also claims does not reset the count.

If an instance shows **Errored** instead of an Output, that is still data: copy the error text.

## 3. Delete

```bash
npx wrangler@4 workflows delete subrequest-reset-probe && npx wrangler@4 delete --name subrequest-reset-probe
```

Then `npx wrangler@4 workflows list` should no longer name it. Delete this directory in the same
commit that records the result — a probe that has answered its question is dead code.

## What to post on #814

Paste, for **each** run: the params, the `verdict` line, and the `bursts` array. Then one of:

| Control | Sleep runs | Meaning for #814 |
|---|---|---|
| `LIMIT HONOURED` | `DOES NOT RESET` (both) | The repo's inference is now a measurement. Chunking buys nothing for #523's ceiling. Close #814 as not planned; if surviving an eviction mid-turn is still wanted, that is a different ticket with a different argument. |
| `LIMIT HONOURED` | `RESETS` (either) | The rejection in `7e23b605` rested on a false premise. #814 is worth building — and the header of `lib/coding-idle-poll.ts` plus the `[limits]` comment in `workers/api/wrangler.toml` both need correcting, because they state the opposite as fact. Say which sleep length reset it. |
| `LIMIT NOT HONOURED` | anything | No conclusion. Say what limit you had to raise it to before the control was cut off. |

Also worth one line: the **error message** the control run was cut off with. The platform's
classifier matches on that text (`CEILING_MARKERS` in `workers/api/src/lib/coding-failure.ts`), and
this is a free chance to confirm the wording against production.
