-- #1250: every existing "Runs on" pin moves from a hostname to the machine id behind it.
--
-- A pin stored whatever hostname the machine reported when it was set, and macOS renames a machine
-- per network, so one laptop's instances were pinned under four of its names. A pin is now
-- `config.runnerMachineId`. This resolves each hostname pin to the ONE machine id the owner's
-- registrations under that hostname carry — and only when there is exactly one: a hostname used by two
-- machines, or only by a CLI too old to mint an id, is left as it was (it keeps routing by hostname)
-- and `GET /v1/terminals/nodes` lists it under `unresolvedPins`.
--
-- `config.runnerNode` is kept beside the new id on purpose. Migrations apply before the new Worker is
-- live, and the old one routes by `runnerNode`: removing it here would unpin every instance for the
-- length of the deploy. The new code reads the id first and ignores the leftover; the next repin
-- removes it.
UPDATE agent_instances
   SET config = json_set(config, '$.runnerMachineId', (
         SELECT MIN(n.machine_id) FROM instance_runtime_nodes n
          WHERE n.user_id = agent_instances.user_id
            AND n.runner_node = json_extract(agent_instances.config, '$.runnerNode')
            AND n.machine_id IS NOT NULL AND n.machine_id != ''
       )),
       updated_at = datetime('now')
 WHERE json_valid(config)
   AND COALESCE(json_extract(config, '$.runnerNode'), '') != ''
   AND json_extract(config, '$.runnerMachineId') IS NULL
   AND (SELECT COUNT(DISTINCT n.machine_id) FROM instance_runtime_nodes n
         WHERE n.user_id = agent_instances.user_id
           AND n.runner_node = json_extract(agent_instances.config, '$.runnerNode')
           AND n.machine_id IS NOT NULL AND n.machine_id != '') = 1;
