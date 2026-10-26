# AppShell navigation contract

**For coding agents, templates and skills. Machine-readable twin: [`appshell-navigation-contract.json`](./appshell-navigation-contract.json).**

An app built on the shell has **one** primary navigation, rendered by the shell, with a responsive menu that works on a phone.
An agent can satisfy the superficial check "uses the shell" and still defeat that menu by rendering its own navbar or by passing an
empty list. This contract says what to do instead.

> **Provenance and scope.** This documents the ProAppStore SDK shell (`proappstore-online/platform`: `packages/sdk/src/shell.tsx`
> and `navbar.tsx`), read on 2026-10-26. The shell is **not in this repository**. This file is the contract text; referencing it
> from the template-app and the SDK README/API docs has to be done in that repository (see *Open items*).

## Terminology

Say **AppShell** in prose: it is the concept — the component that owns the app's frame, sign-in gate and primary navigation.
In code, import whatever the installed SDK exports. Today that is **`ProShell`** from `@proappstore/sdk/shell`; there is no
`AppShell` export. If `AppShell` is added, `ProShell` stays as a temporary alias, so do not rename imports speculatively.

## The seven rules

### 1. AppShell owns one primary app navigation
An app has exactly one primary navigation and the shell renders it. A second navbar defeats the responsive menu and gives
assistive technology two competing landmarks.

### 2. Every primary destination is in nav or renderNav
Put every primary destination in the `nav` prop (`{ label, href, icon?, title? }`, with `href` a same-origin path), or in a
`renderNav` replacement that renders the same destinations. `<ProShell nav={NAV}>` with an empty or landing-only `NAV` passes a
superficial check and leaves the user with no navigation.

### 3. Do not render a second primary navbar in shell content
Content headers, sidebars and tab bars must not repeat the primary destinations. `hideTopbar` also hides the navigation; a custom
`renderTopbar` receives `ctx.nav` and **must place it**.

### 4. Use onNavigate for SPA apps
A router-driven app passes its router's navigate function as `onNavigate`. Without it nav items are ordinary links and every click
reloads the document, discarding client state.

### 5. Preserve tenant and workspace scope in links
Keep the scope **in the path** (`/w/acme/cases`). The shell marks the current item by comparing each `href` with
`location.pathname` (exact match, else the longest prefix), so an `href` with a query string such as `/cases?w=acme` is never
marked current and gets no `aria-current`. If scope must live in a query string, render the navigation with `renderNav` and compute
the active item yourself.

### 6. Test the menu at a mobile viewport
Run a browser test against the **real** shell at 375px — not a mock. The built-in menu is a `<nav aria-label="Main">` with a button
labelled **Menu** (`aria-expanded`), `aria-current="page"` on the current item, and Escape or a click outside closes it. Check:
the button exists below 640px; opening it lists every destination; Escape and outside click close it; selecting an item updates
`aria-current`; the document does not reload; only one navigation landmark is exposed. A worked Playwright version of exactly
these checks, for this repository's own console shell, is [`e2e/appshell-mobile.spec.ts`](../e2e/appshell-mobile.spec.ts); see
also *Navigation: when the shell may be mocked* in [testing-standards.md](./testing-standards.md).

### 7. Know which navigation is outside this rule
These are **not** primary navigation and may sit beside it: tabs within one screen, breadcrumbs, a local admin sub-navigation,
footer links, in-content links, and the profile menu (`menuItems`). The rule is about the app's primary destinations, not every
link on the page.

## Starter checklist

- [ ] The app renders the shell once and passes its destinations as `nav` or `renderNav`.
- [ ] `nav` lists every primary destination, not only the landing route.
- [ ] No other component renders the app's primary destinations.
- [ ] A router-driven app passes `onNavigate`.
- [ ] Links keep tenant or workspace scope in the path.
- [ ] Role-based items are hidden for presentation only; the server enforces access.
- [ ] A mobile (375px) browser test runs against the real shell and checks the menu.

## React Router example

```tsx
import { BrowserRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { initPro } from '@proappstore/sdk';
import { ProShell, type NavItem } from '@proappstore/sdk/shell';

const app = initPro({ appId: 'cases' });

// Every primary destination, not just the landing route.
const NAV: NavItem[] = [
  { label: 'Home', href: '/' },
  { label: 'Cases', href: '/cases' },
  { label: 'Reports', href: '/reports' },
];

function Shell() {
  const navigate = useNavigate();
  return (
    <ProShell app={app} appName="Cases" branding="app" nav={NAV} onNavigate={navigate}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/cases/*" element={<Cases />} />
        <Route path="/reports" element={<Reports />} />
      </Routes>
    </ProShell>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  );
}
```

`onNavigate` is called with the clicked item's `href`. As read in `navbar.tsx`, the shell updates its current-route marker from its
own nav clicks and from `popstate`; a `navigate()` call made from page content may not move `aria-current`. Verify this with the
mobile test (rule 6) rather than assuming. A first-class router adapter is tracked separately (#1289) and does not exist yet.

## Role-aware and scoped-link example

```tsx
import { useMemo } from 'react';
import type { NavItem } from '@proappstore/sdk/shell';

type Role = 'owner' | 'member' | 'viewer';

// Scope lives in the PATH, so the shell can match it against location.pathname and mark the current item.
export function useNav(workspace: string, role: Role): NavItem[] {
  return useMemo(() => {
    const base = `/w/${encodeURIComponent(workspace)}`;
    const items: NavItem[] = [
      { label: 'Cases', href: `${base}/cases` },
      { label: 'Reports', href: `${base}/reports` },
    ];
    // Presentation only: hiding a link is not access control. The server must refuse a viewer's request to /settings.
    if (role === 'owner') items.push({ label: 'Settings', href: `${base}/settings` });
    return items;
  }, [workspace, role]);
}

// <ProShell app={app} appName="Cases" nav={useNav(workspace, role)} onNavigate={navigate}>…</ProShell>
```

## Open items

This contract is published here, in `ProAgentStore/platform`, because that is where the issue was filed. Its acceptance asks for
more than a document:

- referenced from the **template-app** and the **SDK README/API docs** — both are in `proappstore-online/platform`;
- referenced from the PAS platform AI guidance (the MCP server's SDK reference and platform skill) — same repository;
- a router adapter so rule 4 needs no hand-written glue (#1289), and a compliance check that enforces rules 1–3 (#1293).

Those remain to be done in that repository. The only reference added here is from [AGENTS.md](../AGENTS.md).
