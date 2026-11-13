-- #1643 / #1645: the stats rollup asks, for every instance on every cron tick, "is there a row for
-- this instance on this day?". The primary key is (instance_id, card_id, day), so that probe walked
-- the instance's whole history (every card, every day, up to the 400-day retention) to answer it.
-- With (day, instance_id) it is one seek. The table is small (cards x days per instance).
CREATE INDEX IF NOT EXISTS idx_agent_stats_daily_day_instance
  ON agent_stats_daily(day, instance_id);
