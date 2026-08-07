-- The Repo Coder does not drive its CLI in tmux (#348).
--
-- Its `engine` setting has told every subscriber "Which CLI this agent drives in tmux." since
-- migration 0063. `headless.ts` spawns the CLI as a CHILD PROCESS and talks to it over stream-json;
-- tmux belongs to the separate terminal connector, which is a different code path with different
-- properties — notably that a pane cannot be metered and a child process can. So the sentence is
-- not a harmless imprecision: it points a reader at the one driver whose spend does NOT reach the
-- ledger, while they are looking at the one whose does.
--
-- The string shows on every Repo Coder instance's settings, which is why it needs correcting in
-- data and not only in the seed file. `settingsSchema` lives on the AGENT (subscribers store
-- values, not the schema), so one UPDATE per template fixes every instance of it.
--
-- Same class as #347: a surface asserting something the code does not do, which then gets believed.
UPDATE agents
   SET config = REPLACE(
         config,
         '"description":"Which CLI this agent drives in tmux."',
         '"description":"Which CLI this agent drives on your machine."'
       ),
       updated_at = datetime('now')
 WHERE config LIKE '%Which CLI this agent drives in tmux.%';
