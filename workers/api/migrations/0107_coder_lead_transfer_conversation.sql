-- The Lead can actually hand you over (#279).
--
-- `697f605` shipped `transfer_conversation` complete on every axis but one: the registry tool with
-- its resolver and its canceled-subscription guard, the field on the chat response, the console's
-- `switchTo` consumer, the spoken "go back", and tests on all of it. `capabilities.tools` is an
-- AUTHORITATIVE allowlist — `toolNamesFor` REPLACES the per-surface default with the declared list
-- — and no agent declared the name, so nothing on the platform could call it. Measured here before
-- writing this: `toolNamesFor(coder-lead's declaration).has("transfer_conversation")` → false,
-- while `delegate_goal` → true.
--
-- This is #415's failure class exactly, three days later and in the same table: the registry half
-- being complete is what makes it invisible. Nothing errors, no test fails, and the agent simply
-- answers conversationally — which is the WORST available outcome for this particular feature,
-- because `convo.ts:205-216` records what that looks like: a reply that CONFIRMS an action nobody
-- performed. A Lead asked to transfer you says something that sounds like it worked, and in
-- hands-free you keep talking to it.
--
-- `coder-lead` ONLY, and it is the whole population: it is the one seeded agent with subordinates,
-- and the tool refuses any destination outside the caller's supervision graph, so declaring it
-- anywhere else would grant a capability that cannot resolve a single target.
--
-- No new gate, deliberately. `transfer_conversation` is `scope:"write"` on the `supervision`
-- connector, so it already sits behind the per-instance write-consent (#90) the Lead needed for
-- `delegate_goal` — "this agent may move me" is opted into once, where everything else is. What
-- bounds it is the channel rather than the grant: the destination rides the response to a chat turn
-- the browser is already awaiting, so there is no response to ride on unless the user just spoke,
-- and the arrival is announced by name and cannot be silenced.
--
-- Shape follows 0101 (which follows 0054): re-set the FULL `$.capabilities` object so the JSON
-- stays one source of truth, idempotent, a no-op where the agent is absent. The object below is
-- 0101's, unchanged, with one name appended — `coder2-parity.test.ts` asserts that every tool the
-- earlier migrations granted survives, because a restated object is one typo from losing
-- delegation.
UPDATE agents
   SET config = json_set(
         COALESCE(NULLIF(config, ''), '{}'),
         '$.capabilities',
         json('{"surfaces":[],"runtime":null,"workflow":null,"tools":["list_subordinates","subordinate_status","delegate_goal","check_delegation","github_list_issues","github_read_issue","github_list_pulls","github_read_pull","transfer_conversation"]}')
       ),
       updated_at = datetime('now')
 WHERE slug = 'coder-lead'
   AND json_valid(COALESCE(NULLIF(config, ''), '{}'));
