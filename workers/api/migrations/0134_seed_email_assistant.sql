-- Register the first-party "Email Assistant" agent (#710).
--
-- The agent the Gmail and PDF work exists for: read a message someone sent you, fill in the
-- form attached to it, and reply with the completed form attached. Each of those three steps
-- had no implementation before #711 / #712 / #713, and this row is what makes the finished
-- chain reachable to a subscriber rather than only to a hand-edited capabilities blob.
--
-- ── Why it declares these tools and no others ────────────────────────────────
--
-- `capabilities.tools` is an authoritative allowlist, so this list is the agent's whole reach.
-- It gets the five Gmail tools, the three PDF tools, the file tools they hand ids to each
-- other through, and knowledge reads so a subscriber's own documents (a résumé, a membership
-- number, last year's form) ground the answers. It does NOT get knowledge WRITES, collections,
-- or anything coding-related: nothing in this job needs them, and an agent that reads untrusted
-- mail is the last one that should carry tools it has no use for.
--
-- ── The two gates this row deliberately does NOT open ────────────────────────
--
-- Declaring `gmail_reply`/`gmail_send` does not let a subscriber's instance send anything. It
-- still needs the owner's per-agent email permission (AgentState.permissions.email, off by
-- default) AND per-instance write consent on the gmail connector (#90). Both are owner acts in
-- the console, and neither is expressible here — which is the point. Subscribing to this agent
-- grants it nothing until a human turns those on.
--
-- Cloud-only: surfaces [] (chat plus the standard Knowledge tab), runtime null, workflow null.
-- No `pags up`.

INSERT OR IGNORE INTO agents (
  id, owner_id, slug, name, description, category, store_type, icon, icon_bg,
  model, visibility, status, config, created_at, updated_at
) VALUES (
  'agent_email_assistant',
  COALESCE(
    (SELECT owner_id FROM agents WHERE slug = 'data-analyst' AND owner_id LIKE 'google:%' LIMIT 1),
    'system'
  ),
  'email-assistant',
  'Email Assistant',
  'Reads an email you point it at, fills in the form attached to it from what it knows about you, and replies with the completed form attached. Connect Gmail, turn on email permission, and tell it which message to deal with. It never sends anything without your explicit consent switched on first.',
  'productivity',
  'agent',
  '📧',
  '#0b0b0f',
  'claude-sonnet-4-6',
  'published',
  'active',
  json('{"capabilities":{"surfaces":[],"runtime":null,"workflow":null,"tools":["gmail_search","gmail_read_message","gmail_download_attachment","gmail_reply","gmail_send","inspect_pdf_form","fill_pdf_form","build_answer_sheet","upload_file","list_files","read_file","search_knowledge","list_knowledge","read_knowledge"]},"identity":{"personality":"You handle the user''s correspondence carefully and literally. You read what was actually sent, you use only facts the user has given you, and when a form asks for something you do not know you ASK rather than invent it. You are working in someone else''s name, so you would rather check than guess.","goal":"Deal with an email the user points you at: read it and anything attached, work out what is being asked for, fill in any form using the user''s own details from their documents and knowledge base, and — once the user has approved — reply to the sender with the completed form attached.","guardrails":{"responseStyle":"","topicRestrictions":"","blockedTerms":[],"maxResponseLength":0,"requireCitations":false},"welcomeMessage":"Connect Gmail in Preferences, switch on email permission for me in Settings, then tell me which message to look at — a sender and a subject is enough. I will read it, tell you what it is asking for, and show you the reply before anything is sent."}}'),
  datetime('now'),
  datetime('now')
);
