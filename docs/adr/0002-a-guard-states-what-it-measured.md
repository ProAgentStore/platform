# ADR 0002 — A guard states the size of what it measured

**Status:** Accepted (2026-08-13) · **Owner decision** · Supersedes nothing.

## Context

This repository defends itself with guards: eight `scripts/check-*.mjs` wired into `ci.yml`, and
around fifteen invariant tests that sweep source trees, migrations and documents. Almost every one
exists because someone was surprised once, and the good ones carry the incident in their header.

On 2026-08-12 three of them were found to be measuring less than they asserted, within a single day:

  * the **#426 mobile-overflow guard** — with both the phone and desktop layouts in the DOM, its
    aria-label query matched a `display:none` element with a zero rect and a computed opacity of 1.
    It passed while measuring nothing. Fixed under #514 by tagging every action control with
    `data-msg-action` and measuring what is painted.
  * **`store/console/src/lib/runnerPanel.ts`'s tile invariant** — its own header promised the tile
    was "derived from BOTH readings, so a disagreement is a test failure rather than a screenshot",
    but `machinesToShow` merged them only for the synthesised tile and the test iterated only the
    pinned node. A non-pinned node with a live socket was untested. Fixed under #531.
  * **`store/console/src/lib/jsx-tags.ts`** — the tag scanner does not treat a backtick as a string
    delimiter, so one apostrophe inside a template literal swallows the rest of a tag. Measured: 33
    tags invisible across two files, and a pinned ratchet reading 42 where the tree holds 43 (#536).

Each was fixed on its own terms. The class is what this record is for, because the three have one
property in common and it is not their subject matter: **each asserted only what it found, never
how much it looked at.** An empty offender list and an empty input set produce the same green tick,
and the guards where someone did assert the input set — `check-design-tokens.mjs`'s
`declared.size < 10`, `check-test-isolation.mjs`'s `isolatedCount === 0`,
`check-migrations.mjs --require-history`, `security-invariants.test.ts`'s "finds the surfaces that
verify inline at all", `tool-reachability.test.ts`'s "reads the migrations it claims to read",
`adr.mjs` throwing rather than returning `[]` — are, so far, none of the ones that failed.

A guard that under-reports is worse than no guard, because the number it prints is trusted. That is
the whole reason this is a constraint and not a style note: a subset measurement does not merely
fail to protect, it actively certifies ground it never walked.

## Decision

**A guard must make the size of the set it examined an assertion, not a by-product.**

Four rules. A guard that violates one is incomplete regardless of what it correctly detects.

**G1 — The input set is asserted, not assumed.** A guard that walks a directory, reads a config,
parses a document or matches a pattern must fail when that input is empty, implausibly small, or
structurally unrecognisable — with a message that says the guard has stopped measuring, not that
the code is clean. `parseThemeColorTokens` returning 3 tokens is not a clean tree, it is a moved
`@theme` block.

**G2 — The denominator is stated in the passing output.** A guard's success line names how many
files, tags, routes, migrations or phases it examined. A number that is only correct while nobody
reads it is how an under-count survives; printing it puts the evidence in every green build.

**G3 — A scanner that cannot parse something reports it.** Skipping an input the parser failed on
converts a bug in the parser into a silently smaller measurement. Count the failures and assert
they are zero, or throw. `if (j >= source.length) continue;` is the shape this forbids.

**G4 — A new guard is proven by watching it fail.** Before it lands, reintroduce the defect it was
written for — revert the fix, plant the fixture, delete the attribute — and record that the
assertion flipped. A guard whose only evidence is that it passes has evidence of nothing: every
guard passes on the day it is written, including the ones that measure the empty set.

## Consequences

Guards get slightly longer and slightly noisier. `✓ store/console: 43 hand-authored control shapes
over 5473 tags in 69 files` is a worse headline than `✓ clean` and a much better artefact, because
the next person to change the scanner can see the denominator move.

G1 has a real cost where the denominator is genuinely unstable: a threshold set too tight fails on
honest growth, and one set too loose asserts nothing. The answer is a bound with a reason beside it
("fewer than 10 colour tokens means the block moved"), never a bound chosen to make today's number
pass.

G4 costs one throwaway commit per guard, and it is the rule most likely to be skipped under time
pressure. It is also the only one of the four that would have caught all three of the 2026-08-12
failures before they shipped.

This record does NOT require a shared lexer, a guard framework, or a common harness. Guards measure
different kinds of thing and a framework that fitted all of them would fit none of them well. What
is required is that each states its own size in its own vocabulary.

### The follow-on this record deliberately does not order

The #536 audit counted **eight independent implementations of "strip JS source so a scanner can
match it", at four fidelities**: `workers/api/src/lib/source-guard.ts` (the reference — comments,
quotes, templates with `${…}` preserved as code, regex, escapes), `prompt-claims.ts`'s
`promptTextOf` (the deliberate inverse), `scripts/lib/bare-catch.mjs` (blanks the whole template
span), `store/console/src/lib/jsx-tags.ts`, `scripts/lib/design-tokens.mjs`,
`usage-aggregates.ts`, `usage-claims.test.ts` and `mute-touch-invariant.test.ts` (the last four
comment-only). Only the first two are unit-tested as lexers, and nothing in the output distinguishes
the fidelities: all eight print an equally confident number.

Consolidating them is real work with a package boundary in the middle — the console cannot import
from `workers/api`, so a shared lexer means moving one into `packages/sdk` — and it should be its
own issue, not a rider on a bug fix. **Until it is done, the obligation this ADR places on a
hand-rolled source scanner is G1 plus its own unit test naming what it does NOT handle** — the
discipline `scripts/lib/bare-catch.mjs`'s header already claims ("a regex-shaped guard nobody tests
is one edit away from silently passing") and which `jsx-tags.test.ts` now meets. Two comment-only
strippers for one feature area (`usage-aggregates.ts` and `usage-claims.test.ts`) are not a
boundary, they are a copy, and should merge whenever either is next touched.

## Enforcement

  * Review. The three failures above were all found by reading, and this document is what makes
    "where is the denominator?" a routine question at review rather than an insight.
  * The pattern is already established and can be copied rather than invented:
    `scripts/check-design-tokens.mjs`, `scripts/check-qa-config.mjs` and
    `scripts/check-agents-allowlist.mjs` (G1); `scripts/check-file-size.mjs` and
    `scripts/check-test-isolation.mjs` (G2); `workers/api/src/lib/tool-reachability.test.ts` (G1
    and G3); `scripts/lib/adr.mjs` (G1 by throwing); `workers/mcp/src/index.test.ts`'s "blocks
    EVERY registered tool, not a hand-picked list", which asserts the registered-tool count
    against a constant before iterating it (G1 and G2 together, and the hardest thing in this
    repo to fool); `workers/api/src/lib/migration-hygiene.test.ts`, which drives the real
    `check-migrations.mjs` as a child process over throwaway git repositories and asserts each
    arm goes RED for the mistake it is about, and
    `workers/api/src/lib/connection-outcome-guard.test.ts`, whose header states the inverse test
    in words — "restore the unguarded `WHERE id = ?1` and every test here goes red" (G4).
  * A pointer to this ADR belongs beside any hand-rolled source scanner, one hop from where it
    would be broken.
  * A mechanical check of G1 is deliberately NOT proposed: it would grade on the presence of an
    assertion rather than on what the assertion means, and this repository has already measured
    what that produces (#305's `biome-ignore` comments, which had drifted off the lines they
    covered and were suppressing nothing).
