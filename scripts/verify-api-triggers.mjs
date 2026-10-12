#!/usr/bin/env node
/**
 * Read a Worker's triggers back from Cloudflare after a deploy and compare them to its wrangler.toml
 * (#1046) — the explicit answer to "which part of this release is live?". Logic: `lib/verify-triggers.mjs`.
 *
 *   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… node scripts/verify-api-triggers.mjs --cwd workers/api
 *
 * Prints one row per workflow plus the crons, writes them to $GITHUB_STEP_SUMMARY, and exits 1 unless
 * every one is `ok`. A Cloudflare read that keeps failing is `unverified` — red, never assumed fine.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkTriggers, parseWranglerConfig, withRetry } from "./lib/verify-triggers.mjs";

const API = "https://api.cloudflare.com/client/v4";

async function cf(path, token) {
	const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
	if (res.status === 404) return null;
	const body = await res.json().catch(() => null);
	if (!res.ok || !body?.success) throw new Error(`HTTP ${res.status} from ${path.replace(/\/accounts\/[^/]+/, "/accounts/***")}${body?.errors?.[0]?.message ? `: ${body.errors[0].message}` : ""}`);
	return body.result;
}

async function main() {
	const cwdArg = process.argv[process.argv.indexOf("--cwd") + 1];
	if (!process.argv.includes("--cwd") || !cwdArg) throw new Error("usage: verify-api-triggers.mjs --cwd <worker dir>");
	const token = process.env.CLOUDFLARE_API_TOKEN;
	const account = process.env.CLOUDFLARE_ACCOUNT_ID;
	if (!token || !account) throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required");
	const config = parseWranglerConfig(readFileSync(join(resolve(cwdArg), "wrangler.toml"), "utf8"));
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const { ok, rows } = await checkTriggers(config, {
		getWorkflow: (name) => withRetry(() => cf(`/accounts/${account}/workflows/${encodeURIComponent(name)}`, token), { sleep }),
		getSchedules: async () => {
			const result = await withRetry(() => cf(`/accounts/${account}/workers/scripts/${encodeURIComponent(config.name)}/schedules`, token), { sleep });
			if (!result) throw new Error(`Cloudflare has no script ${config.name}`);
			return (result.schedules ?? []).map((s) => s.cron);
		},
	});
	const table = rows.map((r) => `| ${r.trigger} | ${r.state} | ${r.detail} |`).join("\n");
	for (const r of rows) console.log(`${r.state === "ok" ? "✓" : "✗"} ${r.trigger}: ${r.state} — ${r.detail}`);
	const bad = rows.filter((r) => r.state !== "ok").map((r) => `${r.trigger} (${r.state})`);
	const verdict = ok ? `All ${rows.length} triggers of ${config.name} match wrangler.toml.` : `${config.name} triggers do NOT match wrangler.toml: ${bad.join(", ")}. Re-run the deploy.`;
	console.log(ok ? verdict : `::error title=${config.name} triggers::${verdict}`);
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `**Trigger state:** ${verdict}\n\n| Trigger | State | Detail |\n|---|---|---|\n${table}\n\n`);
	process.exitCode = ok ? 0 : 1;
}

main().catch((error) => {
	console.error(`::error title=verify-api-triggers::${error.message}`);
	process.exitCode = 1;
});
