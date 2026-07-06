-- Voice replay for the coding Co-pilot: a chat_user turn dictated by voice carries
-- the R2 turn id of its saved recording, so double-tapping the message replays the
-- original audio (survives reload). Nullable — typed turns have none.
ALTER TABLE coding_timeline ADD COLUMN audio_key TEXT;
