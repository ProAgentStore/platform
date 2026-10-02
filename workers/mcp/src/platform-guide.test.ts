import { describe, expect, it } from "vitest";
import { PLATFORM_GUIDE } from "./platform-guide.js";
import { MCP_SERVER_VERSION } from "./server-version.js";
import { SURFACE_LOCK } from "./surface-lock.js";
import { MCP_TOOL_COUNT } from "./tool-count.js";

describe("platform guide discovery diagnostics (#905)", () => {
	it("carries the live identity through a tool already present in older catalogs", () => {
		expect(PLATFORM_GUIDE).toContain(`ProAgentStore version ${MCP_SERVER_VERSION}`);
		expect(PLATFORM_GUIDE).toContain(`schema revision ${SURFACE_LOCK[MCP_SERVER_VERSION]}`);
		expect(PLATFORM_GUIDE).toContain(`${MCP_TOOL_COUNT} tools registered`);
	});

	it("distinguishes legitimate smaller surfaces from missing expected tools", () => {
		expect(PLATFORM_GUIDE).toContain("subscription gating and pinned endpoints can legitimately expose fewer tools");
		expect(PLATFORM_GUIDE).toContain("A smaller count alone does not prove stale discovery");
		expect(PLATFORM_GUIDE).not.toContain("CACHED AND STALE");
		expect(PLATFORM_GUIDE).toContain("mcp_server_info is available on every endpoint");
		expect(PLATFORM_GUIDE).toContain("coding_engine_reauth is published on the platform endpoint only when");
		expect(PLATFORM_GUIDE).toContain("Explicitly refresh the host connection’s tool metadata");
	});
});
