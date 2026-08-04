import { describe, expect, it } from "vitest";
import { buildAgentToolDefinitions } from "../agent-do-tools.js";
import { agentCapabilities } from "../lib/agent-capabilities.js";
const CONFIG = JSON.stringify({
  capabilities: { surfaces: [], runtime: "coding", workflow: null, tools: ["repo_tree","repo_read_file","repo_git","repo_remote"] },
});
describe("probe", () => {
  it("builds defs", () => {
    const caps = agentCapabilities({ slug: "local-repo-chat", category: "developer-tools", config: CONFIG });
    console.log("caps.tools:", JSON.stringify(caps.tools));
    const defs = buildAgentToolDefinitions({ capabilities: caps });
    console.log("DEFS:", defs.map((d) => d.function.name).sort().join(","));
    expect(defs.some((d) => d.function.name === "repo_tree")).toBe(true);
  });
});
