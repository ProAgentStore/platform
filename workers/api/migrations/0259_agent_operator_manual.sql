-- #1237: an operator manual on the agent TEMPLATE, inherited by every instance of it.
--
-- The instance manual (0143, #739) has to be copied onto each instance by hand, so a fleet-wide
-- operating standard (every Repo Coder's checkout layout, say) drifted across ~30 instances. This
-- one is written once on the template and read LIVE by every instance's operator-manual read, so an
-- edit reaches existing and future instances on their next read, with no resync. The instance's own
-- manual stays, as an addendum shown after it. A named column rather than config, like the instance
-- one, so template listings never carry it.
ALTER TABLE agents ADD COLUMN operator_manual TEXT;
