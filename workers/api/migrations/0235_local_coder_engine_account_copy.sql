-- #871: Local Coder's catalog copy states the owner's pricing decision (2026-10-14).
--
-- Platform access comes from the ProAgentStore subscription (`requirePro` on runtime registration,
-- session open and a coding run's start — 0164's note), and Local Coder has NO price of its own:
-- there is no per-agent entitlement and none is to be added. The coding engine is the subscriber's
-- OWN account — their Claude Code / Codex / Grok login or key on their machine — so engine usage is
-- billed to them by that provider, and the platform neither pays for it nor can meter it as a bill
-- (#348, `payer` in docs/coding-engines.md). The 0164 description said none of this, which left a
-- subscriber to guess who pays for the engine.
--
-- A narrow UPDATE of `description` only, keyed by slug; re-running converges to the same text.

UPDATE agents
SET description = 'Your own coding agent, running on your own machine. Install the ProAgentStore CLI, sign in and run `pags up` to start a local runner, and this agent drives a coding CLI (Claude Code, Codex or Grok) in your repository there — terminal commands, git and tests run on your hardware, not a shared cloud box. It works through objectives autonomously, reads and comments on your GitHub issues, and hands back control when it is stuck. A setup checklist walks you through every step. Bring your own engine account: the coding CLI signs in with your own Claude, Codex or Grok login or key, and its usage is billed to you by that provider. Your ProAgentStore plan covers the platform; this agent has no separate price.',
    updated_at = datetime('now')
WHERE slug = 'local-coder';
