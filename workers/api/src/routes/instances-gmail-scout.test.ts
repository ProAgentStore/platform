import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { requireGmailScoutInstance } from "./instances-gmail-scout.js";

const envWithTemplate = (config: string) => ({
	DB: { prepare: () => ({ bind: () => ({ first: async () => ({ config }) }) }) },
}) as never;

describe("Gmail Scout route gate", () => {
	it("refuses an owned instance that is not the dedicated Gmail source", async () => {
		await expect(requireGmailScoutInstance(envWithTemplate("{}"), { agent_id: "ordinary", config: "{}" }))
			.rejects.toMatchObject({ status: 409 } satisfies Partial<HttpError>);
	});

	it("accepts the Gmail source declaration copied onto an instance", async () => {
		await expect(requireGmailScoutInstance(envWithTemplate("{}"), { agent_id: "gmail-scout", config: '{"source_mode":"gmail"}' })).resolves.toBeUndefined();
	});
});
