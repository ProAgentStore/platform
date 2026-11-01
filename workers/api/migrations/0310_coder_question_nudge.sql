-- #1417: a run PARKED on a question (zero-compute wait, #1076) is exempt from the expiry sweep — correctly, since
-- it is still genuinely waiting — but that also meant it was exempt from ever telling the owner again. Four FAS
-- Apps Coder runs sat parked on questions for a week with nobody nudged.
--
-- `nudged_at` tracks the last time the sweep re-surfaced a still-parked question to the owner, independent of
-- `asked_at`/`expires_at`: a nudge changes nothing about the question's state or its wait, it only resets when the
-- NEXT nudge is due.
ALTER TABLE coder_questions ADD COLUMN nudged_at INTEGER;
