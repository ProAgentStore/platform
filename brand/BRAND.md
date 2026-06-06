# ProAgentStore Brand Guidelines

## Mission

ProAgentStore is a marketplace for server-powered AI agents. Creators build agent templates — identity, knowledge base, guardrails, tools. Clients subscribe and run them on their own documents and data. Every agent runs on Cloudflare's edge with Workers AI, Durable Objects, D1, and R2.

## Platform Rules

1. **Marketplace model.** Creators build and publish. Clients subscribe and customize with their data.
2. **Data isolation.** Clients never see the creator's config. Creators never see client data.
3. **Server-powered.** Every agent needs something the browser can't do: cron, databases, large models, webhooks, multi-user state.
4. **Three types.** Agents (conversation + tools), Workers (scheduled tasks), Tools (stateless endpoints).
5. **Open platform.** SDK, CLI, MCP server, and API are open source. Agents can be open source or proprietary.

## Logo

### Wordmark

- **ProAgentStore** — one word, PascalCase, "Agent" highlighted in accent purple
- Font: Fraunces 700
- Icon: ⚡ lightning bolt in gradient circle

### Usage

```
Pro[Agent]Store    — accent purple (#7c3aed → #a78bfa)
```

- Always one word, PascalCase
- Never "Pro Agent Store" (three words)
- Never all-caps "PROAGENTSTORE"
- Internal shorthand: **PAGS**

### Brand Mark

```
Gradient circle (135deg, #7c3aed → #6366f1)
⚡ lightning bolt centered, white
Border radius: 10px (nav), 14px (hero), 50% (avatar contexts)
```

Sizes: 16, 32, 48, 64, 128, 180, 192, 512px

## Colors

### Platform Colors

| Token | Value | Usage |
|-------|-------|-------|
| `--accent` | `#7c3aed` | Primary actions, links, agent card hover, buttons |
| `--accent-hover` | `#6d28d9` | Button hover state |
| `--accent-soft` | `rgba(124,58,237,0.15)` | Tag backgrounds, subtle highlights |
| `--free` | `#3b82f6` | Links to FreeAgentStore (free pair) |
| `--paper` | `#0a0a0a` | Page background |
| `--panel` | `#171717` | Card/panel backgrounds |
| `--ink` | `#fafafa` | Primary text |
| `--muted` | `#a3a3a3` | Secondary text |
| `--muted-soft` | `#737373` | Tertiary text |
| `--line` | `#262626` | Borders, dividers |
| `--line-strong` | `#404040` | Hover borders |
| `--green` | `#22c55e` | Success, published status |
| `--red` | `#ef4444` | Error, admin badge, delete actions |
| `--yellow` | `#eab308` | Warning, draft status, pending |
| `--blue` | `#3b82f6` | Info, in-progress, free pair links |

### Agent Icon Colors

Each flagship agent has a unique icon background color:

| Agent | Color | Rationale |
|-------|-------|-----------|
| Site Monitor | `#22c55e` | Green — monitoring, health |
| Lead Qualifier | `#3b82f6` | Blue — business, pipeline |
| Content Pipeline | `#a855f7` | Purple — creative, generation |
| Competitor Intel | `#f59e0b` | Amber — intelligence, alert |
| Support Escalator | `#ef4444` | Red — urgency, support |

### Theme

Dark theme only. No light mode. This differentiates from FreeAgentStore (which has both).

## Typography

### Fonts

| Role | Family | Weight | Usage |
|------|--------|--------|-------|
| Body | **Manrope** | 400, 500, 600, 700 | All UI text, labels, body copy |
| Display | **Fraunces** | 400, 700 | Headlines, page titles, brand name |

Load from Google Fonts:
```html
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,700&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet">
```

### Scale

```css
--text-xs: 0.68rem    /* Tags, badges */
--text-sm: 0.82rem    /* Secondary text, descriptions */
--text-base: 0.88rem  /* Body text, nav links */
--text-lg: 1.15rem    /* Brand name */
--text-xl: 1.4rem     /* Section titles */
--text-2xl: 2.25rem   /* Hero headline */
```

## Spacing & Layout

```css
--radius: 0.75rem     /* Cards, buttons, inputs */
--radius-lg: 14px     /* Hero icon, agent cards */
--radius-full: 999px  /* Pills, tags, avatars */

Max width: 960px (content), 1100px (agent grid), 760px (prose/docs)
Padding: 1.5rem horizontal
```

## Components

### Agent Card
```
Background: --panel
Border: 1px solid --line
Border radius: 14px
Padding: 1rem 1.1rem
Hover: border-color → --line-strong, translateY(-1px), shadow-lg
Layout: flex row, icon + body + CTA button
```

### Button Styles
```
Primary: bg --accent, color white, border-radius --radius
Outline: border 1px --line, color --muted, hover border --accent
Danger: bg --red, color white
Small: font-size 0.8rem, padding 0.35rem 0.75rem
```

### Status Badges
```
Draft:       bg rgba(234,179,8,0.15), color --yellow
Published:   bg rgba(34,197,94,0.15), color --green
In Progress: bg rgba(59,130,246,0.15), color --blue
Complete:    bg rgba(34,197,94,0.15), color --green
Blocked:     bg rgba(239,68,68,0.15), color --red
```

### Role Badges
```
User:    bg rgba(59,130,246,0.15), color --blue
Creator: bg rgba(124,58,237,0.15), color #a78bfa
Admin:   bg rgba(239,68,68,0.15), color --red
```

## Voice & Tone

- **Direct.** No marketing fluff. Say what it does.
- **Technical.** Developers are the audience. Use technical terms correctly.
- **Concise.** If you can say it in one sentence, don't use three.
- **Confident.** "Server-powered AI agents" not "A platform that helps you build..."

### Naming Conventions

- Agent types: **Agent**, **Worker**, **Tool** (capitalized when referring to the type)
- Agent instances: lowercase slug, hyphens, no underscores (`lead-qualifier`, not `lead_qualifier`)
- Platform components: **Console**, **Store**, **API**, **SDK**, **CLI**, **MCP**

## Ecosystem Position

ProAgentStore is the **server-powered** pair of FreeAgentStore (browser-based).

| | FreeAgentStore | ProAgentStore |
|---|---|---|
| Runs on | User's device | Cloudflare edge |
| Cost | Free forever | Subscription |
| Privacy | Data never leaves device | Processed on CF edge |
| Models | WebGPU/WASM (2-3GB) | Workers AI (any size) |
| State | IndexedDB | D1 + R2 + DO |
| Accent | Purple (same) | Purple (same) |
| Theme | Dark + Light | Dark only |

### Cross-store Links

Every page footer includes the full ecosystem:
```
FreeAppStore · FreeGameStore · FreeWebStore · FreeAgentStore · ProAppStore · ProAgentStore
```

### Free Pair Link

Every nav bar includes a link to FreeAgentStore with class `free` (blue color).

## Assets

```
brand/assets/
├── favicon.svg          — SVG favicon (gradient circle + ⚡)
├── icon-16.png
├── icon-32.png
├── icon-48.png
├── icon-64.png
├── icon-128.png
├── icon-180.png         — Apple touch icon
├── icon-192.png         — PWA icon
├── icon-512.png         — PWA splash
└── og-image.png         — Open Graph / Twitter card (1200x630)
```
