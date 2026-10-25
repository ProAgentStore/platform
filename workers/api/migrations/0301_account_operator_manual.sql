-- #1238: an ACCOUNT-level operator manual - operating standards that apply to every template an owner runs
-- (the machine map, main-only with no PRs, the home-relative checkout layout).
--
-- #1237 put a manual on the agent template, so a standard that spans several templates still had to be copied
-- into each one and drifted the same way. This one belongs to the OWNER of the instance (the subscriber), never
-- to a template's creator: a creator's account manual must not reach other people's instances. It is read LIVE by
-- every instance's operator-manual read, first in the precedence order account -> template -> instance, so an
-- edit reaches every instance the owner runs on its next read.
--
-- A table of its own rather than `users.preferences` JSON: these manuals are kept off payloads that carry
-- config wholesale (0143 / #739 Decision 2), and the preferences blob is exactly such a payload.
CREATE TABLE IF NOT EXISTS account_operator_manuals (
  user_id    TEXT PRIMARY KEY REFERENCES users(id),
  manual     TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
