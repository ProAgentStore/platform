> **Historical planning doc — superseded; see the internal KB `docs/stores/pags.md` for the shipped state.**

# Console Rewrite: React + TypeScript + Tailwind

## Current State

17 plain JS files (6,669 lines), 1 CSS file (519 lines), 1 HTML file.
All global scope, no framework, raw DOM manipulation, implicit load-order dependencies.

## Target State

React + TypeScript + Tailwind SPA, built with Vite, served as a single bundle by the host worker.

## Tech Stack

- **React 19** + **TypeScript** (`.tsx`)
- **Tailwind CSS v4** (utility classes, no custom CSS file)
- **Vite** (dev server + production build)
- **React Router** (client-side routing for /console/*)
- Output: one `bundle.js` + one `bundle.css` → host worker serves them

## Project Structure

```
store/console/
├── src/
│   ├── main.tsx                 # Entry point, React root
│   ├── App.tsx                  # Router + auth gate
│   ├── lib/
│   │   ├── api.ts               # fetch wrapper (from console-core.js api())
│   │   ├── auth.ts              # token management, sign-in/out
│   │   ├── types.ts             # shared types (Instance, Agent, Repo, Session, etc.)
│   │   ├── voice-stt.ts         # VoiceStt class (from console-voice-stt.js)
│   │   ├── voice-tts.ts         # VoiceTts class (from console-voice-tts.js)
│   │   └── voice-config.ts      # getVoiceConfig, createTts, createStt
│   ├── hooks/
│   │   ├── useApi.ts            # fetch + loading + error state
│   │   ├── useInstance.ts       # current instance context
│   │   ├── useRuntime.ts        # runtime status polling
│   │   ├── useVoice.ts          # STT/TTS state + conversation mode
│   │   └── usePolling.ts        # interval-based data refresh
│   ├── components/
│   │   ├── Layout.tsx           # Header, nav, hamburger menu
│   │   ├── Badge.tsx            # Runtime status badge (● node name)
│   │   ├── ChatInput.tsx        # Input bar + 🎤 🔊 🎙️ Send ⧉ 🗑
│   │   ├── ChatMessages.tsx     # Message list (scrollable)
│   │   ├── ChatBubble.tsx       # Single message (user/assistant/system)
│   │   ├── Markdown.tsx         # Render markdown in assistant messages
│   │   ├── Dialog.tsx           # Reusable dialog/sheet (replaces coding-dialog-backdrop)
│   │   ├── KanbanBoard.tsx      # Task kanban (shared by apply + insurance + any agent)
│   │   ├── KanbanCard.tsx       # Single task card
│   │   └── EmptyState.tsx       # "No X yet" placeholders
│   ├── pages/
│   │   ├── Login.tsx
│   │   ├── Dashboard.tsx        # Agents / Instances / Stats tabs
│   │   ├── AgentDetail.tsx      # Agent CRUD, versions, export
│   │   ├── InstanceDetail.tsx   # Tab container (chat/board/coding/kb/settings)
│   │   ├── Profile.tsx          # Profile, API keys, notifications pref
│   │   └── Notifications.tsx
│   ├── tabs/                    # Instance tab content
│   │   ├── ChatTab.tsx          # Agent chat + voice
│   │   ├── BoardTab.tsx         # Runtime task board
│   │   ├── CodingTab.tsx        # Repos + sessions container
│   │   ├── KnowledgeTab.tsx     # Docs, memory, files, credentials, rules
│   │   └── SettingsTab.tsx      # Board maintenance, runner info, links
│   ├── coding/                  # Coding-specific components
│   │   ├── Overseer.tsx         # Cross-repo agent input
│   │   ├── RepoList.tsx         # Repo rows with status
│   │   ├── RepoRow.tsx          # Single repo (status, buttons, voice)
│   │   ├── SessionView.tsx      # Terminal + co-pilot container
│   │   ├── Terminal.tsx         # Raw terminal pane
│   │   ├── CoPilot.tsx         # Agent chat view (summary thread)
│   │   ├── AddRepo.tsx          # Add repo form
│   │   ├── EnginesPanel.tsx     # CLI engine presets editor
│   │   ├── DiagnosticsPanel.tsx # System status dialog (🩺)
│   │   ├── HandsOff.tsx         # Hands-off voice panel (🎙️ on repos)
│   │   └── SessionMenu.tsx      # ⚙ session actions dialog
│   ├── apply/                   # Apply-specific components
│   │   ├── ApplyPanel.tsx       # Apply URL + checklist
│   │   ├── ResumeUpload.tsx
│   │   └── AtsTips.tsx
│   └── dialogs/
│       ├── TakeoverDialog.tsx   # Human takeover (live browser frame)
│       ├── RunnerGuide.tsx      # Setup help overlay
│       └── RunnerInfo.tsx       # Runner info popover
├── index.html                   # Vite entry HTML
├── tailwind.config.ts
├── tsconfig.json
├── vite.config.ts
└── package.json
```

## Migration Plan

### Phase 1: Scaffold + build pipeline (30 min)

1. `pnpm create vite store/console --template react-ts`
2. Add Tailwind, configure
3. Create `src/lib/api.ts` (extract from console-core.js)
4. Create `src/lib/types.ts` (Instance, Agent, Repo, Session, VoiceSettings, etc.)
5. Create `src/lib/auth.ts` (token, sign-in, sign-out)
6. Update `workers/host/build.js` to read Vite output instead of 17 files
7. Verify: empty React app loads in the console

### Phase 2: Layout + routing + auth (30 min)

1. `App.tsx` — React Router, auth gate
2. `Layout.tsx` — header bar, nav tabs, hamburger, avatar, badge
3. Routes: /console/agents, /instances, /dashboard, /profile, /notifications
4. Login.tsx — OAuth redirect flow
5. Verify: can sign in, see empty dashboard

### Phase 3: Dashboard pages (30 min)

1. Dashboard.tsx — agents grid, instances list, stats
2. AgentDetail.tsx — agent info, CRUD
3. Verify: can browse agents, see instances

### Phase 4: Instance detail shell (30 min)

1. InstanceDetail.tsx — tab container with routing
2. Tab switching (chat/board/coding/knowledge/settings)
3. Badge.tsx — runtime status with popover
4. Verify: can open an instance, see tabs, badge shows status

### Phase 5: Chat tab (45 min)

1. ChatTab.tsx — messages + input
2. ChatMessages.tsx + ChatBubble.tsx — render message history
3. ChatInput.tsx — input + Send + voice buttons
4. Markdown.tsx — render assistant messages
5. `useApi` hook for send/receive
6. Verify: can chat with the agent, messages render correctly

### Phase 6: Voice (30 min)

1. Port VoiceStt + VoiceTts classes to TypeScript (`src/lib/`)
2. `useVoice` hook — STT/TTS state, conversation mode
3. Wire 🎤 🔊 🎙️ buttons to the hook
4. Verify: push-to-talk, auto-speak, conversation mode all work

### Phase 7: Board tab (30 min)

1. BoardTab.tsx — kanban layout
2. KanbanBoard.tsx + KanbanCard.tsx
3. Task detail view
4. Verify: tasks render, can approve/cancel, detail view works

### Phase 8: Coding tab (1 hour)

1. CodingTab.tsx — container
2. Overseer.tsx — cross-repo input
3. RepoList.tsx + RepoRow.tsx — status, deploy badges, voice
4. SessionView.tsx — Terminal + CoPilot toggle
5. Terminal.tsx — raw pane, ANSI colors
6. CoPilot.tsx — summary thread + voice
7. AddRepo.tsx, SessionMenu.tsx
8. Status polling (usePolling hook)
9. Verify: repos show, sessions open, terminal works, co-pilot works

### Phase 9: Knowledge + Settings tabs (30 min)

1. KnowledgeTab.tsx — docs, memory, files, credentials, rules sub-tabs
2. SettingsTab.tsx — board maintenance, runner info, danger zone
3. Verify: can manage knowledge, see settings

### Phase 10: Dialogs + remaining (30 min)

1. DiagnosticsPanel.tsx (🩺)
2. EnginesPanel.tsx (⚙)
3. HandsOff.tsx (🎙️)
4. TakeoverDialog.tsx
5. RunnerGuide.tsx + RunnerInfo.tsx
6. Profile.tsx + Notifications.tsx

### Phase 11: Polish + delete old code (30 min)

1. Delete all 17 old .js files
2. Delete console.css
3. Update host worker build.js for Vite output
4. Mobile responsive (Tailwind breakpoints)
5. Touch targets (min-h-11 = 44px)
6. Full test pass

## Tailwind Theme (matches current design)

```js
// tailwind.config.ts
export default {
  theme: {
    extend: {
      colors: {
        paper: '#0a0a0a',
        panel: '#141414',
        ink: '#fafafa',
        muted: '#a3a3a3',
        accent: '#7c3aed',
        line: '#262626',
      },
      fontFamily: {
        body: ['Manrope', 'system-ui', 'sans-serif'],
        display: ['Fraunces', 'Georgia', 'serif'],
        mono: ['SF Mono', 'ui-monospace', 'Menlo', 'monospace'],
      },
    },
  },
}
```

## State Management

No Redux/Zustand needed. React Context + hooks:

```tsx
// Contexts
AuthContext      — user, token, signIn(), signOut()
InstanceContext  — currentInstance, switchInstance()
VoiceContext     — stt, tts, convoMode, settings

// Hooks
useApi(path, opts)     — { data, loading, error, refetch }
usePolling(fn, ms)     — calls fn every ms, cleans up on unmount
useRuntime(instanceId) — { status, node, relay, lastSeen }
useVoice()             — { startConvo, stopConvo, toggleMic, toggleSpeak }
```

## Build Integration

```js
// workers/host/build.js (updated)
const bundle = fs.readFileSync('store/console/dist/assets/index-[hash].js', 'utf-8');
const bundleCss = fs.readFileSync('store/console/dist/assets/index-[hash].css', 'utf-8');
// ... include in pages.ts as consoleBundle + consoleBundleCss
```

The host worker serves the bundle at the console route, with the HTML entry point loading it.

## Timeline

Total: ~6 hours of focused work across 11 phases.
Each phase is independently verifiable — if a session runs out of context, the next one picks up at the current phase.

## Non-goals

- No SSR (it's a SPA served by a Worker)
- No testing framework for React (backend tests cover the API)
- No i18n (English only)
- No state persistence (API is the source of truth)
- No code splitting (bundle is small enough for one chunk)
