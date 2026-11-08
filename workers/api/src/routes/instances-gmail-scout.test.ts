import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/auth.js";
import { isGmailScoutInstance } from "../lib/gmail-scout/config.js";
import { requireGmailScoutInstance } from "./instances-gmail-scout.js";

const envWithConfigs = (instance_config: string, agent_config: string) => ({
	DB: { prepare: () => ({ bind: () => ({ first: async () => ({ instance_config, agent_config }) }) }) },
}) as never;

describe("Gmail Scout route gate", () => {
	it("refuses an owned instance that is not the dedicated Gmail source", async () => {
		await expect(requireGmailScoutInstance(envWithConfigs("{}", "{}"), { id: "i" }))
			.rejects.toMatchObject({ status: 409 } satisfies Partial<HttpError>);
	});

	it("accepts the Gmail source declaration copied onto an instance", async () => {
		await expect(requireGmailScoutInstance(envWithConfigs('{"source_mode":"gmail"}', "{}"), { id: "i" })).resolves.toBeUndefined();
	});

	it("accepts the Gmail source declaration on the agent, not the instance", async () => {
		await expect(requireGmailScoutInstance(envWithConfigs("{}", '{"source_mode":"gmail"}'), { id: "i" })).resolves.toBeUndefined();
	});
});

describe("isGmailScoutInstance (#1591) — the one resolver", () => {
	it("is true for source mode from instance config and from agent config, false otherwise", async () => {
		expect(await isGmailScoutInstance(envWithConfigs('{"source_mode":"gmail"}', "{}"), "i")).toBe(true);
		expect(await isGmailScoutInstance(envWithConfigs("{}", '{"source_mode":"gmail"}'), "i")).toBe(true);
		expect(await isGmailScoutInstance(envWithConfigs("{}", "{}"), "i")).toBe(false);
		expect(await isGmailScoutInstance(envWithConfigs("not json", '{"source_mode":"other"}'), "i")).toBe(false);
	});
	it("is false for an instance that does not exist", async () => {
		const missing = { DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } } as never;
		expect(await isGmailScoutInstance(missing, "i")).toBe(false);
	});
});
