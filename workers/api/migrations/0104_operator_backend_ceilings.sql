-- The kitty and iTerm2 Operators get the backend their names claim (#402).
--
-- 0099 could not fix these two. It made the tmux Operator a tmux agent BY CONSTRUCTION by
-- declaring the six `tmux_*` tools — there is no iTerm2 code path behind them — but there is no
-- `kitty_*` or `iterm2_*` connector to do the same with, and shipping two more parallel
-- connectors to express "one backend" is the workaround that does not scale
-- (`docs/capability-constraints.md`). So 0099 did the only honest thing available and rewrote
-- their DESCRIPTIONS to admit they reach all three backends, with a note saying #402 is what
-- finally makes the names true. This is that migration.
--
-- #404 shipped the primitive: `capabilities.surfaceOptions.terminal.backends` is a CEILING on a
-- tool's arguments, enforced in `runRegistryTool` at dispatch — an out-of-scope `backend`, or a
-- `target` carrying an out-of-scope prefix (`iterm2:1:1:1`), is refused before any handler runs,
-- and an omitted `backend` arrives already narrowed to the one permitted value. A subscriber may
-- narrow it further and can never widen it. So this is a CONFIG change, which was the point of
-- building the primitive rather than a fourth connector.
--
-- Both rows are `visibility = 'draft'` (verified against the live D1 on 2026-08-08, along with
-- their exact configs), so this changes no published catalog entry. It is still worth doing now:
-- the ceiling is what the rows were waiting for, and a draft that becomes true only when someone
-- remembers is a draft that gets published false.
--
-- ── The DESCRIPTIONS go back
--
-- 0099's sentence — "Not kitty-only: the terminal tools reach tmux, kitty and iTerm2 alike" — was
-- true when it was written and becomes FALSE the moment the ceiling is declared. A description
-- that overstates a capability and one that understates it are the same defect (#362), so the
-- copy is rewritten in the same migration that changes the capability. It now names the mechanism,
-- because "constrained by its declared capabilities, enforced at dispatch" is checkable and
-- "kitty-only" is a promise.
--
-- ── Shape: the narrowest path, not the whole object
--
-- `json_set` on `$.capabilities.surfaceOptions.terminal.backends` alone. Re-setting a whole
-- `$.capabilities` object would mean reproducing everything 0072/0073/0099 and the live edits put
-- on these rows — surfaces, runtime, workflow and the six declared tools — and getting one of them
-- wrong silently removes a capability (the failure #415's close-out documents). SQLite creates the
-- missing intermediate objects for a path set this way; verified against sqlite3, including that a
-- second run is a no-op.
--
-- `terminal-operator` is deliberately LEFT UNCONSTRAINED. It is the agent that exercises the whole
-- connector — surveying every backend is its entire purpose and its description already says so —
-- and #402 is explicit that the generic one must stay `many`.
--
-- `tmux-operator` is deliberately NOT given a `terminal.backends` ceiling either, and the reason is
-- mechanical rather than aesthetic: since 0099 it declares `tmux_*` tools, whose connector is
-- `tmux`, and `CONNECTOR_CONSTRAINTS` has no vocabulary for that connector. `parseConstraintSpec`
-- would therefore drop the field on the next write through `sanitizeDeclaredCapabilities` — so
-- writing it would be storing config the sanitiser deletes, which reads to the next person as a
-- ceiling that exists. Its claim is already true by construction, which is stronger.
--
-- Neither row is given `targets: "single"`: these are backend test agents, not named single-pane
-- operators, and `many` is the default that keeps every existing agent byte-identical.
--
-- Pinned by `lib/operator-backend-ceiling.test.ts`, which resolves what this file writes through
-- the REAL parser, the REAL merge and the REAL dispatcher gate rather than trusting the SQL.

UPDATE agents
   SET config = json_set(
         config,
         '$.capabilities.surfaceOptions.terminal.backends',
         json('["kitty"]')
       ),
       description = 'Test agent for the kitty backend of the ProAgentStore terminal connector. Constrained to kitty by its declared capabilities (surfaceOptions.terminal.backends), enforced at dispatch: it cannot see or drive tmux sessions or iTerm2 windows on the connected machine.',
       updated_at = datetime('now')
 WHERE slug = 'kitty-operator'
   AND json_valid(config)
   AND json_extract(config, '$.capabilities') IS NOT NULL;

UPDATE agents
   SET config = json_set(
         config,
         '$.capabilities.surfaceOptions.terminal.backends',
         json('["iterm2"]')
       ),
       description = 'Test agent for the iTerm2 backend of the ProAgentStore terminal connector. Constrained to iterm2 by its declared capabilities (surfaceOptions.terminal.backends), enforced at dispatch: it cannot see or drive tmux sessions or kitty windows on the connected machine.',
       updated_at = datetime('now')
 WHERE slug = 'iterm-operator'
   AND json_valid(config)
   AND json_extract(config, '$.capabilities') IS NOT NULL;
