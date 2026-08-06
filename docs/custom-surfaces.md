# Custom surfaces (Phase 3) — ship your agent's own UI

> **STATUS: DISABLED IN PRODUCTION (issue #186).** Custom surfaces are fail-closed behind the
> API's `CUSTOM_SURFACES_ENABLED` flag, which is **not set** on the deployed platform. With the
> flag off, `PUT /v1/agents/:id/capabilities` refuses a `customSurfaces` payload (400) and
> resolved capabilities carry none, so the console renders no third-party bundle. Everything
> below describes the contract as designed, and is what you get by setting the flag locally.
>
> **Why it is off.** Two reasons, and the second is the decisive one:
>
> 1. *It cannot work anyway.* A bundle must be same-origin, but the platform serves no
>    same-origin JS for surfaces: `workers/host` answers every `/console/*` path with the console
>    HTML shell, and its `build.js` never embeds `store/console/public/surfaces/*`. A production
>    bundle URL returns `text/html` and the dynamic `import()` dies on MIME.
>    `public/surfaces/notes.js` works under Vite dev only.
> 2. *The isolation model is unfinished.* A bundle runs **in the console origin with the viewer's
>    session token**. The only thing making that survivable is "the platform serves the bundle" —
>    which means a *creator*-authored surface was never actually possible. Delivering the feature
>    as advertised needs the sandboxed-iframe boundary, not bundle hosting.
>
> A clearly disabled feature is safer than a half-validated one, so the switch stays off until
> that boundary lands. Nothing declares a custom surface today (no migration, seed or template),
> so turning it off removed no working behaviour.

The console renders an agent's UI from a **surface registry**. First-party surfaces
(Chat, Coding, Apply, Board, Knowledge, Settings) are built in. **Custom surfaces**
let an agent ship its *own* UI, loaded dynamically from a published bundle — no
change to the console.

## How it works

1. Your agent declares a custom surface in its `config.capabilities.customSurfaces`.
2. When a subscriber opens an instance of your agent, the console adds a tab for it
   and loads your **bundle** (an ESM module) from `bundleUrl`.
3. Your bundle's `mount(ctx)` renders into a `<div>` the console owns. The platform
   injects an **SDK** (authenticated API client + helpers) via `ctx.sdk`, so you
   never bundle the client or handle auth yourself.

## The contract

Your bundle is an ESM module exporting `mount`:

```js
// my-surface.js  (an ESM module served over https)
export function mount(ctx) {
  const { el, instanceId, sessionId, sdk } = ctx;

  el.innerHTML = `<div style="padding:1rem">Loading your stuff…</div>`;

  (async () => {
    // ctx.sdk.api is the SAME authenticated client the console uses — it sends the
    // user's session automatically. Scope your calls to this instance.
    const data = await sdk.api(`/v1/instances/${instanceId}/collections/things/records`);
    el.innerHTML = `<ul>${(data.records || [])
      .map((r) => `<li>${sdk.esc(r.data?.title ?? "")}</li>`)
      .join("")}</ul>`;
  })();

  // Optional: return a cleanup function. The console calls it on unmount and
  // clears the element for you.
  return () => { /* cancel timers, listeners, etc. */ };
}
```

### `ctx` shape

| field        | what it is                                                            |
|--------------|-----------------------------------------------------------------------|
| `el`         | the `HTMLElement` to render into (you own its contents)               |
| `instanceId` | the current instance id — scope your API calls to it                  |
| `sessionId`  | optional deep-link segment (e.g. a selected record)                   |
| `sdk.api`    | authenticated fetch: `api(path, opts?) => Promise<json>`              |
| `sdk.getToken` / `sdk.apiBase` | session token + API base, if you need raw fetch     |
| `sdk.renderMd` / `sdk.mdLite` / `sdk.esc` / `sdk.escAttr` / `sdk.formatTime` | safe rendering helpers |

`sdk.renderMd`/`mdLite`/`esc` HTML-escape their input — **always** escape any
agent/LLM/user text before inserting it as HTML.

## Declaring it

In your agent's `config`:

```json
{
  "capabilities": {
    "surfaces": [],
    "customSurfaces": [
      { "id": "dashboard", "label": "Dashboard", "icon": "📊",
        "bundleUrl": "/console/surfaces/my-agent-dashboard.js" }
    ]
  }
}
```

`bundleUrl` **must be same-origin** — the bundle has to be served from the platform
itself. Exactly two forms are accepted, and the rule is enforced **server-side** by
`isAllowedBundleUrl` (`workers/api/src/lib/origins.ts`) as well as in the console:

- a **root-relative** path — `/console/surfaces/my-agent-dashboard.js`
- an absolute `https://` URL on a platform host — `https://proagentstore.online/…`,
  `https://<sub>.proagentstore.online/…`

Everything else is refused, including a bare relative specifier (`notes.js`), plain http,
`javascript:`/`data:`, any other host, and the same-origin-looking forms `//evil.example/x.js`
and `/\evil.example/x.js` (both resolve to a foreign origin). The console deep-links the surface
at `/instances/<id>/<surface-id>`.

`id` must match `^[a-z][a-z0-9-]{0,31}$`, must not collide with a built-in tab id
(`settings`, `chat`, `board`, `coding`, `tmux`, `knowledge`, `apply`, …), and at most
8 surfaces are kept per agent.

## Framework

You own a plain DOM subtree, so use vanilla JS, or bundle your own React/Vue/Svelte
*inside* your bundle (it won't conflict with the console's React). Keep bundles small
and import the platform SDK from `ctx.sdk` rather than shipping your own client.

**Keep all state inside `mount()`.** `import()` caches by URL, so a module-level variable in your
bundle survives across *different instances of the same agent* within one page session — the
second instance would see the first one's data. The platform deliberately does not cache-bust the
URL (that would leak a fresh module copy on every mount instead).

## Security note

A surface bundle runs in the console origin with the user's session token (via
`ctx.sdk.getToken`/`api`), so a creator-hosted script would execute **as the viewing
user** (account / BYOK-key takeover).

Three layers stand between a declaration and that outcome, listed in the order they apply:

1. **The feature gate** — `CUSTOM_SURFACES_ENABLED` (unset in production). Off ⇒ a declaration
   is refused at write time and resolved capabilities carry no surfaces at all.
2. **Server-side origin enforcement** — `isAllowedBundleUrl`, applied by *both* the write route
   and the capability resolver. This matters because the console is not the only possible
   consumer: a mobile shell, an SSR/preview renderer or an admin preview that mounted a bundle
   without re-implementing a client check would otherwise inherit the whole hole.
3. **The console's own same-origin check** (`DynamicSurface`), now defence-in-depth. Note it
   tests the URL *string*, not the response, so a same-origin URL that 302'd cross-origin would
   still import — unreachable today, but one open redirect away from void.

None of that is *isolation*: a same-origin bundle still holds the session. Fuller isolation in a
sandboxed iframe (which would also allow trusted cross-origin bundles) is the work that has to
land before this feature can be switched on for creators.
