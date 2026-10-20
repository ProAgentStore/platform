-- #1242: where a parked run's work is, so it resumes there and nowhere else.
--
-- A run parked on a question sets its uncommitted work aside on the runner (`refs/pags/parked/<run>`,
-- 0246) — on ONE machine's checkout. Nothing recorded which: run d12e99fa parked on pink-laptop, its
-- Workflow woke a day later, re-resolved the machine from the instance pin (Mac.modem), and asked a
-- checkout that had never had the commit to put it back. Now the park records the machine (stable id
-- and the hostname it answered to), the checkout path, and whether the ref reached origin; resume
-- happens only on that machine, and a continue (the owner's explicit move) is what may fetch it.
ALTER TABLE agent_loop_runs ADD COLUMN parked_machine_id TEXT;
ALTER TABLE agent_loop_runs ADD COLUMN parked_node TEXT;
ALTER TABLE agent_loop_runs ADD COLUMN parked_workdir TEXT;
ALTER TABLE agent_loop_runs ADD COLUMN parked_pushed INTEGER;
