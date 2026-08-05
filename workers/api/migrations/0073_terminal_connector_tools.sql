-- Move the tmux Operator to the generic local-terminal connector tools.
--
-- 0072 created the agent before the terminal connector existed. Production has already run that
-- migration, so this follow-up converges existing rows without relying on 0072 being replayed.

UPDATE agents
   SET config = json_set(
         COALESCE(NULLIF(config, ''), '{}'),
         '$.capabilities.tools',
         json('[
           "terminal_list_targets",
           "terminal_capture",
           "terminal_run_command",
           "terminal_send_keys",
           "terminal_new_target",
           "terminal_kill_target"
         ]')
       ),
       updated_at = datetime('now')
 WHERE slug = 'tmux-operator';

-- Existing tmux Operator users already made the local-terminal write decision for tmux. The
-- generic connector is the same local runner authority widened to multiple backends, so preserve
-- that consent instead of breaking their newly added terminal_* write tools.
INSERT OR IGNORE INTO instance_connector_consent (instance_id, user_id, connector, scope, created_at)
SELECT instance_id, user_id, 'terminal', scope, created_at
  FROM instance_connector_consent
 WHERE connector = 'tmux'
   AND scope = 'write';
