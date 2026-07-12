# Skill Publishing

ProAgentStore skills should be published for both Codex and Claude users. The shared unit is the Agent Skills format: a folder with `SKILL.md`, optional `scripts/`, `references/`, and `assets/`.

## Source Of Truth

Keep the canonical skill here:

```text
skills/proagentstore-mcp-operator/
```

That folder follows the open Agent Skills format:

- `SKILL.md` has YAML frontmatter with `name`, `description`, `license`, `compatibility`, and `metadata`.
- The body contains the operating workflow.
- Detailed references or helper scripts should be split into separate files when the skill grows.

The same skill content is copied into platform-specific plugin wrappers:

```text
plugins/codex/proagentstore/skills/proagentstore-mcp-operator/
plugins/claude/proagentstore/skills/proagentstore-mcp-operator/
```

Update all copies together until an automated packaging script owns that step.

## Codex Publishing

Codex treats skills as local authoring units and plugins as the installable distribution unit. Publish ProAgentStore to Codex as a plugin.

Repo files:

```text
.agents/plugins/marketplace.json
plugins/codex/proagentstore/.codex-plugin/plugin.json
plugins/codex/proagentstore/.mcp.json
plugins/codex/proagentstore/skills/proagentstore-mcp-operator/SKILL.md
```

Install from this repo marketplace while developing:

```bash
codex plugin marketplace add ./platform
```

After publishing the repo as the official marketplace source:

```bash
codex plugin marketplace add ProAgentStore/platform
```

Users then install the `proagentstore` plugin from the Codex plugin browser or marketplace.

## Claude Publishing

Claude Code supports standalone skills, but shared distribution should use plugins and marketplaces.

Repo files:

```text
.claude-plugin/marketplace.json
plugins/claude/proagentstore/.claude-plugin/plugin.json
plugins/claude/proagentstore/.mcp.json
plugins/claude/proagentstore/skills/proagentstore-mcp-operator/SKILL.md
```

Install from this repo marketplace while developing:

```text
/plugin marketplace add ./platform
/plugin install proagentstore@proagentstore
/reload-plugins
```

After publishing the repo as the official marketplace source:

```text
/plugin marketplace add ProAgentStore/platform
/plugin install proagentstore@proagentstore
/reload-plugins
```

## MCP Bundling

Both plugin wrappers bundle the deployed ProAgentStore MCP endpoint:

```text
https://mcp.proagentstore.online/mcp
```

Codex wrapper:

```json
{
  "mcpServers": {
    "proagentstore": {
      "url": "https://mcp.proagentstore.online/mcp"
    }
  }
}
```

Claude wrapper:

```json
{
  "mcpServers": {
    "proagentstore": {
      "type": "http",
      "url": "https://mcp.proagentstore.online/mcp"
    }
  }
}
```

OAuth remains per user. Installing the plugin does not give ProAgentStore account access until the user approves the MCP sign-in.

## Discovery Checklist

Every ProAgentStore skill should have:

- A clear `description` that says when the agent should use it.
- A public docs page with install commands for Codex and Claude.
- An entry in `/skills/`.
- An entry in `/skills.json`.
- Coverage in `/llms.txt` and `/llms-full.txt` when it changes the recommended agent workflow.
- A plugin wrapper for Codex.
- A plugin wrapper for Claude.
- A marketplace entry for each ecosystem.
- MCP dependency metadata when the skill performs account actions.
- A changelog entry when the skill changes behavior.
- A smoke test that confirms the MCP server exposes the expected tools.
