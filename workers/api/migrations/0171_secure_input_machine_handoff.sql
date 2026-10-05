-- Machine-to-machine secret handoff (#918): which runner a value came FROM and which one took it.
--
-- `tmux_secure_put` deposits a value read from a file on one machine; `tmux_secure_get` writes it
-- to a file on another. Both are metadata the owner needs to audit a handoff from the console
-- without ever seeing the value: "deposited by mac-mini, retrieved by pink-laptop".
--
-- source_node  NULL = the owner typed the value into the console (the #906 path); otherwise the
--              runner node that read it.
-- consumed_node the runner node that wrote it out (NULL for a console-path consume, or not yet).

ALTER TABLE secure_input_requests ADD COLUMN source_node TEXT;
ALTER TABLE secure_input_requests ADD COLUMN consumed_node TEXT;
