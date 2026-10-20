-- #1250: an owner-set display name per physical machine, unique per account.
--
-- A machine's hostname is not its name: macOS renames it per network (`Mac`, `Mac.modem`,
-- `RLs-MacBook-Air.local`…), so one laptop showed up under six names and instances were pinned
-- under four of them. The name lives on `machine_policies`, already keyed by the stable
-- (user_id, machine_id) the CLI mints once, so renaming a machine or its hostname changing never
-- touches it. Unique case-insensitively per owner: a pin given by name must name ONE machine.
ALTER TABLE machine_policies ADD COLUMN display_name TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_machine_policies_display_name
  ON machine_policies(user_id, lower(display_name)) WHERE display_name IS NOT NULL;
