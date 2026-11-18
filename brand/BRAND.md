# ProAgentStore brand

ProAgentStore is the server-powered member of the Agents pair. FreeAgentStore is
its browser-first counterpart. Use the full name **ProAgentStore**, written as
one word in PascalCase, on platform surfaces.

## Family identity — 2026-11-18

The canonical family kit is maintained in `serge-ivo/stores-workspace`, under
`brand/`. This repository vendors the ProAgentStore export in `brand/assets/`.
There is no cross-store runtime package or network dependency.

- Symbol: connected nodes, shared with FreeAgentStore. Use the supplied vector
  paths; do not recreate the platform mark with a lightning emoji, letter or
  icon-library glyph.
- Wordmark: Manrope 800, `ProAgentStore`, with **Agent** in the accent colour.
  Keep it on one line. Compact navigation may show only the symbol, provided its
  link has an accessible platform name.
- Primary accent: violet `#7c3aed`; hover `#6d28d9`; wordmark on dark surfaces:
  `#a78bfa`. FreeAgentStore uses indigo `#6366f1` / `#a5b4fc`.
- Body: Manrope. Editorial headings: Fraunces. Code: system monospace.
- Individual agents retain their own names and icons. The platform symbol does
  not replace agent-specific identities.

## Exported assets

`assets/` contains the SVG symbol, monochrome mark, light/dark wordmarks, favicon,
PNG sizes 16–512, Apple touch icon, social card and `brand.json`. Update the whole
export from one family-kit revision. Keep vector paths and supplied padding.

The host embeds the favicon, PNG icons and social image from this directory in
`workers/host/build.js`. The public URLs are `/favicon.svg`, `/icon-192.png`,
`/icon-512.png`, `/apple-touch-icon.png` and `/og-image.png`.
`store/manifest.json` defines the default installed-console shortcut.

## Theme and UI ownership

ProAgentStore deliberately remains dark-only. This decision is recorded in the
workspace design system and in this repository's `DESIGN-SYSTEM.md`. The family
kit has light and dark artwork variants for external use; it does not introduce
a light UI or a theme preference here.

`DESIGN-SYSTEM.md` and the console/admin token definitions own the UI contract.
Use semantic status colours rather than colour literals. The brand wordmark's
high-contrast dark-surface shade is `--color-brand-ink`; it is separate from the
primary action accent. Avoid duplicated historical token tables in brand docs.

## Delivery and verification

The storefront HTML, console and admin headers all use the same favicon artwork.
The host workflow watches `brand/**` as well as `store/**`, so an asset-only
change deploys. Build the SDK, console, admin and host pages and inspect
desktop/mobile branding. Required hooks check the changed surfaces before a
push to `main`; CI runs the full suite. Use the repository's `test:full` wrapper
for any local full-suite run and report its explicit verdict.

## Voice

Describe what the platform does plainly. Use **Agents**, **Workers** and **Tools**
for the three agent types, and **Console**, **API**, **SDK**, **CLI** and **MCP** for
platform components. Keep pricing, capabilities and privacy claims in the
product documentation that owns them rather than duplicating them here.
