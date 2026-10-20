-- #1242: runs already parked before 0263 recorded nothing about where they parked, so on waking they
-- would still fall back to whatever machine the Workflow re-resolves — the defect itself. Their
-- session's stamped `runner_node` is the machine they parked on (a park stops the engine there and
-- suspends the session; nothing re-stamps a parked session until it is woken). Backfill it, with the
-- machine id when that hostname names exactly one of the owner's machines.
--
-- Only still-parked runs (running, on a question) with no record yet; a run already woken and
-- re-stamped elsewhere is not guessed at — that run is listed on #1242 instead.
UPDATE agent_loop_runs
   SET parked_node = (SELECT s.runner_node FROM coding_sessions s WHERE s.id = agent_loop_runs.session_id),
       parked_machine_id = (
         SELECT MIN(n.machine_id) FROM instance_runtime_nodes n JOIN coding_sessions s ON s.id = agent_loop_runs.session_id
          WHERE n.user_id = agent_loop_runs.user_id AND n.runner_node = s.runner_node AND n.machine_id IS NOT NULL
         HAVING COUNT(DISTINCT n.machine_id) = 1),
       parked_workdir = (SELECT r.workdir FROM coding_sessions s JOIN coding_repos r ON r.id = s.repo_id WHERE s.id = agent_loop_runs.session_id)
 WHERE status = 'running' AND waiting_reason = 'decision'
   AND parked_node IS NULL AND parked_machine_id IS NULL
   AND EXISTS (SELECT 1 FROM coding_sessions s WHERE s.id = agent_loop_runs.session_id AND COALESCE(s.runner_node, '') != '');
