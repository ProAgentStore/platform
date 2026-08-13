-- The Repo Coder's `engine` SETTING is deleted: which CLI a session launches is chosen once (#549).
--
-- FOUR things claimed to decide which coding CLI runs on the owner's machine, and the one the
-- console labels "Coding CLI" — on the Settings tab, under "Agent settings" — was read by no code
-- at all. Grepped 2026-08-13: `settings.engine` has zero functional readers in `workers/api/src`
-- and zero in the console. Its ONLY effect was that `agent-think.ts` injects the resolved settings
-- into the chat prompt's `## Settings` block.
--
-- That is worse than an inert field. It made the AGENT assert it. Asked why his Claude limit kept
-- burning after he had "switched to Codex", the agent answered that the Settings had Codex
-- configured — reading its own prompt back to him. Confirmed in production D1: `start_work` opened
-- a CLAUDE session at 12:08:30 while `settings.engine` read `codex`.
--
-- ── Which of the four is authoritative, and why it is not this one
--
-- `agent_instances.config.defaultEngineId` — the console's ⚙ CLI engines panel. Everything else
-- follows it or is gone:
--
--   * `settings.engine` (this migration) — deleted. Three option values cannot express what an
--     engine actually is here. A preset is `{id, label, command, auth}` and the command is a real
--     argv: `codex exec --sandbox danger-full-access`. `ENGINE_WRITE_FLAGS` documents why the
--     write flag per engine is load-bearing — a preset without it silently changes what the agent
--     may DO when you switch engines. A select cannot carry that, so making this field
--     authoritative would have meant deleting the panel that can.
--
--   * `coding_repos.default_client` — dropped from the resolution chain in the same commit. It is
--     a `CodingClientType` ("claude" | "codex" | …), NOT a preset id, and `resolveEngine` matches
--     `engines.find(e => e.id === engineId)` — so it only ever worked by the coincidence that the
--     seeded preset ids happen to equal the client types. Rename a preset and it silently misses.
--     It has no UI, is not accepted by the repo PUT route, is never sent by the console, and
--     `coding-store.ts` wrote it once at create as "claude". So it was a hardcoded constant that
--     outranked the control the owner was actually using — which is exactly how a Claude session
--     opened under `defaultEngineId = codex`.
--
--   * `coding_sessions.launch_command` — still wins, and correctly: it is not a control, it is the
--     command a process on someone's laptop was ALREADY started with. What was missing is that
--     nobody was told. The same commit makes the reuse branch say which engine is actually running
--     and how to change it.
--
-- ── Why delete rather than wire it through
--
-- The mirror of migration 0102's reasoning, which deleted this agent's `repo` setting for the same
-- defect one field over. Wiring `settings.engine` into `resolveEngine` would make a typed
-- settings field mutate `coding_repos`/`coding_sessions` state, add a FIFTH writer, and create the
-- sync 0102 calls "a disagreement waiting to happen". 0102's sentence applies here verbatim and
-- more sharply, because this field did not even have half a wire:
--
--     Half a wire is worse than none: it makes the field look connected.
--
-- This field survived 0102's cleanup, and migration 0092 — which edited THIS field — corrected only
-- its description ("in tmux" -> "on your machine") without noticing it was inert.
--
-- ── Stored values are ORPHANED, deliberately
--
-- Instances keep `config.settings.engine` in their JSON. With the field off the schema the console
-- stops rendering it, `applySettingsPatch` (schema-driven) can no longer write it, and
-- `resolveSettingsValues` no longer surfaces it — so it leaves the prompt, which is the half that
-- actually misled the owner. It is NOT copied into `defaultEngineId`: these values were never
-- consulted by anything, so adopting one would silently CHANGE which CLI an instance launches on
-- the strength of a control that has never worked. `repo-path-writer.test.ts` is the standing
-- guard that a schema edit does not orphan a setting something still reads; #520 is the recorded
-- cost of getting that wrong, and it is why this paragraph is a claim the test verifies rather
-- than a comment asserting "nothing reads it".
--
-- ── Shape
--
-- Rebuilds `$.settingsSchema` as the same array minus the `engine` element, preserving order and
-- every other field — byte-for-byte 0102's statement with a different id. Scoped to `coder-repo`:
-- it is the only agent that declares `engine` (grepped across all 125 migrations), and a
-- creator-authored agent's schema is not this migration's business. Idempotent — the EXISTS guard
-- makes a re-run a no-op — and a no-op on a database without the agent.

UPDATE agents
   SET config = json_set(
         config,
         '$.settingsSchema',
         (SELECT json_group_array(json(field.value))
            FROM json_each(agents.config, '$.settingsSchema') AS field
           WHERE json_extract(field.value, '$.id') <> 'engine')
       ),
       updated_at = datetime('now')
 WHERE slug = 'coder-repo'
   AND json_valid(config)
   AND json_type(config, '$.settingsSchema') = 'array'
   AND EXISTS (
         SELECT 1 FROM json_each(agents.config, '$.settingsSchema') AS declared
          WHERE json_extract(declared.value, '$.id') = 'engine'
       );
