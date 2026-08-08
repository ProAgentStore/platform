# PAGS Design System

ProAgentStore runs its own design system. The shared six-store
`~/dev/stores/DESIGN-SYSTEM.md` records PAGS as out of scope (§0, decided 2026-08-07) and points
here.

This document is **descriptive except in two places**. Every number below was measured from the tree,
not proposed, and where the console contradicts itself that is written down as a contradiction
rather than quietly resolved in prose — a design system that describes an app nobody built is the
failure mode this document exists to avoid (#367).

The two exceptions are the **type scale** (§2) and the **24px touch-target floor** (§3), both added
2026-08-08. §6 asked whether this document may become prescriptive and about what; the answer is
*only where the rule is enforced*. Both of those are, in CI and in the suite (§5) — a prescriptive
sentence nothing checks is the same fiction as a description nobody wrote.

## 0. What PAGS deliberately does not take from the shared system

| | Shared six-store system | PAGS |
|---|---|---|
| Themes | light **and** dark | **dark only** |
| Theme mechanism | `data-theme` on `<html>` | none |
| Theme storage | `localStorage["stores-theme"]`, shared so a preference follows the user between stores | none |
| Status colours | `--danger` / `--success` / `--warning`, each with a `-soft` pairing | its own tokens, dark-only values |
| Tailwind | v3 preset via `presets: [...]` | v4 `@theme` in CSS — v4 removed the preset mechanism, so the shared preset file cannot be vendored even in principle |

Verified dark-only: `data-theme`, `prefers-color-scheme` and `stores-theme` appear **nowhere** in
`store/console` or `store/admin` (the one `prefers-reduced-motion` block is unrelated).

**The accepted cost, stated so it is not rediscovered as a bug:** a user moving between a storefront
store and the PAGS console gets a theme discontinuity. Someone who set light mode on
freeappstore.online lands on a black console.

**What is kept because it is good practice rather than a cross-store contract:** named tokens, and
the rule *never hardcode a colour where a token exists*. Owning the system is a reason to have
tokens, not a licence to scatter Tailwind literals — #368 is what the absence of that rule looked
like.

## 0b. The Tailwind setup — v4, CSS-first, no config file

Recorded because "which Tailwind is this" decides what half the advice on the internet is worth, and
because the v3 shapes are the ones a contributor reaches for by habit. Measured 2026-08-08 on both
`store/console` and `store/admin`:

| | |
|---|---|
| Version | `tailwindcss@^4.3.1` |
| Build | **`@tailwindcss/vite`** plugin (`vite.config.ts`) — v4's first-class path, not PostCSS |
| Entry | **`@import "tailwindcss";`** — *not* `@tailwind base/components/utilities` |
| Config | **none.** No `tailwind.config.js`, no `postcss.config.js`, in either app |
| Tokens | `@theme { --color-…: … }` in `index.css`, consumed as ordinary utilities |
| Extra content roots | **`@source "../../../agents/coder/web/src";`** — the v4 way to scan a sibling package the app imports (`coder-web` has no stylesheet of its own) |
| Custom utilities | **`@utility scrollbar-none { … }`** — v4's API, not `@layer utilities` and not a plugin |
| `@apply` | **zero uses**, in either app |

All of that is current v4 idiom, and it is the whole toolchain: there is nowhere else a Tailwind
decision can be hiding. Three consequences worth stating, because each is a thing a contributor can
undo without noticing:

- **Do not add a `tailwind.config.js`.** v4 reads configuration from CSS. Adding one does not merge
  with `@theme` — it changes how the whole app is configured, and it is the single most common piece
  of stale v3 advice.
- **`@source` is load-bearing, not tidiness.** Delete it and every class used only inside
  `agents/coder/web` stops being generated — the Coding tab loses its styling with no error, the
  same silent-failure mode §1 describes for a token that does not exist.
- **Prefer a component over `@apply`.** The zero count is worth keeping: `@apply` was the v3 answer
  to "this control is repeated 291 times", and it moves the duplication into CSS rather than
  removing it. The answer here is the component layer (§3, built at #366), not a `.btn` class.

## 1. Tokens

Declared as Tailwind v4 `@theme` custom properties, consumed as ordinary utilities (`bg-panel`,
`text-muted`, `border-line`).

| Token | Value | Used for |
|---|---|---|
| `--color-paper` | `#0a0a0a` | Page background |
| `--color-panel` | `#141414` | Cards, modals, sticky headers, menus |
| `--color-panel-hover` | `#1a1a1a` | Hover on a panel |
| `--color-ink` | `#fafafa` | Body text |
| `--color-ink-strong` | `#fff` | Headings, emphasis |
| `--color-muted` | `#a3a3a3` | Secondary text (415 uses — the most-used token in the app) |
| `--color-muted-soft` | `#737373` | Tertiary text, placeholders, empty states |
| `--color-accent` | `#7c3aed` | The brand colour: links, primary actions, focus ring |
| `--color-accent-hover` | `#6d28d9` | Accent hover |
| `--color-accent-soft` | `rgba(124,58,237,0.15)` | Focus ring, tinted accent background |
| `--color-line` | `#303030` | Borders, dividers |
| `--color-line-strong` | `#404040` | Emphasised borders |
| `--color-green` | `#22c55e` | Success / online |
| `--color-red` | `#ef4444` | Error / destructive / offline |
| `--color-yellow` | `#eab308` | Warning / waiting |
| `--color-blue` | `#3b82f6` | Informational / in-progress |

Fonts: `--font-body` Manrope, `--font-display` Fraunces, `--font-mono` SF Mono — identical to the
shared system, loaded from Google Fonts in each app's HTML entry.

### The tokens are named for pigment; meaning is applied one layer up

`--color-green` says what it *is*, not what it *means*, and `text-red` alone carries at least four
unrelated meanings across the tree (an error message, a destructive action, a `write` scope label, an
offline state). The shared system's answer is to name the token for intent (`--danger`).

PAGS's answer today is an intent layer in **code** rather than CSS: `store/console/src/lib/statusBadge.ts`
maps a status → an intent (`success` · `danger` · `warning` · `info` · `neutral`) → a token pair. Any
surface showing a status chip must go through it. Renaming the CSS tokens to intent remains open;
the code layer is what makes the rename a one-file change when someone does it.

### A token that does not exist is silent

Tailwind v4 has no error state. A utility naming a token `@theme` does not declare generates **no rule**,
so the element keeps whatever colour it inherited: a warning label renders as ordinary body text, and a
bordered element keeps v4's `currentColor` default — a near-white 1px line on a black page. Nothing else
in this repo can see it. Biome lints JS/TS and cannot read a class name; `tsc` sees a string; the build
succeeds; a screenshot looks plausible.

Twenty-six of these had accumulated by 2026-08-08 (#367): two status-tone lookups, two banners on the
agent-create screen, four Behaviour-tab sections wearing the near-white outline, and an entire vocabulary
from somebody else's design system — generic `surface`/`base`/`bg`/`border` naming, pasted in, alive in
five files. All fixed, and `scripts/check-design-tokens.mjs` now fails the build on the next one.

**The rule:** every colour utility must name a token declared in the `@theme` block that compiles it, a
numbered shade of Tailwind's default palette, or one of `white`/`black`/`transparent`/`current`. Note
which `@theme` compiles which tree — `agents/coder/web` has no stylesheet of its own; the console
`@source`s it, so its classes are judged against the console's tokens and a dead one there is invisible
from inside its own package.

### The missing `-soft` pairings

`@theme` declares a soft background for the accent (`--color-accent-soft`) and for nothing else. Every
tinted status background is therefore an opacity modifier: `bg-red/10` (16 uses), `bg-green/15` (9),
`bg-yellow/10` (8), `bg-accent/10` (11). It works, and it is a hack — the alpha is picked per call
site, which is why both `/10` and `/15` are in use for the same idea. Declaring
`--color-{green,red,yellow,blue}-soft` would collapse those into one decision.

## 2. Type — the one prescriptive rule in this document (#390)

**The scale is closed. A font size names a step; it is never written as a value.** This is the
first rule here that says what the console *must* be rather than what it is, and it is enforced
(§5), which is what makes it worth stating.

| Step | px | Where |
|---|---|---|
| `text-2xs` | **11** | The floor. Dense telemetry only — Terminals, Activity, log rows, chips |
| `text-xs` | 12 | The console's real body size — tables, labels, descriptive copy |
| `text-sm` | 14 | Chat messages, form fields, primary reading text |
| `text-base` | 16 | Section headings |
| `text-lg` / `text-xl` | 18 / 20 | Page titles |
| `text-2xl` / `text-3xl` | 24 / 30 | Sign-in, empty states |

`--text-2xs` is declared in both `@theme` blocks (§4) with its `--line-height` companion; every
other step is Tailwind's own. **11px is a floor, not a suggestion**: anything a user reads to make
a decision belongs at `text-xs` or above, and `text-2xs` exists because the console has two screens
whose entire content is status text and Tailwind's scale stops at 12.

### What it replaced

Before this, 190 arbitrary bracketed sizes across **17 values**: `0.55 · 0.6 · 0.62 · 0.65 · 0.66 ·
0.68 · 0.7 · 0.72 · 0.74 · 0.75 · 0.76 · 0.78 · 0.8 · 0.82 · 0.875 · 0.95 · 1.1rem`, plus five
`10px` in `store/admin` and one `11px` in the Coder UI. Nine of them sat inside a 2px band, and
0.68 against 0.7 is 0.32px at a 16px root — a difference nobody chose 19 times. Rendered, that was
**148 sub-12px strings on one Terminals screen**, 100 on Activity, and 9.9px descriptive copy under
form controls on the instance Settings tab.

They were collapsed by ONE mechanical rule, stated so the result is checkable rather than a matter
of taste: **round to the nearest step; ties, and anything below the 11px floor, round UP.** The
largest change is +2.2px (8.8px → 11) and the largest shrink is −0.8px (12.8px → 12). 173 of the
224 sites landed on `text-2xs`. Nothing was moved by judgement, and nothing that a user reads got
smaller.

### Why the lint could not have come first

The count went UP between #366 and this (174 → 180 → 190 measured across all three trees as 224):
#366 built the `Button`/`Badge` primitives that own the type step for every control they render,
but the controls it migrated were already on `text-xs`/`text-sm`, so it absorbed none of these.
The sizes that drifted are on labels, table cells and descriptive copy — a component layer has
nothing to grip. What they needed was a **destination**, and a lint before there was one is 190
blocked edits, which is exactly what #390 said. The step is the destination; the gate is what stops
the next one.

Weight: `font-semibold` (254) and `font-bold` (172) do nearly all the work; `font-medium` (25) is a
minority third weight. `font-display` (Fraunces) appears 11 times — page titles only.

## 3. Shape and spacing

Radius comes from Tailwind's scale, not a token: `rounded-lg` (239) · `rounded-xl` (107) · bare
`rounded` (99) · `rounded-full` (40) · `rounded-md` (20). The convention that emerges: **`rounded-lg`
for controls and inputs, `rounded-xl` for cards and panels, `rounded-full` for pills and avatars.**
Bare `rounded` is mostly older code.

Control padding clusters on `px-3 py-1.5` (83) for a normal button, `px-2.5 py-1.5` (38) for a small
one, `px-3 py-2` (60) for an input, `px-1.5 py-0.5` (22) for a chip. Gaps cluster on `gap-2` (180) and
`gap-1.5` (58) inside a control, `gap-3` (68) between them.

### The atomic layer: one table, three components (#366)

Those clusters were 47 distinct padding+radius combinations across 266 `<button>` elements, and the
two biggest — `px-3 py-1.5` (58) and `px-2.5 py-1.5` (22) — differ by 2px and nothing else. Nobody
chose that difference 22 times.

`store/console/src/lib/control-classes.ts` is now the single answer, as DATA: `BUTTON_SIZE` (four
steps: `sm` · `md` · `lg` · `icon`), `BUTTON_VARIANT` (four intents: `primary` · `secondary` ·
`ghost` · `danger`), `CARD_GEOMETRY` (one, `rounded-xl p-3 sm:p-4`) and `BADGE_BASE`. `components/`
holds the three thin presentational wrappers — `Button`, `Card`, `Badge` — and `buttonClass` /
`cardClass` are exported for the handful of call sites that must look like a control without being
one (a `<label>` wrapping a hidden file input cannot be a `<button>`).

Three properties are load-bearing, each asserted in `control-classes.test.ts`:

- **Size and variant are separate axes.** A variant carries colour and weight and no padding; a
  size carries padding, radius and a type step and no colour. A variant that also sized itself
  would multiply back out into the combinations this replaces.
- **Every utility is written out whole.** Tailwind v4 finds classes by scanning source text, so an
  interpolated `` `rounded-${size}` `` generates nothing — the same silent-nothing failure as a
  dead colour token (§1), with no build error. `components/Page.tsx` learned this first.
- **The badge's tones come from `lib/statusBadge.ts`**, not a private copy. #368 refused to invent
  a third status vocabulary; a fourth here would be the same mistake with better intentions.

**What the vocabulary deliberately does not model**, because inventing a variant for each would be
a table describing one call site: a `rounded-full` pill, a segmented control with an active arm, a
card-shaped button with a selected state, and an icon button drawn over content with its own
scrim. Those stay hand-written and are counted (§5).

Mobile: form controls are forced to `font-size: 16px; min-height: 44px` below 640px (`index.css`).
Both numbers are deliberate — 16px is the threshold below which iOS Safari zooms the viewport on
focus, 44px is Apple's minimum touch target. Do not "tidy" them.

### Touch targets — the second prescriptive rule (#389)

**Every control clears 24×24 CSS px in both axes.** That is WCAG 2.5.8 *Target Size (Minimum)*,
Level AA — a published number rather than a house preference, which is what makes it assertable.
Apple's 44 and Material's 48 are not the floor here, and the reason is arithmetic: every control in
this console renders between 24 and 38px tall, so a 44px box floor would re-lay-out every dense row
in the app under cover of an accessibility fix.

44 is met where it matters as **reach, not box size**:

- **`BUTTON_SIZE` carries `min-h-6 min-w-6` on all four steps.** A floor, not a resize — every step
  already rendered at or above 24 (24 · 30 · 36, `icon` 24), so nothing moved on screen. It reaches
  all 57 migrated call sites and every future one, and `control-classes.test.ts` asserts it per
  entry so a fifth step cannot be added without it.
- **`input[type=checkbox|radio]` are sized in the base layer**: 20px, and 24px below 640px. They
  were the one control nothing sized at all — excluded from the form-control block (a `width: 100%`
  checkbox is a full-row box) and therefore left at the UA default of 13×13 in Chromium, 12×12 in
  WebKit. One rule reaches all 22 sites across the console and the operator portal; the call-site
  `w-3 h-3` / `w-4 h-4` overrides were removed so the rule is the real size.
- **`@utility tap-target`** grows a control's pointer region to 44px **vertically** without growing
  its box, for the chat bubble's Copy / Delete-this-turn actions and the 11×11 replay button. The
  restriction to one axis is the design, not a shortcut: a `::after` overlay paints with its own
  element and siblings paint in DOM order, so a later control's wide region sits on top of an
  earlier one's real box — Copy and Delete are 2px apart, and expanding both would put the
  destructive one over a third of the other. The utility's comment carries that arithmetic.

Where a control could not be made to clear 24 by a table change, it was fixed by hand: `RepoTab`'s
*Show files* / *Re-index* / *Remove* were bare text with no padding, rendering 16px tall — with the
destructive one beside the two that are not. They are `<Button size="sm">` now, and *Remove* is
`variant="danger"`.

## 4. Where the tokens live — three copies

| Surface | Where | Form |
|---|---|---|
| Console SPA | `store/console/src/index.css` | Tailwind v4 `@theme` |
| Admin SPA | `store/admin/src/index.css` | Tailwind v4 `@theme` (a copy) |
| Marketing store pages | inline `<style>` in `store/**/*.html` + `store/build-details.js` | plain `:root` custom properties, redeclared **13 times** |

The console and admin copies are byte-identical in value and are now kept that way by a test.

**The marketing pages disagree with the SPAs on two values**, and have since before this measurement:

| Token | Console / admin | Marketing HTML |
|---|---|---|
| panel | `#141414` | `#171717` |
| line | `#303030` | `#262626` |

The marketing pages also declare `--free: #3b82f6` (the FreeAgentStore cross-link colour in the OFO
footer), which the SPAs have no equivalent for, and one page declares `--radius: 8px` where the rest
declare `0.75rem`. Nothing merges these; a change to the console palette does not reach the store
front page.

## 5. What is enforced, and what is taste

Four guards, each holding only what a machine can honestly hold.

**`scripts/check-design-tokens.mjs`** — a CI step (`ci.yml`, alongside the other `check-*.mjs` guards),
because it covers three trees rather than belonging to one package. Two rules over the same source,
against the same `@theme`, because they are two halves of one idea — *a class name must name a
decision, not a value*:

1. **No colour utility may name a token nothing declares** (§1). A gate at zero for `store/console`
   and `agents/coder/web`; `store/admin` is pinned at 2, since fixing those needed a tree that had
   uncommitted maintainer work when this landed — pinned rather than excluded, so the debt is
   visible and may only go down.
2. **No font size may be written as a bracketed value** (§2), added at #390. A **gate at zero in all
   three trees**, which it can be because that ticket collapsed all 224 of them onto steps first.
   It matches length-valued brackets only — `text-[#fafafa]` and `text-[color:var(…)]` are a colour
   and a variable, and folding them in would make the failure message wrong for them. It also
   asserts that any declared `--text-*` step has its `--line-height` companion: a step without one
   emits a `line-height` naming a variable that resolves to nothing, which is rule 1's failure mode
   one property over.

The mechanism is a pure module (`scripts/lib/design-tokens.mjs`) with its own tests, which is also
the first test coverage any guard under `scripts/` has had.

Two things about it are load-bearing:

- **It scans SOURCE, not the built stylesheet.** Tailwind v4's source scan reads comments and strings,
  so an output-scanning guard is defeated by a doc comment — quoting the broken class names while
  explaining them is what regenerated #368's exact rules into the built CSS from its own postmortem.
  For the same reason, never write a dead utility verbatim in a comment; describe its shape.
- **Comments are blanked before scanning.** This tree's prose is full of hyphenated phrases that a
  class-name regex reads as utilities (a lazy fill-in fallback, a jump-to-bottom button, tap-to-talk).
  Every one would be a false positive, and a guard that cries wolf gets suppressed rather than fixed.

**`store/console/src/lib/designTokens.test.ts`** — in the normal unit suite. Three things, each mechanical
and each matching a defect that actually shipped:

1. **No pale Tailwind background** (`bg-*-50/100/200`) in any of the three trees — a gate, at zero. This
   is the exact signature of #368. Allowlisted: `pages/Login.tsx`, whose white Google button is
   brand-mandated and is a white button on every site that has one. `agents/coder/web` joined on
   2026-08-08: it ships *inside* the console but lives outside `store/`, so the first cut of this gate
   scanned two of the three trees that share one palette — and three cream-on-black banners were sitting
   in the third while both gates read green.
2. **Raw palette classes are pinned** at 33 (console), 1 (admin) and 9 (Coder UI) — a ratchet, not a
   gate, because the count is not zero. Pinned exactly, like the file-size ratchet: removing a use lowers
   the pin in the same commit, so the ground taken is not left as headroom.
3. **The console and admin `@theme` blocks are equal** — the admin file claims its tokens are "shared
   with the console"; they are shared by copy, so nothing was keeping the claim true.

**`store/console/src/lib/control-shapes.test.ts`** — also in the unit suite, added at #366. **No new
`<button>` may draw its own box**: a ratchet over any button whose class attribute names both a
padding and a radius utility, pinned exactly at **124** (console), 15 (admin) and 48 (Coder UI), and
it may only go down. 47 shapes accumulated because nothing failed when a fifteenth appeared, and a
sweep without a ratchet is a photograph of a tree that keeps growing — #367's guard caught five
defects that landed on main from another author *while its own sweep was running*.

Stated so the number is not read as "all of it": it covers `<button>` only. A `<Link>` styled as a
button is not counted, which also means the ratchet is **evadable** by swapping the tag; cards and
badges are not counted either, because `<div>` is the wrong unit to scan and padding+radius does
not tell a card from a code block. And it says nothing about whether the variant chosen was the
right one — that is taste, and the paragraph below applies.

**`e2e/console.spec.ts` — "every control clears the 24px minimum target"**, added at #389, and the
first geometry guard here that measures a rendered box rather than source text. It walks the same
11 routes the overflow sweep visits, at 390px, in **both** Chromium and WebKit (it carries the
`mobile — ` prefix that #384 made load-bearing), and fails on any `<button>` or checkbox/radio whose
**effective target** is under 24×24. Effective means the union of the element's own box, its
`::after` overlay — which is how it sees `tap-target` — and, for an input, the `<label>` that
encloses it, because clicking that label *is* clicking the control.

Two holes, said out loud. It skips a `<button>` with no background, no border and no padding — a
link wearing a button tag — which is the same class `control-shapes.ts` excludes and for the same
reason, and which is precisely the shape `RepoTab`'s destructive 16px *Remove* had: this guard could
not have caught the defect that motivated it, and that one was fixed by hand. And it only sees what
the fixture renders, so Terminals and the Behaviour tab — two of the routes the audit found worst —
are thin here.

**Not enforceable, and honest to say so:** spacing rhythm, whether a given control should be a button
or a link, information density, when a surface is `panel` versus `paper`, icon choice, and whether
`/10` or `/15` is the right tint. These are judgement, and a lint that pretended to check them would
only teach people to suppress it.

**Deliberately not enforced yet:** the marketing-vs-SPA palette split (§4 — resolving it is a
restyling decision about the marketing pages, not a lint), and card/badge geometry (`<div>` is the
wrong unit to scan, per the paragraph above).

## 6. Open

- **Rename the pigment tokens to intent, and add the `-soft` pairings** (§1). Still the right change and
  deliberately not taken in #367's sweep, for two reasons worth recording. It cannot be done in the
  console alone: the `@theme` blocks are held equal by test (§5.3) and the second copy lives in
  `store/admin`, so the rename is one commit across both trees or it is a broken guard. And adding
  `--color-danger` as an *alias* beside `--color-red` without migrating ~200 call sites would leave two
  names for one idea — the failure #368 explicitly refused when it declined to invent a third status
  vocabulary. The intent layer in `lib/statusBadge.ts` is what keeps the eventual rename cheap.
- **Finish the button migration.** #366 took 57 of 182 sites — the shared component family, the
  Knowledge tab and TeamworkSection's `chip`; #389 took `RepoTab`'s four. Still hand-written:
  `AgentDetail`, `RunDetail`, `InstanceDetail`, `Profile`, `BoardTab`, `SettingsTab`, `StatsTab`,
  `TmuxTab`, `DataTab`, `TriggersSection`, `LoopPresetsSection`, and all of `store/admin` and
  `agents/coder/web`. Those files do not get `BUTTON_SIZE`'s 24px floor until they migrate — the
  e2e guard is what holds them meanwhile, and only on the 11 routes it visits. The ratchet in §5
  holds each tree where it stands.
- **A `text-2xs` audit, one screen at a time.** The scale sweep was mechanical by design (nearest
  step, ties up), so 173 sites landed on the 11px floor by arithmetic rather than by anyone deciding
  the text there is telemetry. Some of it is not: `text-2xs` under a form control on the Settings
  tab is descriptive copy and belongs at `text-xs`. That is a judgement call per screen, it is
  exactly the kind of thing §5's last paragraph says a lint must not pretend to check, and it is now
  cheap — moving a step is one class, not a decision about what number to invent.
- **`tap-target` is applied to three controls, not to a class of them.** The chat Copy, Delete-turn
  and replay buttons have it; the Coder UI's own icon controls, the Board's, and the coding
  session's do not. Applying it wholesale is not safe — the overlap arithmetic in its comment is
  per-layout — so widening it means measuring each dense row, which nothing here does yet.
- **The Behaviour tab and Terminals are the routes #389 and #390 measured worst and the routes both
  guards see least.** Neither has a fixture rich enough to render its controls, so both were fixed
  by rule (the base-layer checkbox size, the type sweep) and neither is *held* by anything. A
  fixture for them is the cheapest next increment on both tickets.
- Decide whether the marketing pages adopt the SPA palette or keep their own (§4).
- Clear `store/admin`'s two pinned dead utilities (§5) and drop its pin to zero.
