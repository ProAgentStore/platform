-- Add tmux_secure_put / tmux_secure_get to the tmux Operator's declared tool list (#918).
--
-- The owner drives each machine only through its tmux Operator, so the machine-to-machine secret
-- handoff lives on the Operator's own surface: machine A's Operator PUTs a file into the encrypted
-- secure-input store and gets a handle, machine B's Operator GETs the handle into a file. Without
-- these, the only way to move a secret between the two was `tmux_run_command` + `cat`, which puts
-- the value in a pane snapshot and a tool result.
--
-- Both are `write` on the tmux connector, so they sit behind the same tmux write-consent the
-- Operator's other writes do.
--
-- The full array is replaced, matching 0099 and 0117.

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
           "tmux_secure_put",
           "tmux_secure_get",
           "tmux_kill_session"
         ]')
       ),
       updated_at = datetime('now')
 WHERE slug = 'tmux-operator';
