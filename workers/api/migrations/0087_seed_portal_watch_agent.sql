-- Portal Watch — the first-party browser-task catalog agent (#73, epic #69).
--
-- WHY THIS AGENT AND NOT THE ONE THE TICKET DESCRIBES.
--
-- #73 asked for a general "point it at any URL with an objective" agent. Everything needed to
-- build one already landed (#70 engine, #71 BrowserTaskWorkflow, #72 /browse + browser.task),
-- so the remaining question was not "can we" but "should the storefront carry it". Three things
-- said no:
--
--   1. A free-text objective box is not a promise. A catalog listing has to say what it will do
--      for you; "whatever you type" is a text field, and nobody subscribes to a text field. It
--      is also unreviewable — there is no version of "any objective on any site" that a reader
--      can decide is safe before spending tokens on it.
--   2. The catalog already HAS the ticket's own example. `facebook-friend-confirmer` is a
--      published browser-task agent that accepts friend requests. A second, blanker version of
--      it is a duplicate, and epic #69's own non-goals rule out exactly that shape of work
--      ("mass-action automation", "arbitrary-domain autonomy without approval").
--   3. #58's strategy is mature-first-party-then-open. Maturity here means the agent is good,
--      not that the engine is reachable.
--
-- So this is the narrow version: ONE web task that is genuinely worth someone else's money.
--
-- THE TASK. A lot of what you need to know is only readable after you log in — the energy
-- account, council rates, an insurance renewal, a visa or case status, a supplier or school
-- portal. These have no API, no useful email, and no way for a server-side connector to reach
-- them, because the thing that grants access is a session in a browser on YOUR machine. That is
-- precisely the intersection where the browser runtime is the only tool that works, and it is a
-- recurring chore rather than a demo. Pair it with a `run_browse` cron trigger and it is the
-- unattended version of a thing people currently do by hand every month.
--
-- READ-ONLY IS THE PRODUCT, NOT A LIMITATION. `config.browserTask.readOnly` is read from THIS
-- row and nowhere else — never from a request body, a trigger config or the instance config —
-- and the workflow's act layer refuses every committing click before it reaches the page. So
-- the agent cannot pay, submit, send, delete or change a setting even if the model decides to,
-- even if a subscriber asks it to, and even if hostile text on the page tells it to. That is
-- what makes it sane to point at a real account holding real money, and it is the same
-- fixed-at-declaration-time principle an actionable ticket uses for its action.
--
-- Two honest limits, stated because a safety claim nobody can check is worth nothing:
--   • The guard is on committing CLICKS. Typing and Enter are not blocked (a watcher needs a
--     search box), so the guarantee is "it cannot click Pay", not a formal sandbox.
--   • It is deliberately fail-safe, so a filter button literally labelled "Apply" is refused
--     too. Refusing a harmless click is the cheap error; performing a harmful one is not.
--
-- 100% DECLARATIVE. There is no portal-watch code anywhere in the monorepo — no Worker, no
-- pipeline, no slug in a conditional. The agent is this row: declared capabilities (#141) pick
-- the browser runtime and the BROWSER_TASK brain, `settingsSchema` (0041) carries the two things
-- that differ per subscriber, `browserTask.startUrlSetting` names which of those settings is the
-- start URL, and `identity.goal` IS the objective the workflow runs. Anyone can stamp out a
-- sibling (a shipment tracker, a case-status watcher) by inserting another row.
--
-- The three handoffs come from the shared engine, unchanged: a sign-in screen, 2FA or captcha
-- pauses the run and hands the live browser over; a widget it cannot operate becomes a one-step
-- human takeover; a value it was not given becomes ask-and-hold instead of a fabricated answer.
--
-- Seeded under the operator account, matching every other first-party catalog agent (see 0033).

INSERT OR IGNORE INTO agents (
  id, owner_id, slug, name, description, category, store_type, icon, icon_bg,
  model, visibility, status, config, created_at, updated_at
) VALUES (
  'agent_portal_watch',
  COALESCE((SELECT owner_id FROM agents WHERE slug = 'data-analyst' AND owner_id LIKE 'google:%' LIMIT 1), 'system'),
  'portal-watch',
  'Portal Watch',
  'Keeps an eye on the accounts that only tell you things after you log in — energy and water, council rates, an insurance renewal, a visa or case status, a supplier or school portal. It opens the page in your own signed-in browser on your own machine (run `pags up`), reads what it currently says, and writes the actual figures, dates and statuses down in plain language. Put it on a schedule and it does the monthly round for you. It can only ever look: the runtime blocks every Pay, Submit, Send, Delete and Confirm before the click reaches the page, so it is safe to point at a real account. A login, two-factor prompt or captcha pauses the run and hands you the live browser; anything it was not told, it asks for instead of guessing.',
  'productivity',
  'agent',
  '🔎',
  '#0b0b0f',
  'claude-sonnet-4-6',
  'published',
  'active',
  json('{
    "capabilities": {
      "surfaces": [],
      "runtime": "browser",
      "workflow": "BROWSER_TASK",
      "tools": ["search_knowledge", "list_knowledge", "read_knowledge", "add_knowledge"]
    },
    "browserTask": { "readOnly": true, "startUrlSetting": "portal_url" },
    "settingsSchema": [
      {
        "id": "portal_url",
        "label": "Page to check",
        "type": "text",
        "description": "The exact page you land on when you want this information — paste it from your browser while signed in. One agent per account; subscribe again for another portal.",
        "default": ""
      },
      {
        "id": "what_to_report",
        "label": "What to report",
        "type": "text",
        "description": "The figures, dates or statuses you want back each time, in your own words — e.g. \"the current balance, the due date, and whether the last payment went through\".",
        "default": "Whatever this page is currently telling me: the headline figures, any amount owing, any date coming up, and anything flagged as needing attention."
      }
    ],
    "identity": {
      "personality": "You are the person who checks the accounts so nobody else has to. You read carefully, you write down the actual numbers rather than describing them, and you never pretend to have seen something you did not. You are incurious about everything except what you were asked for.",
      "goal": "Open the page named in the Settings below and report what it says right now.\n\nGetting in: if a sign-in screen, security check or two-factor prompt appears, do nothing at all — the system pauses and hands the browser to the person who owns the account, and the run continues once they are through. Never try to sign in yourself.\n\nReading it: find the figures, dates and statuses listed under \"What to report\". If the number you were asked for lives one click away — a statement, a bill, a case detail, an orders tab — open that page, read it, and come back. Stay on this site; never follow a link off it.\n\nReporting: call finish(status:\"done\") with the ACTUAL values in the detail — \"Balance $184.20, due 3 September, last payment $90.00 received 12 August\" — never \"I checked the account\". That detail is the entire report the person reads; nothing else you do is visible to them. If something you were asked for was not on the page, say so plainly in the same report rather than guessing at it.\n\nYou are here to look, not to act. If the only way to finish would be to change something, stop and say what it would have been.",
      "guardrails": {
        "responseStyle": "concise",
        "topicRestrictions": "",
        "blockedTerms": [],
        "maxResponseLength": 0,
        "requireCitations": false
      },
      "welcomeMessage": "Paste the page you want watched into Settings → Page to check, say what you want reported, then run `pags up` on the machine where you are signed in. Hit Run on the Board and I will read it and tell you what it says. Add a schedule under Triggers and I will do the round on my own. I only ever read — I cannot pay, send or change anything."
    }
  }'),
  datetime('now'), datetime('now')
);
