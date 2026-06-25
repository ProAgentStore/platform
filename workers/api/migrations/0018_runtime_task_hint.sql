-- Free-text guidance a user sends to a paused (stuck) agent's brain.
-- The workflow reads + clears it on resume and injects it into the prompt.
ALTER TABLE instance_runtime_tasks ADD COLUMN user_hint TEXT;
