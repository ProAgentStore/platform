-- Who is driving this engine? (single-flight, #208)
--
-- `POST /coding/sessions/:id/run` created a CodingSessionWorkflow with no check that one was
-- already running on that session. Two Pilots then interleave `tmux send-keys` into the SAME pane,
-- each reasoning over a terminal the other is also typing into. The platform already learned this
-- lesson once, on browser tasks: "Interleaved clicks and types on a live page is exactly what that
-- claim exists to prevent" (routes/instances-runtime.ts). Nobody applied it here — because there
-- was no column in which the question "who owns this session" could even be asked.
--
-- Released by the workflow when it finishes. If the workflow dies without releasing, the session's
-- existing orphan reaper (`reconcileOrphanedSessions`, #139) ends the session on the next drive,
-- which clears the claim with it — so no heartbeat and no separate expiry are needed.
ALTER TABLE coding_sessions ADD COLUMN driver_id TEXT;
ALTER TABLE coding_sessions ADD COLUMN driver_at INTEGER;
