-- Add tmux_send_message to the tmux Operator's declared tool list (#482).
--
-- The tmux Operator drives interactive CLIs (Claude Code, Codex, REPLs) via tmux.
-- Before this change the model had to compose two low-level calls — tmux_send_keys with
-- text, then again with keys:["Enter"] — and had to independently know the pane was at
-- its input prompt. That two-step sequence misfired in production (#481): the message
-- was dropped because the pane was not ready when the first call arrived.
--
-- tmux_send_message encodes the correct protocol in the tool itself:
--   1. type the text
--   2. send Enter
--   3. wait for the pane to quiesce (the settle machinery from #481)
--   4. return changed + the post-settle pane, or an explicit "did not land" when the CLI
--      was not at its input prompt — a retry signal rather than a silent failure
--
-- tmux_send_keys stays for genuine key-level control (Escape, C-c, arrows, sequences).
-- tmux_send_message becomes the default path for "tell the CLI to do X".
--
-- The full array is replaced so the row is consistent after a single migration run
-- regardless of the prior state, matching the pattern established by 0099.

UPDATE agents
   SET config = json_set(
         COALESCE(NULLIF(config, ''), '{}'),
         '$.capabilities.tools',
         json('[
           "tmux_list_sessions",
           "tmux_capture_pane",
           "tmux_run_command",
           "tmux_send_keys",
           "tmux_send_message",
           "tmux_new_session",
           "tmux_kill_session"
         ]')
       ),
       updated_at = datetime('now')
 WHERE slug = 'tmux-operator';
