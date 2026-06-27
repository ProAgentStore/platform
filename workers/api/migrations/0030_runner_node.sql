-- Machine hostname so the console shows which computer is (or was) connected.
ALTER TABLE instance_runtimes ADD COLUMN runner_node TEXT NOT NULL DEFAULT '';
