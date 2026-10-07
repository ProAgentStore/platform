-- #966: a secure input that can be CHECKED without being seen, and delivered to a named pane.
--
--   value_length            the submitted value's character count, written with the ciphertext. Lets an
--                           operator tell "the owner submitted nothing / a truncated code" from "delivery
--                           failed" — the one fact the 2026-10-08 gcloud handoff could not get. NULL until
--                           a value is stored (and for rows stored before this migration).
--   value_edge_whitespace   1 when the value starts or ends with whitespace — a pasted code with a stray
--                           newline or space. Never the value; never which character.
--   target                  the tmux session a `tmux`-scoped request is meant for, when the requester named
--                           one; `secure_input_inject` uses it unless told another. NULL = name it at inject.
ALTER TABLE secure_input_requests ADD COLUMN value_length INTEGER;
ALTER TABLE secure_input_requests ADD COLUMN value_edge_whitespace INTEGER;
ALTER TABLE secure_input_requests ADD COLUMN target TEXT;
