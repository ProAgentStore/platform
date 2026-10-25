-- #1142: one repo binding, many per-machine checkouts.
--
-- A coding repo binding (`coding_repos`) holds ONE `workdir` and ONE `clone_status`, implicitly on whichever machine
-- the instance was first pinned to. Repinning an instance did not move or verify anything on the new machine, and with
-- machines going offline (the 2026-10-18 runner outage) every active repo has to be checkable, and cloneable, on every
-- machine. A checkout is that fact for one (repo, machine): where it lives there and whether it is usable.
--
--   machine_id        the stable machine id (#1250), the same key `agent_instances.config.runnerMachineId` pins to.
--   workdir           the path ON THAT MACHINE. NULL means "the binding's own workdir" (a home-relative `~/dev/x` path
--                     is the same string everywhere, which is why #1237 asks for them).
--   clone_status      unknown | cloning | ready | needs_attention | error | ... (the binding's vocabulary).
--   last_verified_at  when a machine last gave a DEFINITE verdict (as `coding_repos.clone_checked_at`); NULL = nobody has looked.
--
-- The binding's own `workdir` / `clone_status` columns stay: older readers and older runners use them, and they remain the
-- default for a machine with no row of its own. This table is the per-machine truth beside them.
CREATE TABLE coding_repo_checkouts (
  id               TEXT PRIMARY KEY,
  repo_id          TEXT NOT NULL REFERENCES coding_repos(id) ON DELETE CASCADE,
  machine_id       TEXT NOT NULL,
  workdir          TEXT,
  clone_status     TEXT NOT NULL DEFAULT 'unknown',
  clone_error      TEXT,
  last_verified_at TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (repo_id, machine_id)
);
CREATE INDEX idx_coding_repo_checkouts_machine ON coding_repo_checkouts(machine_id);

-- Seed: every binding that already has a checkout on record (a folder, or any verdict beyond "unknown") belongs to the
-- machine its instance is pinned to. A binding whose instance has no pinned machine id has no machine to attribute it to,
-- and is skipped: it keeps working from its own columns. `json_extract` on a malformed config would abort the whole
-- migration, so it is only ever evaluated behind `json_valid`, inside a CASE.
INSERT OR IGNORE INTO coding_repo_checkouts (id, repo_id, machine_id, workdir, clone_status, clone_error, last_verified_at, created_at, updated_at)
SELECT lower(hex(randomblob(16))), r.id, p.machine_id, NULLIF(trim(COALESCE(r.workdir, '')), ''), r.clone_status, r.clone_error, r.clone_checked_at, r.created_at, r.updated_at
  FROM coding_repos r
  JOIN (
    SELECT ai.id AS instance_id,
           CASE WHEN json_valid(ai.config) THEN json_extract(ai.config, '$.runnerMachineId') END AS machine_id
      FROM agent_instances ai
  ) p ON p.instance_id = r.instance_id
 WHERE p.machine_id IS NOT NULL AND trim(p.machine_id) <> ''
   AND (trim(COALESCE(r.workdir, '')) <> '' OR r.clone_status <> 'unknown');
