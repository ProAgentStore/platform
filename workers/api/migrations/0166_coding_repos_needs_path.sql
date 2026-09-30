-- A repo binding with no local folder is not "ready" (#883).
--
-- `ready` is read as "the checkout is usable", and every repo read tool (`repo_grep`,
-- `repo_read_file`, `repo_tree`) finds that checkout by `workdir`. A managed clone was stamped
-- `ready` after its first session even though D1 never learned where it lives, so
-- `coding_repos_list` said ready while every read tool refused. Rows already in that state get the
-- distinct `needs_path` status. The API also derives it at read time (`effectiveCloneStatus`), so
-- this is data hygiene rather than the only guard. Only `ready` is rewritten: every other status
-- already says something truer about a folderless row.
UPDATE coding_repos
   SET clone_status = 'needs_path'
 WHERE clone_status = 'ready'
   AND (workdir IS NULL OR trim(workdir) = '');
