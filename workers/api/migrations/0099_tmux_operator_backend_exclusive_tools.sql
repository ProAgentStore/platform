-- The tmux Operator becomes a tmux agent BY CONSTRUCTION (#403).
--
-- 0072 seeded it with the backend-exclusive `tmux_*` tools; 0073 moved it onto the GENERIC
-- terminal connector, whose `terminal_list_targets` takes `backend: "all" | "tmux" | "kitty" |
-- "iterm2"` and DEFAULTS TO ALL (connectors/terminal.ts). So an agent named, described and sold
-- as the tmux Operator has been reading and driving the owner's kitty windows and iTerm2 tabs
-- ever since — observed: asked about tmux sessions, it correctly reported two iTerm2 windows,
-- because that is genuinely what it can reach.
--
-- The registry already has a tmux-only connector (`registry.ts` id "tmux") with six tools that
-- have no other backend behind them. Declaring exactly those makes the claim true in the only
-- way that survives a persuasive user: there is no iTerm2 code path to reach, so the constraint
-- is not something the model can be talked around. Verified against TMUX_TOOLS, and pinned by
-- `lib/tmux-operator-seed.test.ts` so a typo cannot silently produce a tool-less agent.
--
-- This is the interim fix, not the destination. #404 adds a constraint the creator declares on a
-- tool's ARGUMENTS (`surfaceOptions.terminal.backends: ["tmux"]`) enforced in `runRegistryTool`,
-- and #402 puts the terminal connector back behind it. That is what kitty and iTerm2 need, and
-- what lets the console's generic terminal surface keep working — see the note below.
--
-- KNOWN COST, recorded rather than discovered later: the console's terminal tab
-- (`store/console/src/tabs/TmuxTab.tsx`) calls the `terminal_*` names literally, so on this
-- instance those calls are now refused by the declared-allowlist gate and the tab renders its
-- error slot instead of a pane. Driving tmux through CHAT is unaffected and is now correct
-- rather than merely lucky. The surface is deliberately left declared so it comes back the
-- moment either the tab learns the tmux family or #402 lands; a tab that vanished would hide
-- the reason. Not fixed here because #403 is scoped to data.

UPDATE agents
   SET config = json_set(
         COALESCE(NULLIF(config, ''), '{}'),
         '$.capabilities.tools',
         json('[
           "tmux_list_sessions",
           "tmux_capture_pane",
           "tmux_run_command",
           "tmux_send_keys",
           "tmux_new_session",
           "tmux_kill_session"
         ]')
       ),
       updated_at = datetime('now')
 WHERE slug = 'tmux-operator';

-- Carry the write decision across the connector change, the way 0073 carried it the other way.
--
-- 0073 copied every `tmux` write-consent row to `terminal` and left the originals in place, so an
-- instance that predates it still has both. An instance subscribed AFTER 0073 has only the
-- `terminal` row — and consent is keyed by CONNECTOR, so without this the owner's newer tmux
-- Operator would silently lose every write tool and have to re-grant a permission they already
-- gave. Scoped to this agent's instances on purpose: a `terminal` grant on some OTHER agent says
-- nothing about tmux, and widening it here would be granting write nobody asked for.
INSERT OR IGNORE INTO instance_connector_consent (instance_id, user_id, connector, scope, created_at)
SELECT c.instance_id, c.user_id, 'tmux', c.scope, c.created_at
  FROM instance_connector_consent c
  JOIN agent_instances i ON i.id = c.instance_id
  JOIN agents a ON a.id = i.agent_id
 WHERE c.connector = 'terminal'
   AND c.scope = 'write'
   AND a.slug = 'tmux-operator';

-- kitty and iTerm2 cannot be fixed the same way, so make them honest instead.
--
-- There is no `kitty_*` or `iterm2_*` connector to declare — the ONLY way to reach those
-- backends is the generic terminal connector, which reaches all three. That is not an oversight
-- to correct with two more parallel connectors; it is the argument for #404's constraint.
--
-- Description rather than unpublish, because both rows are ALREADY `visibility = 'draft'` and
-- have never been in the catalog: unpublishing is a no-op that would leave the misleading copy
-- in place, while the sentence travels with the row if it is ever published. The claims lint
-- (#362) does not catch this class at all — it reasons about `runtime`/`workflow` backing, and
-- these agents genuinely have a runtime; what they overstate is WHICH RESOURCE they reach.
-- `terminal-operator` is left alone: its description already says "across tmux, kitty, and
-- iTerm2", which is exactly the truth.
UPDATE agents
   SET description = 'Test agent for the kitty backend of the generic ProAgentStore terminal connector. Not kitty-only: the terminal tools reach tmux, kitty and iTerm2 alike, so this agent can see and drive every local terminal on the connected machine, not just kitty.',
       updated_at = datetime('now')
 WHERE slug = 'kitty-operator';

UPDATE agents
   SET description = 'Test agent for the iTerm2 backend of the generic ProAgentStore terminal connector. Not iTerm2-only: the terminal tools reach tmux, kitty and iTerm2 alike, so this agent can see and drive every local terminal on the connected machine, not just iTerm2.',
       updated_at = datetime('now')
 WHERE slug = 'iterm-operator';
