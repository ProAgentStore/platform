-- #1026: the grounded coder brain records WHAT it relied on. `evidence` is the JSON array of source labels the
-- decision cited (an issue, a doc, a file, a commit, an earlier decision); `risks` the JSON array of risks it
-- named. Both are set on a decision and, when the model gave them, on a decline. Labels and short text only —
-- never file contents.
ALTER TABLE coder_questions ADD COLUMN evidence TEXT;
ALTER TABLE coder_questions ADD COLUMN risks TEXT;
