-- Fold form-filling into Inbox Chat, so one agent covers the mailbox (#716).
--
-- 0134 seeded Email Assistant (read a message, fill the form attached, reply with it) and 0136
-- seeded Inbox Chat (converse with the mailbox, archive, mark read). The split was defensible on
-- paper — 0136's own comment argues "an agent whose description promises two unrelated things
-- ends up doing neither predictably" — and wrong in the console, where the person who wanted an
-- email agent now had two and had to know which did what.
--
-- They were never unrelated. Both start by reading a message someone sent you; one then answers
-- it, the other fills what was attached to it first. That is one job with a longer tail.
--
-- So Inbox Chat gains the three PDF tools and says so in its description. Email Assistant stays
-- published for anyone who wants only the narrow pipeline, but it is no longer the answer to
-- "give me an agent for my email" — this one is.

UPDATE agents
SET
  description = 'Talk to your inbox. Ask what has come in, what a message actually says, and who is waiting on you — then dictate a reply in your own words, archive what you have dealt with, or fill in a form that arrived attached and send it back. It never sends or archives anything until you have seen exactly what it is about to do.',
  config = json_set(
    config,
    '$.capabilities.tools',
    json('["gmail_search","gmail_read_message","gmail_download_attachment","gmail_reply","gmail_send","gmail_archive","gmail_mark_read","inspect_pdf_form","fill_pdf_form","build_answer_sheet","upload_file","list_files","read_file","search_knowledge","list_knowledge","read_knowledge"]')
  ),
  updated_at = datetime('now')
WHERE slug = 'inbox-chat';
