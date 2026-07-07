# Custom surfaces (Phase 3) — ship your agent's own UI

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
itself (e.g. `/console/surfaces/*.js`, or an absolute `https://proagentstore.online/…`
URL). A cross-origin bundle is **refused by the console** (see Security note). The
console deep-links the surface at `/instances/<id>/<surface-id>`.

## Framework

You own a plain DOM subtree, so use vanilla JS, or bundle your own React/Vue/Svelte
*inside* your bundle (it won't conflict with the console's React). Keep bundles small
and import the platform SDK from `ctx.sdk` rather than shipping your own client.

## Security note

A surface bundle runs in the console origin with the user's session token (via
`ctx.sdk.getToken`/`api`), so a creator-hosted script would execute **as the viewing
user** (account / BYOK-key takeover). Because of that, `DynamicSurface` loads **only
same-origin bundles** — a cross-origin `bundleUrl` is refused before it is imported.
That is the current security boundary; fuller isolation in a sandboxed iframe (which
would allow trusted cross-origin bundles) is tracked separately. Until then, ship your
surface from the platform origin.
