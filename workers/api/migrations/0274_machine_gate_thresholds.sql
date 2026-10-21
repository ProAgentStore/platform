-- #1275: admission thresholds and the gate itself move from the (instance, machine-name) row to the MACHINE.
--
--   gate_thresholds  a PARTIAL JSON override of the defaults, merged field by field (cpuLoad1PerCpu, cpuLoad5PerCpu,
--                    memUsedPctMax, memAvailableMinBytes, diskUsedPctMax, diskFreeMinBytes, recoveryBand,
--                    recoveryStreak) plus `maxSessions`, an explicit session limit that replaces the
--                    cores/memory formula. NULL = every default applies.
--   gate_state       the hysteresis the gate carries between heartbeats, ONE per machine: every instance on a
--                    machine reads and writes the same verdict (it was one per instance, so two agents on one
--                    laptop could disagree about whether it was overloaded).
--   gate_evaluated_at the runner clock (ms) of the sample the state last judged, so several instances heartbeating
--                    the same machine within seconds count as ONE sample toward the recovery streak.
--
-- Keyed like the rest of machine_policies: (user_id, machine_id), the id the CLI mints once.
-- instance_runtime_nodes.gate_thresholds / gate_state (0268) stay for a runner too old to send a machine id.
ALTER TABLE machine_policies ADD COLUMN gate_thresholds TEXT;
ALTER TABLE machine_policies ADD COLUMN gate_state TEXT;
ALTER TABLE machine_policies ADD COLUMN gate_evaluated_at INTEGER;

-- Carry any per-node override already stored (0268) up to its machine, so a machine's policy is not lost by the move.
INSERT INTO machine_policies (user_id, machine_id, auto_update, status, updated_at, gate_thresholds)
  SELECT user_id, machine_id, 0, 'disabled', unixepoch() * 1000, MAX(gate_thresholds)
    FROM instance_runtime_nodes
   WHERE machine_id IS NOT NULL AND gate_thresholds IS NOT NULL
   GROUP BY user_id, machine_id
  ON CONFLICT(user_id, machine_id) DO UPDATE SET gate_thresholds = COALESCE(machine_policies.gate_thresholds, excluded.gate_thresholds);
