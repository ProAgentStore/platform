-- Add gmail_draft_reply and gmail_draft_send to the seeded Gmail agents (#765).
--
-- Both tools are declared on the two agents that already carry the send/reply pair.
-- A declared but unused tool costs one slot in the allowed list — worth the safety
-- affordance: Inbox Chat's own identity.goal already mentions "draft replies in their
-- words", which only works once a draft tool exists.
--
-- gmail_draft_reply (gated by canModify / gmail.modify):
--   Saves a reply to Gmail's Drafts folder; nothing is sent until the owner opens Gmail
--   and clicks Send. Returns a link to the draft. The recipient is taken from the parent
--   message, never from the model — same invariant as gmail_reply.
--
-- gmail_draft_send (gated by canSend / gmail.send):
--   Sends an existing draft by its draft id, returned by gmail_draft_reply.
--   Lets the agent complete the draft-then-send flow without the owner needing to open
--   Gmail at all once they have reviewed and approved.
--
-- Neither tool expands the OAuth scopes requested: gmail.modify was already in the scope
-- list (#716) and gmail.send has been there since #713.

UPDATE agents
SET
  config = json_set(
    config,
    '$.capabilities.tools',
    json('["gmail_search","gmail_read_message","gmail_download_attachment","gmail_reply","gmail_send","gmail_draft_reply","gmail_draft_send","gmail_archive","gmail_mark_read","inspect_pdf_form","fill_pdf_form","build_answer_sheet","upload_file","list_files","read_file","search_knowledge","list_knowledge","read_knowledge"]')
  ),
  updated_at = datetime('now')
WHERE slug = 'inbox-chat';

UPDATE agents
SET
  config = json_set(
    config,
    '$.capabilities.tools',
    json('["gmail_search","gmail_read_message","gmail_download_attachment","gmail_reply","gmail_send","gmail_draft_reply","gmail_draft_send","inspect_pdf_form","fill_pdf_form","build_answer_sheet","upload_file","list_files","read_file","search_knowledge","list_knowledge","read_knowledge"]')
  ),
  updated_at = datetime('now')
WHERE slug = 'email-assistant';
