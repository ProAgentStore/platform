-- #1646: "what does this owner's machine <hostname> say" (latestResourceSample, environmentsForNodes, and
-- the user_id + runner_node lookups in terminals / runner-client / runner-node-pin) had only the user_id
-- prefix of idx_instance_runtime_nodes_machine to search by, so each call read EVERY node row the owner
-- has (~215 in production) to answer about 1-4 hostnames. Neither column changes on a heartbeat, so the
-- index is written on registration only.
CREATE INDEX IF NOT EXISTS idx_instance_runtime_nodes_user_node
  ON instance_runtime_nodes(user_id, runner_node);

-- machineNodeNames (`SELECT DISTINCT runner_node … WHERE user_id = ? AND machine_id = ?`) reads the machine's
-- rows through idx_instance_runtime_nodes_machine and then each table row for its hostname. This one covers
-- it and returns hostnames in order, so the DISTINCT needs no temp b-tree. It is also what keeps the planner
-- from answering that query with the index above by user_id alone, which would read all of the owner's rows.
CREATE INDEX IF NOT EXISTS idx_instance_runtime_nodes_machine_node
  ON instance_runtime_nodes(user_id, machine_id, runner_node);
