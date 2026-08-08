# Capability constraints — declaring what an agent may PASS, not only what it may CALL

> Status: direction, 2026-08-08. Written after a "tmux Operator" was found driving iTerm2 windows
> (#402) and traced to a gap the browser trust model (#75) has been sitting on independently.

## Where the line is today

An agent's capabilities can already say a great deal, and all of it is enforced the same way: **by
deciding which tools exist.**

| Declaration | Effect | Enforced by |
|---|---|---|
| `capabilities.tools: [...]` | the allowlist | `toolNamesFor` — an undeclared tool is not offered and is refused if called |
| `surfaceOptions.coding.drive: false` | chat cannot drive the engine | `agent-do-tools.ts:200` — `send_to_cli`/`read_terminal` are removed from the set |
| `surfaceOptions.coding.repos: "single"` | owns one repo | the console hides add-repo; `agent-self-description` says so |
| write consent (#90) | mutating calls need the owner's say-so | `runRegistryTool` refuses at dispatch |

`surfaceOptions` (`lib/surface-options.ts`) is the good part of this and its header already makes
the argument for its shape: a sibling map, creator-declared, sanitised, persisted with capabilities,
inert for a surface the agent does not declare. It is the right vocabulary.

**What it cannot express is a constraint on a tool's ARGUMENTS.** Every constraint above works by
taking the tool away. That is a complete answer only while "may this agent do X" and "does this
agent have tool T" are the same question.

## Where that stops working

They stop being the same question the moment one tool serves several resources:

- `terminal_list_targets` takes `backend: "all" | "tmux" | "kitty" | "iterm2"`, defaulting to `all`.
  A tmux-only agent cannot be expressed by withholding a tool, because the tool it needs is the one
  that also reaches iTerm2. Today the tmux/kitty/iTerm2 Operators are all the same agent wearing
  three names (#402).
- A browser agent's permission scope (#75) is *a domain allowlist and an action allowlist* — read
  vs click vs type vs navigate-off-origin vs upload. Every one of those is an argument to a tool the
  agent legitimately has. That epic has been blocked on a trust model, and this is a load-bearing
  piece of it.
- A single-target operator ("this instance drives ONE tmux session") is the same shape again: the
  tool is allowed, one argument value is.

The workaround that exists — parallel connectors, `tmux_*` beside `terminal_*` — works and does not
scale. It answers "tmux only" by shipping a second implementation, and there is no `terminal_*`
variant for "only this session" or "only these domains".

## The direction

**A constraint is declared capability, resolved with the rest, and enforced at the tool boundary.**

Three rules, and the third is the one that makes the other two mean anything.

**1. The creator declares a CEILING; the subscriber cannot widen it.**
Backends, domains, actions — these belong with `capabilities` because they are claims the catalog
makes. A tmux Operator is *named* tmux Operator, and `lintAgentClaims` (#362) already checks a
description against capabilities. If a subscriber could widen the ceiling, the description would
become false by configuration, which is exactly what that lint exists to prevent.

**2. The subscriber BINDS within the ceiling.**
*Which* tmux session, *which* machine, *which* folder. This is the existing split, not a new one:
`config.runnerNode` is the subscriber's choice of machine; that the agent uses a machine at all is
the creator's declaration. Drive/WorkDrive folder grants (#352, `grantModel: "instance-resource"`)
are the same idea already built for a different resource.

**3. Enforcement is server-side, at dispatch.**
`runRegistryTool` — beside the write-consent gate, which is already the place a call is refused for
reasons the model does not control. **Not** by hiding a control in the console, and **not** by
instructing the model in the prompt.

That third rule is the whole point and it is worth stating why. This month produced two independent
reminders that a boundary a model can talk around is not a boundary: the agent that wrote its own
tool results and was believed (#395), and the mute guard whose first proposed fix would have removed
the capability it was protecting (ADR 0001). A prompt is a request. A gate is a fact.

Note what is *already* right: `optionsFor` is consulted in four places today, and none of them is
`runRegistryTool` — because every existing constraint is applied by withholding a tool before
dispatch is ever reached. The new enforcement point is genuinely new, not a repair.

## Shape

```
capabilities: {
  surfaces: ["tmux"],
  surfaceOptions: {
    terminal: { backends: ["tmux"], targets: "single" }
  }
}
```

- absent = today's behaviour, exactly (`backends` unset → all; `targets: "many"`);
- a declared constraint narrows and can never widen;
- `targets: "single"` makes the subscriber's bound target the only legal value for a `target`
  argument, the way `runnerNode` makes the pinned node the only machine routed to.

## What this is NOT

- **Not a general policy engine.** A closed vocabulary per connector, reviewed like every other
  extension point here (steps, behaviour fields, stats sources, board actions). Free-form rules
  would hand a creator a language the platform cannot reason about, which is the failure #322 argued
  against for standing policies.
- **Not a replacement for consent.** Consent asks *may this instance mutate at all*; a constraint
  asks *within what*. They compose: consent granted + backend out of scope = refused.
- **Not built ahead of a consumer.** The extraction rule this codebase already follows —
  `work-card.ts`: *"extracted when the second domain arrived, not before"* — applies. There are
  three: terminal backends (now), single-target binding (now), browser scope (#75, gated). Build it
  with the first two; #75 inherits it rather than reinventing it.

## Tickets

| | |
|---|---|
| **#403** | Seed fix: the tmux Operator declares backend-exclusive `tmux_*` tools. No code, no primitive — one true name today. kitty/iTerm2 cannot be fixed this way, which is itself the argument for #404. |
| **#404** | The primitive: constraint declaration + sanitiser + the enforcement point in `runRegistryTool`, with terminal `backends` as its first consumer. |
| **#402** | The terminal consumer: the `backends` ceiling and `targets: "single"` binding, on top of #404. |
| **#75** | Second consumer, demand-gated. Its domain/action allowlist is this primitive; it should not grow its own. |

_Related: `lib/surface-options.ts` (the vocabulary), `lib/tool-registry.ts` (the enforcement point),
#362 (claims lint), #90 (write consent), #352 (instance-resource grants), ADR 0001 (why a prompt is
not a boundary)._
