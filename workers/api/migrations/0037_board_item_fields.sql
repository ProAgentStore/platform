-- Make a board_items row a standalone durable card, not just an overlay on tasks.
-- Snapshot the card's display fields so a job the user moved to a pipeline column
-- (Interview/Offer/Rejected) still renders after its runtime tasks are cleared or
-- age out. Without this, moving a card then clearing finished runs made the card
-- vanish (the board is otherwise derived from tasks).
ALTER TABLE board_items ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE board_items ADD COLUMN subtitle TEXT NOT NULL DEFAULT '';
ALTER TABLE board_items ADD COLUMN url TEXT NOT NULL DEFAULT '';
