-- #960: what a run parked on `decision` is ASKING. A coding run that pauses for the owner's answer
-- (the Pilot's `ask_owner` choice, or `request_user_info` value) used to park as `human` — exactly
-- like a hands-on takeover — and kept the question only in a notification and a chat line. This
-- column holds the ask itself, as JSON: {question, options[], why, field, taskId}, where `taskId`
-- is the board card the answer box is on (the delegation task, else the session card `csess-…`).
-- Written with the park and cleared with it, like `waiting_reason`; null when not parked on one.
ALTER TABLE agent_loop_runs ADD COLUMN waiting_ask TEXT;
