-- Extended user profiles for developer pages
ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN website TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN twitter TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
