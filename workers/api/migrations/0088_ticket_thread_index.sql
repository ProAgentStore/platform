-- A board card now shows how many turns its ticket's conversation has (#150), so the board
-- read counts `ticket.question` / `ticket.answer` rows per task.
--
-- Without this index that count is a full scan of the instance's event history — and that
-- history is the runtime's firehose (every step, every lifecycle transition), while thread
-- turns are a handful of rows. The board polls every 2.5s in the console, so the cheap
-- feature would have been paid for out of the expensive table on every poll.
--
-- Partial on the two conversation types: the index holds only thread rows, so the count is
-- an index-only lookup whose size is the number of questions asked, not the number of
-- events logged.
CREATE INDEX IF NOT EXISTS idx_runtime_task_events_thread
  ON instance_runtime_task_events(instance_id, user_id, task_id)
  WHERE type IN ('ticket.question', 'ticket.answer');
