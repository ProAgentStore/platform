-- A stable machine identity, ALONGSIDE the hostname (#379).
--
-- `runner_node` is os.hostname(), which on macOS follows the network-supplied name and flips
-- between the `.local` mDNS form and whatever DHCP hands out — so one laptop minted three node
-- identities and an instance pinned to a name it had stopped using answered every runner call
-- with "run `pags up`" while `pags up` was running on it.
--
-- The hostname is NOT replaced: it names a Durable Object (`<instance>:node:<runner_node>`) and
-- keys the pins, so swapping it for an id would rename every relay DO at once and take the whole
-- fleet offline until every CLI was upgraded. This column rides alongside it and answers only
-- "are these two names the same machine".
--
-- NULLABLE on purpose, and every existing row keeps NULL: unknown identity yields no alias, so
-- nothing is healed that cannot be proven. Rows acquire an id the first time the machine
-- registers with a CLI that mints one, and that registration also backfills the OTHER hostnames
-- that same machine has used (see `claimMachineNames`) — which is how a pin already stranded on a
-- dead name gets reconnected without anyone having to rename anything.
ALTER TABLE instance_runtime_nodes ADD COLUMN machine_id TEXT;

CREATE INDEX IF NOT EXISTS idx_instance_runtime_nodes_machine
  ON instance_runtime_nodes(user_id, machine_id);
