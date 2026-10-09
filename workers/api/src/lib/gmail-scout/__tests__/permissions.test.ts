import { describe, expect, it } from "vitest";
import { agentCapabilities } from "../../agent-capabilities.js";
import { realSchemaD1 } from "../../d1-sqlite.js";
import { GMAIL_SCOUT_CAPABILITY, GMAIL_SCOUT_SOURCE_MODE, GMAIL_SCOUT_TOOLS } from "../config.js";

describe("Gmail Scout permissions", () => {
	it("subscribes a declared Gmail source whose actual capability is exactly the two read tools", () => {
		const d1 = realSchemaD1();
		try {
			const row = d1.sqlite.prepare("SELECT config FROM agents WHERE slug = 'gmail-job-search-scout'").get() as { config?: string } | undefined;
			if (!row?.config) throw new Error("Gmail Scout seed config is missing");
			const config = JSON.parse(row.config) as { source_mode?: string };
			const capabilities = agentCapabilities({ slug: "gmail-job-search-scout", config: row.config });
			expect(config.source_mode).toBe(GMAIL_SCOUT_SOURCE_MODE);
			expect(capabilities.tools).toEqual([...GMAIL_SCOUT_TOOLS]);
			expect(GMAIL_SCOUT_CAPABILITY).toEqual({ connector: "gmail", readOnly: true, tools: GMAIL_SCOUT_TOOLS });
			expect(capabilities.tools).not.toContain("gmail_send");
			expect(capabilities.tools).not.toContain("gmail_modify");
		} finally {
			d1.close();
		}
	});
});
