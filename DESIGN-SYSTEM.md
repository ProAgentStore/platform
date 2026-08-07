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

`store/console/src/lib/designTokens.test.ts` runs in the normal unit suite. It holds three things,
each chosen because it is mechanical **and** corresponds to a defect that actually shipped:

1. **No pale Tailwind background** (`bg-*-50/100/200`) in either SPA — a gate, at zero. This is the
   exact signature of #368. Allowlisted: `pages/Login.tsx`, whose white Google button is
   brand-mandated and is a white button on every site that has one.
2. **Raw palette classes are pinned** at 33 (console) and 1 (admin) — a ratchet, not a gate, because
   the count is not zero. Pinned exactly, like the file-size ratchet: removing a use lowers the pin
   in the same commit, so the ground taken is not left as headroom.
3. **The console and admin `@theme` blocks are equal** — the admin file claims its tokens are "shared
   with the console"; they are shared by copy, so nothing was keeping the claim true.

**Not enforceable, and honest to say so:** spacing rhythm, whether a given control should be a button
or a link, information density, when a surface is `panel` versus `paper`, icon choice, and whether
`/10` or `/15` is the right tint. These are judgement, and a lint that pretended to check them would
only teach people to suppress it.

**Deliberately not enforced yet:** the type scale (see §2 — needs #366 first) and the marketing-vs-SPA
palette split (§4 — resolving it is a restyling decision about the marketing pages, not a lint).

## 6. Open

- Rename the pigment tokens to intent, and add the `-soft` pairings (§1).
- Collapse the 17 arbitrary type sizes into a scale, after #366 (§2).
- Decide whether the marketing pages adopt the SPA palette or keep their own (§4).
