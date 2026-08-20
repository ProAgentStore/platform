-- Register the first-party "Inbox Chat" agent (#716).
--
-- A conversational agent for the mailbox itself: ask what has arrived, ask what one message
-- says, dictate a reply, archive what is dealt with. Distinct from the Email Assistant (0134),
-- which is a task pipeline — read a message, fill the form attached to it, reply with it. Same
-- connector, different job, so a different agent rather than a wider one: an agent whose
-- description promises two unrelated things ends up doing neither predictably.
--
-- ── What it can and cannot do ───────────────────────────────────────────────
--
-- It gets the read tools, both send tools, and the two ACTION tools (#716). It does not get the
-- PDF tools — filling a form is the other agent's job — and it does not get knowledge writes,
-- collections or anything coding-related.
--
-- There is no delete. `gmail.modify` would allow moving mail to Trash, and no tool exposes it:
-- archiving is reversible (the message stays in All Mail), deleting is a different promise, and
-- an agent that reads untrusted mail should not be one prompt injection away from emptying an
-- inbox. Permanent deletion is not even reachable — it needs https://mail.google.com/, which this
-- codebase never requests.
--
-- ── Three gates still stand, and a seed opens none of them ──────────────────
--
-- Declaring gmail_reply or gmail_archive grants nothing on its own. Sending or archiving needs
-- the owner's per-agent email permission (off by default), per-instance write consent on the
-- gmail connector (#90), AND — for the action tools — an account that was actually granted the
-- manage-mail scope, which Google's consent screen lets a person decline. All three are owner
-- acts and none is expressible here.
--
-- Cloud-only: surfaces [] , runtime null, workflow null. No `pags up`.

INSERT OR IGNORE INTO agents (
  id, owner_id, slug, name, description, category, store_type, icon, icon_bg,
  model, visibility, status, config, created_at, updated_at
) VALUES (
  'agent_inbox_chat',
  COALESCE(
    (SELECT owner_id FROM agents WHERE slug = 'data-analyst' AND owner_id LIKE 'google:%' LIMIT 1),
    'system'
  ),
  'inbox-chat',
  'Inbox Chat',
  'Talk to your inbox. Ask what has come in, what a message actually says, and who is waiting on you — then dictate a reply in your own words, or archive what you have dealt with. It never sends or archives anything until you have seen exactly what it is about to do.',
  'productivity',
  'agent',
  '📬',
  '#0b0b0f',
  'claude-sonnet-4-6',
  'published',
  'active',
  json('{"capabilities":{"surfaces":[],"runtime":null,"workflow":null,"tools":["gmail_search","gmail_read_message","gmail_download_attachment","gmail_reply","gmail_send","gmail_archive","gmail_mark_read","list_files","read_file","search_knowledge","list_knowledge","read_knowledge"]},"identity":{"personality":"You are a calm, plain-spoken assistant for someone else''s inbox. You summarise what is actually in a message rather than what its subject line implies, you say who is waiting on a reply and what they asked for, and you never guess at a fact you have not read. When you draft a reply you write in the user''s own voice from what they told you to say — you do not invent commitments, dates or numbers on their behalf.","goal":"Help the user get through their mail by conversation: find and summarise messages, explain what one actually says and what it is asking for, draft replies in their words, and — only once they have approved — send or archive.","guardrails":{"responseStyle":"","topicRestrictions":"","blockedTerms":[],"maxResponseLength":0,"requireCitations":false},"welcomeMessage":"Connect Gmail in Preferences and switch on email permission for me in Settings, then just ask — what came in today, what does the one from the school say, reply saying I can do Thursday. I will show you anything before it is sent or archived."}}'),
  datetime('now'),
  datetime('now')
);
