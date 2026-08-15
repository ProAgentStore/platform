-- #631 — remove the ATS account password from the rows that already hold it.
--
-- The code fix (a5a01c21) redacts at the write, so no NEW row can carry the credential. It does
-- nothing for the rows written before it, and those are the exposure that has already happened:
-- 18 events measured in production on the one apply-capable instance, across 4 tasks and 3 ATS
-- hosts, each holding the 14-character password verbatim in `agent.decision` and `agent.shot`.
--
-- The count is a FLOOR, not a total. The only way to enumerate these from outside is
-- `instance_task_events`, which clamps at 500 rows, orders `created_at DESC` and has no offset
-- or cursor — so every row older than the newest 500 is unreachable by inspection and was never
-- counted. A SQL scrub reaches them all, which is the main reason this is a migration rather
-- than a hand-run cleanup against the rows someone could see.
--
-- ── Why this redacts in place instead of deleting
--
-- Deleting the rows would close the exposure and destroy the run history that makes an apply
-- failure diagnosable. It is not necessary: SQLite can excise the value WITHOUT being told what
-- it is. `deriveJobPassword` emits exactly `Pj9!` + 10 characters, always 14 long, so
-- `substr(payload, instr(payload,'Pj9!'), 14)` lifts the literal credential out of the row it
-- lives in, and `replace()` then removes every occurrence of it from that same row — the
-- message and the nested action alike. The row, its type, its timestamp and the rest of its
-- text all survive.
--
-- Deriving the needle per-row also means this is correct for EVERY user at once: the password is
-- a function of the user id, so a hardcoded value could only ever have cleaned one account.
--
-- ── Why the marker is safe to match on
--
-- `Pj9!` cannot occur inside base64, which has no `!` in its alphabet — so the embedded
-- screenshot data URIs these events carry cannot produce a false positive. (Three coincidental
-- `Pj9` hits were measured inside such a URI; none had the `!`, and none match here.)
--
-- Idempotent: after the first run no payload contains `Pj9!`, so `WHERE instr(...) > 0` matches
-- nothing and re-running is a no-op.

-- The runner's task-event mirror — the sink that actually held the credential in production.
UPDATE instance_runtime_task_events
   SET payload = replace(payload, substr(payload, instr(payload, 'Pj9!'), 14), '••••')
 WHERE instr(payload, 'Pj9!') > 0;

-- The per-ATS cache. Named in #631 as the sink that is served straight BACK to the browser:
-- `/v1/instances/:id/apply-tips` returns `notes` verbatim and the console renders it under
-- Knowledge -> Rules & Tips, so a credential here is one an owner is shown rather than one
-- merely stored.
UPDATE ats_apply_cache
   SET notes = replace(notes, substr(notes, instr(notes, 'Pj9!'), 14), '••••')
 WHERE instr(notes, 'Pj9!') > 0;

-- The unified trace. Measured clean on the affected instance — migration 0038 created this table
-- ~24 hours after the last leaking run, so it never received those particular rows — but the
-- dual fan-out in `workflows/job-apply.ts` has written both sinks ever since, and "clean by an
-- accident of timing" is not a reason to leave the newer rows unchecked.
UPDATE agent_events
   SET context = replace(context, substr(context, instr(context, 'Pj9!'), 14), '••••')
 WHERE context IS NOT NULL AND instr(context, 'Pj9!') > 0;

UPDATE agent_events
   SET message = replace(message, substr(message, instr(message, 'Pj9!'), 14), '••••')
 WHERE message IS NOT NULL AND instr(message, 'Pj9!') > 0;
