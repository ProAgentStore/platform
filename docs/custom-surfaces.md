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
        "bundleUrl": "https://cdn.example.com/my-agent/surface.js" }
    ]
  }
}
```

`bundleUrl` **must be https**. The console deep-links it at
`/instances/<id>/<surface-id>`.

## Framework

You own a plain DOM subtree, so use vanilla JS, or bundle your own React/Vue/Svelte
*inside* your bundle (it won't conflict with the console's React). Keep bundles small
and import the platform SDK from `ctx.sdk` rather than shipping your own client.

## Security note

Today a surface bundle runs in the console origin with the user's session (via
`ctx.sdk.api`). That's appropriate for first-party and trusted creators. Untrusted
third-party bundles should be isolated in a sandboxed iframe — that hardening is
tracked separately. Bundle URLs come only from an agent's validated capabilities
(https-only), never from arbitrary user input.
