-- #719: Inbox Chat may PROPOSE Gmail filters — each one approved by the owner.
--
-- Owner decision 2026-10-14: filter creation only with explicit per-action owner approval.
-- `gmail_create_filter` never creates a filter on its own: every call becomes an approval card
-- (the tool declares `approval.everyCall`, so even "Always allow" write access queues it), the
-- card names the mailbox, the exact rule, the actions, the reason and that it applies to all
-- future mail, and forwarding / trash / delete / spam filters are refused at the tool boundary.
-- See docs/adr/0007. It needs the optional "Create filters" Gmail grant (gmail.settings.basic),
-- which no connection holds until its owner chooses it.
--
-- Declared on Inbox Chat only — the agent that already tidies the inbox (archive, mark read) and
-- is the one asked "make these skip the inbox". Not on Email Assistant, which does not tidy.
--
-- 0142's list plus the one tool. Applied only while the list is still exactly 0142's, so a list
-- changed since (through the creator tools) is left as it is rather than overwritten.

UPDATE agents
SET
  config = json_set(
    config,
    '$.capabilities.tools',
    json('["gmail_search","gmail_read_message","gmail_download_attachment","gmail_reply","gmail_send","gmail_draft_reply","gmail_draft_send","gmail_archive","gmail_mark_read","gmail_create_filter","inspect_pdf_form","fill_pdf_form","build_answer_sheet","upload_file","list_files","read_file","search_knowledge","list_knowledge","read_knowledge"]')
  ),
  updated_at = datetime('now')
WHERE slug = 'inbox-chat'
  AND json_extract(config, '$.capabilities.tools') = json('["gmail_search","gmail_read_message","gmail_download_attachment","gmail_reply","gmail_send","gmail_draft_reply","gmail_draft_send","gmail_archive","gmail_mark_read","inspect_pdf_form","fill_pdf_form","build_answer_sheet","upload_file","list_files","read_file","search_knowledge","list_knowledge","read_knowledge"]');
