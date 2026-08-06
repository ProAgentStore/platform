# Agent UI as composable blocks

> Status: decision + plan. Resolves #188; implements #187. Companion to `custom-surfaces.md`.

## The problem

An agent's UI has two settings: **take a whole built-in surface**, or **build everything
yourself**. Nothing between them.

That canyon is why a Repo Coder — one repo, driven by its Lead — shipped with add-repo, a
multi-repo list and a duplicate way to drive an engine: declaring `surfaces:["coding"]` was the
only way to get a terminal. Surface options (`surfaceOptions`) patch that symptom. The cause is
that surfaces are monolithic.

It is also why the same UI exists several times over. The chat thread is implemented **three**
times, near line-for-line, including the same tool-call regex and the same scroll threshold.
There are five hand-rolled relative-time formatters, none using the SDK's. Two kanban boards. Two
file lists. And the console rendered terminal output as an uncolorized `<pre>` while the Coder
colorized the same bytes — purely because the colorizer lived inside one agent's package.

Every one of those is a block that wanted a shared home and had nowhere to live.

## Decision: inject a DOM factory, not React

Third-party surfaces get first-party components through an **imperative factory** on `ctx.sdk`:

```js
export function mount({ el, sdk, instanceId, sessionId }) {
  const term = sdk.ui.terminal(el, { instanceId, sessionId });   // → { update, destroy }
  return () => term.destroy();
}
```

The console creates a React root internally; `destroy()` unmounts it.

**Why not hand over React.** Three reasons, in order of weight:

1. **No React identity crosses the boundary.** A bundle shipping its own React 18 still works,
   and upgrading the console's React cannot break third-party code we do not control. Handing out
   `createElement`/`createRoot` couples every bundle to our major version forever.
2. **Bundles are not React.** The contract is `mount(el)` → DOM, the documented example is
   `el.innerHTML`, and the only shipped example is string templating. A React *element* given to a
   plain-DOM bundle is an opaque object it can do nothing with.
3. **There is no module-sharing channel anyway.** The console builds to one inlined
   `<script type="module">` — no import map, no `window.React`, no externals. A bundle writing
   `import React from "react"` fails on an unresolvable bare specifier. Injection is not a
   preference here; imports genuinely do not work.

`docs/custom-surfaces.md` also promises creators may bundle their own framework. Injecting React
would quietly retract that.

### What this costs

A React root per injected component, and `update()` is clunkier than declarative props. Accepted:
the alternative trades a permanent compatibility constraint for syntax.

## Prerequisites (not optional)

- **The SDK is a module-level singleton**, frozen at import and shared by every surface on every
  instance. Injected components need per-mount scoping and a teardown list, so it must become
  `makeSdk(ctx)`.
- **Teardown must unmount injected roots BEFORE `innerHTML = ""`.** Wiping the DOM under a live
  React root leaks the root and its effects — subscriptions, EventSource, polling loops.
- **Each injected root wrapped in an ErrorBoundary.** ✅ `DynamicSurface` itself is now wrapped
  (an async `mount()` throw — the pattern the docs promote — previously escaped to the global
  handler and left a blank tab).
- **Reserved surface ids.** ✅ Closed. Without it a rogue surface could render a *real*
  first-party Terminal inside a *fake* Settings tab — far more convincing than a hand-built
  imitation.

## Extraction order

By value, hardest constraints noted:

| # | Block | Status | Note |
|---|---|---|---|
| 1 | **Terminal colorizer** | ✅ shipped | Pure, no React. Fixed an XSS on the way out. |
| 2 | `ChatThread` | next | Six duplications collapse. ~200 lines inlined in a 789-line page; needs a `renderMessageBody` slot so the gloss layer stays out of the library. |
| 3 | `RunList`/`Timeline` | | Three components converge; props already `{instanceId}`, only lookup tables differ. |
| 4 | `Board` | | One `useNavigate` to invert into `onOpenItem`; hoist apply-retry and the BROWSER_TASK form into props. |
| 5 | `FileList` + `FilePreview` | | Blocked only on relocating `UploadJob`. |
| 6 | Primitives | | `Modal`, `CopyButton`, `EmptyState`, `StatusPill` — and delete the five time formatters. |

`agents/coder/web` is the precedent to copy: a workspace package with React as a **peer**
dependency.

## The styling blocker, stated plainly

This is what will actually stall the work, so it needs deciding before block 2:

- Theme tokens (`--color-panel`, `--color-accent`, …) are defined **only** in the console's
  `@theme`. Every candidate block is saturated with `bg-panel border-line text-accent`. A package
  built outside the console emits classes with no definitions.
- Components silently depend on global CSS: `.msg-md`, `.chat-scroll`, `scrollbar-none`.
- The cross-package Tailwind scan is a one-off hack — a literal
  `@source "../../../agents/coder/web/src"`. Every new package needs another line, and **no
  `@source` can ever cover a third-party bundle built outside this repo.**

The terminal colorizer sidestepped all of it by emitting inline styles and no classes. That will
not work for `ChatThread`. Either the UI package ships its own `@theme` block for consumers to
import, or the components move to CSS-variable-backed inline styles.

## Not in scope

Sandboxing custom surfaces (iframe / Shadow DOM). Worth doing — a bundle today shares the
document and can monkey-patch `window.fetch` — but it is a separate change, and Shadow DOM in
particular would break every Tailwind class an injected component relies on. See #186.

Note this is now the **blocking** work, not merely deferred: custom surfaces ship **disabled**
(`CUSTOM_SURFACES_ENABLED`, unset in production — see `docs/custom-surfaces.md`), because the
same-origin requirement means only platform-served bundles are loadable, and the platform serves
none. A third-party surface becomes possible when this sandbox exists, not before. The UI blocks
described above are unaffected — they are first-party components consumed inside the console.
