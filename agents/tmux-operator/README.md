# tmux Operator

Control tmux sessions on your own machine through ProAgentStore.

## How It Works

1. Subscribe to the agent.
2. Run `pags up` on the machine whose tmux sessions you want to control.
3. Open the agent settings and grant `tmux` write access if you want commands, keypresses, session creation, or kills.
4. Ask the agent to list sessions, read a pane, or run a command in a named session.

The agent uses the local runner relay. tmux output crosses the relay only when a tool reads it; commands run on your machine.

## Tools

- `tmux_list_sessions`
- `tmux_capture_pane`
- `tmux_run_command`
- `tmux_send_keys`
- `tmux_new_session`
- `tmux_kill_session`

Read tools do not require write consent. Write tools require the instance's `tmux` connector write consent.
