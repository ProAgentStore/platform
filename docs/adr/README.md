# Architecture Decision Records

An ADR records a decision that **constrains future work** — an invariant, a boundary, a thing
that must stay true — together with the reasoning that produced it, so a later change that would
break it is recognisable as a break rather than an improvement.

This repository already documents a great deal in code comments and in `platform-docs/`. An ADR is
for the narrower case where those are not enough: a rule that is **easy to violate accidentally**,
because violating it looks locally correct.

## When to write one

Write an ADR when all three are true:

1. The decision is a **constraint**, not a description — it forbids something.
2. Someone acting reasonably, reading only the code they are changing, would violate it.
3. The violation would not fail a type-check, and might not fail a test.

The first ADR here exists because exactly that happened: a proposed fix to a real bug
(the agent's own voice issuing commands) would have removed the ability to mute an agent while it
is speaking — which is the single thing the feature was built to provide.

## Format

```
docs/adr/NNNN-short-kebab-title.md
```

Sequential, never renumbered. An ADR is not edited to reflect a change of mind: it is superseded by
a later one that says so, and the old one gets a `Superseded by` line. The record of what we used to
believe is the point.

Each ADR carries: **Status** · **Context** (what was true when we decided) · **Decision** (the rule,
stated so it can be checked) · **Consequences** (what this costs) · **Enforcement** (what would catch
a violation).

## Index

| # | Title | Status |
|---|---|---|
| [0001](./0001-mute-is-always-available.md) | Mute is available at every moment of a voice session | Accepted |
| [0002](./0002-a-guard-states-what-it-measured.md) | A guard states the size of what it measured | Accepted |
| [0003](./0003-a-coder-engine-reports-its-own-turns.md) | A Coder engine reports its own turns | Accepted |
| [0004](./0004-an-audit-event-points-at-content-it-does-not-copy.md) | An audit event points at content; it does not copy it | Accepted |
| [0005](./0005-the-platform-owns-the-conversation.md) | The platform owns the conversation | Accepted |
