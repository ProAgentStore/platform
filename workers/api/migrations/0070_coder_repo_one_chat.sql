-- One chat per agent: the configurable Repo Coder loses its Co-pilot (#209).
--
-- Nine of the platform's eleven agent types already have exactly one chat — apply, repo-chat,
-- site-builder, local-repo-chat, doc-chat, language-buddy, the pipeline agents. The two exceptions
-- are the Coders, and only because the hardcoded one shipped that way and Coder 2 inherited the
-- component. It was never a decision.
--
-- The Co-pilot exists to translate terminal output into English. That was right when the pane held
-- a compiler; it holds Claude Code, so it is a model paid to summarise a model whose output is
-- already English. Its one genuinely useful trick — grounding an answer in read_file / git_diff /
-- list_issues before speaking — is not a brain, it is TOOLS, and the registry already publishes
-- every one of them. `lib/connectors/repo-local.ts` says so in its own header: it calls "the same
-- read-only, traversal-guarded, byte-capped" runner endpoints the Co-pilot uses. We built the same
-- tools twice.
--
-- So: the capability moves to the ONE chat, and the second chat is declared away.
--
--   copilot:false      → no Co-pilot view, no /explain route, terminal-only Coding tab
--   repo_* + github_* reads → the Assistant can inspect code and the backlog
--
-- The terminal needs no tool: `agent-think.ts` already pulls a FRESH capture of every active
-- session's pane into the chat's context on every turn (falling back to the last snapshot when the
-- runner is offline). Declaring tmux_capture_pane would be a THIRD copy of a capability the chat
-- already has, and it would need a tmux session name the chat is never told. Not adding a tool for
-- something that already works is the same discipline that makes this migration possible at all.
--
-- The legacy hardcoded `coder` is deliberately NOT touched: it declares nothing, `copilot`
-- defaults true, and its behaviour is byte-for-byte what it was. The difference between the two
-- Coders is now DATA, which is the whole point of the capability registry.
--
-- Read tools only. `drive:false` already says a Repo Coder's chat may not steer its engine — its
-- Lead does that — so tmux_run_command / tmux_send_keys are deliberately absent.
UPDATE agents
   SET config = json_set(
         json_set(
           config,
           '$.capabilities.surfaceOptions.coding.copilot', json('false')
         ),
         '$.capabilities.tools',
         json('["repo_tree","repo_read_file","repo_git","repo_remote","github_list_issues","github_read_issue","github_create_issue"]')
       ),
       updated_at = datetime('now')
 WHERE slug = 'coder-repo' AND config IS NOT NULL AND json_valid(config);
