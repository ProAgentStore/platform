-- #1346: the deploy job and step that proved a production release note, kept on the queue row so the
-- owner-visible delivery record carries them. `status` is free text; `configuration_required` is a held
-- state for a gate without a deploy job and step.
ALTER TABLE release_note_queue ADD COLUMN evidence_json TEXT;
