-- Per-session launch command, so a session remembers WHICH engine/CLI (and which
-- exact command + flags) it was started with. Lets the runner spawn the right
-- engine on first start AND on re-attach after a runner restart, without
-- re-deriving it. NULL → the runner falls back to the default Claude engine.
ALTER TABLE coding_sessions ADD COLUMN launch_command TEXT;
