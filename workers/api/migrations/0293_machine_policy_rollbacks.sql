-- #1150: the releases a machine's bootstrap stub gave up on (crash on start, no registration, crash loop), kept on the
-- machine's record. A rollback was only ever the transient `last_error` of one report; this is the durable list the machine
-- page shows — JSON [{from, to, reason, at}] as the runner reports it, [] when it has none, NULL when it never said
-- (an older runner). Replaced wholesale by each report that carries it, so an owner's retry that clears the mark clears it here.
ALTER TABLE machine_policies ADD COLUMN rollbacks TEXT;
