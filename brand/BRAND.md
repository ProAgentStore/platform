# ProAgentStore brand

Kit version **2026-11-18**. Canonical source: [`serge-ivo/stores-workspace` `brand/`](https://github.com/serge-ivo/stores-workspace/tree/main/brand). This repo vendors the exact PAGS export in [`brand/assets/`](assets/).

## Identity

- **Name:** ProAgentStore, one PascalCase word. **Agent** is the coloured noun.
- **Symbol:** connected nodes, shared with FreeAgentStore. Use the supplied vector paths.
- **Wordmark:** Manrope 800, on one line.
- **Colours:** accent violet `#7c3aed`, hover `#6d28d9`, dark-surface accent `#a78bfa`. FreeAgentStore uses
  indigo `#6366f1` / `#a5b4fc`.
- **Typography:** Manrope for UI, Fraunces for editorial headings, system monospace for code.

## Assets

| File | Use |
|---|---|
| `favicon.svg` | Standalone icon; the header image on every page |
| `mark.svg` / `mark-mono.svg` | Transparent glyph, in colour or `currentColor` |
| `wordmark-light.svg` / `wordmark-dark.svg` | Complete outlined wordmark for light or dark surfaces |
| `icon-{16,32,48,64,128,180,192,512}.png` | Raster icons; 192 and 512 are the manifest icons |
| `apple-touch-icon.png` | iOS home-screen icon |
| `og-image.svg` / `og-image.png` | 1200×630 share card |
| `brand.json` | Kit version and colour/identity provenance |

## Usage rules

- Header: a 28–40px icon beside the accessible full name. No second container or gradient behind the icon.
- A decorative image beside the name uses `alt=""`. A symbol-only link needs the full name as its accessible label.
- The 192px and 512px PNGs are opaque and maskable. Do not use them as a square header badge.
- Never redraw, abbreviate or space the name. Do not stand in for the mark with a lightning emoji, a letter or
  an icon-library glyph.
- Individual agents keep their own names and icons. The platform symbol does not replace them.

## Where it ships

The host Worker embeds its copies from `brand/assets/` at build time (`workers/host/build.js`); there is no second
copy in this repo. Brand URLs carry the cache parameter `?v=2026-11-18`.

- Host routes: `/favicon.svg`, `/icon-192.png`, `/icon-512.png`, `/apple-touch-icon.png`, `/og-image.png`.
- Storefront pages, `store/**/*.html`: favicon, touch icon, share image and the header image plus wordmark.
- Console and admin headers: `store/console/src/components/Layout.tsx`, `store/admin/src/components/Layout.tsx`.
- Installed app: `store/manifest.json` (192 and 512 icons).
- Embeddable chat widget: `store/widget.js` inlines the `mark-mono.svg` paths as its button.

## Store-specific notes

**Dark only.** ProAgentStore deliberately has no light UI and no theme preference. The decision is recorded in the
workspace design system and in this repo's `DESIGN-SYSTEM.md`. The kit's light and dark artwork is for external
use. `DESIGN-SYSTEM.md` and the console/admin token definitions own the UI contract: use semantic status colours,
not colour literals. The wordmark's dark-surface shade is the token `--color-brand-ink`, separate from the primary
action accent.

**Delivery and verification.** `deploy-host.yml` watches `brand/**` as well as `store/**`, so an asset-only change
deploys. Build the SDK, console, admin and host pages and inspect the branding at desktop and mobile widths. The
hooks check the changed surfaces before a push to `main`; CI runs the full suite. For a local full-suite run use
`pnpm -w test:full` and report its verdict line.

**Voice.** Describe what the platform does plainly. Use **Agents**, **Workers** and **Tools** for the three agent
types, and **Console**, **API**, **SDK**, **CLI** and **MCP** for platform components. Pricing, capability and
privacy claims stay in the product documentation that owns them.

## Updating

1. Change the master in the workspace kit and regenerate it there.
2. Copy the whole PAGS export into `brand/assets/` from one kit revision; keep vector paths and padding.
3. Update the inlined mark in `store/widget.js` if `mark-mono.svg` changed.
4. Bump `?v=` on every brand URL, including `store/manifest.json`, so returning browsers fetch the new files.
5. Run `python3 brand/check-copies.py` in the workspace.
6. Commit to `main` here; the host deploys from the push.
