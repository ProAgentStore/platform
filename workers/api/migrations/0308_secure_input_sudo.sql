-- #1131: a secure input the platform runs under `sudo -S` on the owner's machine, instead of typing it into a pane.
--
--   command               the program and its arguments as a JSON array of strings (argv, without `sudo`). Written once when the request
--                         is created and never updated, so what the owner approves is what runs. NULL for every other scope.
--   command_approved_at   when the owner approved THIS command by submitting the value with it. A sudo request is not deliverable until it
--                         is set; the store sets it only when the submitted approval equals the stored command exactly.
--
-- Additive and nullable: rows from before this migration, and every non-sudo scope, are untouched.
ALTER TABLE secure_input_requests ADD COLUMN command TEXT;
ALTER TABLE secure_input_requests ADD COLUMN command_approved_at TEXT;
