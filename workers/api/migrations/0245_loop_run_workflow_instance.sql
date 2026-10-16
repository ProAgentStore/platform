-- #1076: the Workflow instance a run's Pilot is executing in, so a run parked on a QUESTION can be
-- woken. A parked run waits on `step.waitForEvent` at zero compute (no sleep loop, no runner poll);
-- an answer, a cancel or the minute backstop reaches it with `instance.sendEvent`, which needs the
-- instance id. Written by the park itself from `event.instanceId`, so it is right for every run,
-- including those created before this column existed. Null for a run that never parked.
ALTER TABLE agent_loop_runs ADD COLUMN workflow_instance_id TEXT;
