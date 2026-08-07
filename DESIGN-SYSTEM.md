# PAGS Design System

ProAgentStore runs its own design system. The shared six-store
`~/dev/stores/DESIGN-SYSTEM.md` records PAGS as out of scope (§0, decided 2026-08-07) and points
here.

This document is **descriptive**. Every number below was measured from the tree on 2026-08-07, not
proposed. Where the console contradicts itself, that is written down as a contradiction rather than
quietly resolved in prose — a design system that describes an app nobody built is the failure mode
this document exists to avoid (#367).

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
  removing it. The answer here is the component layer (#366), not a `.btn` class.

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

## 2. Type

| Size | Uses | Where |
|---|---|---|
| `text-xs` | 427 | The console's real body size — dense tables, labels, chips |
| `text-sm` | 348 | Chat messages, form fields, primary reading text |
| `text-base` | 53 | Section headings |
| `text-xl` / `text-lg` | 14 / 12 | Page titles |
| `text-2xl` / `text-3xl` | 3 / 1 | Sign-in, empty states |
| **arbitrary `text-[…rem]`** | **174 uses across 17 distinct values** | everywhere |

The arbitrary sizes are the largest single divergence from any scale: `0.55 · 0.6 · 0.62 · 0.65 ·
0.66 · 0.68 · 0.7 · 0.72 · 0.74 · 0.75 · 0.76 · 0.78 · 0.8 · 0.82 · 0.875 · 0.95 · 1.1rem`. Several
are indistinguishable from each other on screen (0.65 / 0.66 / 0.68), which is the tell that they
were chosen individually rather than from a scale. The effective type scale is ~24 sizes.

This is real drift, and it is **not** worth a lint yet: 174 call sites with nowhere to go is 174
blocked edits. It needs #366's primitives (a `Badge`, a `Label`) to absorb the small ones first.

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

Mobile: form controls are forced to `font-size: 16px; min-height: 44px` below 640px (`index.css`).
Both numbers are deliberate — 16px is the threshold below which iOS Safari zooms the viewport on
focus, 44px is Apple's minimum touch target. Do not "tidy" them.

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

Two guards, each holding only what a machine can honestly hold.

**`scripts/check-design-tokens.mjs`** — a CI step (`ci.yml`, alongside the other `check-*.mjs` guards),
because it covers three trees rather than belonging to one package. **No colour utility may name a token
nothing declares** (§1). A gate at zero for `store/console` and `agents/coder/web`; `store/admin` is
pinned at 2, since fixing those needed a tree that had uncommitted maintainer work when this landed —
pinned rather than excluded, so the debt is visible and may only go down. The mechanism is a pure module
(`scripts/lib/design-tokens.mjs`) with its own tests, which is also the first test coverage any guard
under `scripts/` has had.

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

**Not enforceable, and honest to say so:** spacing rhythm, whether a given control should be a button
or a link, information density, when a surface is `panel` versus `paper`, icon choice, and whether
`/10` or `/15` is the right tint. These are judgement, and a lint that pretended to check them would
only teach people to suppress it.

**Deliberately not enforced yet:** the type scale (see §2 — needs #366 first) and the marketing-vs-SPA
palette split (§4 — resolving it is a restyling decision about the marketing pages, not a lint).

## 6. Open

- **Rename the pigment tokens to intent, and add the `-soft` pairings** (§1). Still the right change and
  deliberately not taken in #367's sweep, for two reasons worth recording. It cannot be done in the
  console alone: the `@theme` blocks are held equal by test (§5.3) and the second copy lives in
  `store/admin`, so the rename is one commit across both trees or it is a broken guard. And adding
  `--color-danger` as an *alias* beside `--color-red` without migrating ~200 call sites would leave two
  names for one idea — the failure #368 explicitly refused when it declined to invent a third status
  vocabulary. The intent layer in `lib/statusBadge.ts` is what keeps the eventual rename cheap.
- Collapse the 17 arbitrary type sizes into a scale, after #366 (§2). Measured rendered, 2026-08-08
  (#390): **148 sub-12px strings on Terminals**, 100 on Activity, and 9.9px body copy under form
  controls on the instance Settings tab — nine of the values sit inside a 2px band.
- **Decide whether this document may become prescriptive, and about what.** It is descriptive by
  design, and the two floors an audit keeps asking for — a minimum tap target (#389: 40 controls
  under 40px on the Assistant screen, 12×12px checkboxes on Behaviour, a 16px *Remove* on Repo) and
  a minimum readable font size (#390) — cannot be recorded here without changing that. Both belong
  in the component layer (#366) rather than at 291 + 168 call sites, so the sequencing is #367 →
  #366 → adopt; the open question is only whether the numbers live *here* once they exist.
- Decide whether the marketing pages adopt the SPA palette or keep their own (§4).
- Clear `store/admin`'s two pinned dead utilities (§5) and drop its pin to zero.
