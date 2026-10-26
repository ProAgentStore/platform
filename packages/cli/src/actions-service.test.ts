import { describe, expect, it } from "vitest";
import { actionsServiceContent, actionsServiceLabel, actionsServicePlist, activeProcessIn, assertOwnedRemovalService, preflightActionsServiceLaunch, serviceForPlist, waitListenerGone } from "./actions-service.js";
import type { ServiceContext } from "./service-install.js";

const dir = "/Users/serge/.proagentstore/actions-runner/proappstore-online";
const ctx: ServiceContext = { platform: "darwin", home: "/Users/serge", user: "serge", uid: 501, nodePath: "/old/nvm/node", script: "/opt/homebrew/lib/node_modules/@proagentstore/cli/dist/bootstrap.js", configDir: "/Users/serge/.config/proagentstore", pathEnv: "/opt/homebrew/bin:/usr/bin" };

describe("macOS Actions system service (#1209)", () => {
	it("proves launchd's captured PATH can run the durable CLI before adoption", () => {
		const probe = { exists: () => true, run: (_file: string, _args: string[], _env: NodeJS.ProcessEnv) => 0 };
		preflightActionsServiceLaunch(ctx, probe);
		expect(() => preflightActionsServiceLaunch({ ...ctx, pathEnv: ":/usr/bin" }, probe)).toThrow(/PATH/);
		expect(() => preflightActionsServiceLaunch({ ...ctx, script: "/Users/serge/.config/proagentstore/cli/0.4.185/dist/bootstrap.js" }, probe)).toThrow(/versioned CLI payload/);
		expect(() => preflightActionsServiceLaunch(ctx, { ...probe, exists: () => false })).toThrow(/bootstrap is missing/);
		expect(() => preflightActionsServiceLaunch(ctx, { ...probe, run: () => 1 })).toThrow(/could not run/);
	});
	it("starts the PAGS supervisor as the owner, with a stable bootstrap and no token or pinned Node binary", () => {
		const plist = actionsServiceContent(dir, ctx);
		expect(plist).toContain("<key>UserName</key><string>serge</string>");
		expect(plist).toContain("<string>actions</string><string>supervise</string><string>--dir</string>");
		expect(plist).toContain("<key>ACTIONS_RUNNER_SVC</key><string>1</string>");
		expect(plist).toContain("/usr/bin/env</string><string>node");
		expect(plist).not.toContain("/old/nvm/node");
		expect(plist).not.toContain("--token");
		expect(plist).not.toContain("StandardOutPath");
		expect(plist).not.toContain("StandardErrorPath");
	});

	it("recognizes the exact existing tiny/pink system plist and refuses unrelated scopes", () => {
		const old = { Label: "actions.runner.proappstore-online.pags-tiny-laptop", WorkingDirectory: dir, ProgramArguments: [`${dir}/runsvc.sh`] };
		expect(serviceForPlist("/Library/LaunchDaemons/actions.runner.proappstore-online.pags-tiny-laptop.plist", old, dir, 501)).toMatchObject({ domain: "system", owned: false });
		expect(serviceForPlist("/Library/LaunchDaemons/other.plist", old, "/Users/serge/.proagentstore/actions-runner/other", 501)).toBeNull();
		expect(serviceForPlist(actionsServicePlist(dir), { ...old, Label: actionsServiceLabel(dir) }, dir, 501)).toMatchObject({ owned: true });
	});

	it("refuses to remove a legacy service before any stop or deletion", () => {
		expect(() => assertOwnedRemovalService({ path: "/Library/LaunchDaemons/actions.runner.legacy.plist", label: "actions.runner.legacy", domain: "system", owned: false })).toThrow(/not a PAGS-generated Actions service/);
		expect(() => assertOwnedRemovalService({ path: actionsServicePlist(dir), label: actionsServiceLabel(dir), domain: "system", owned: true })).not.toThrow();
	});

	it("refuses unknown process inventory or cwd instead of treating a worker as idle", () => {
		expect(activeProcessIn(dir, "Runner.Worker", () => ({ status: 1, stdout: "" }))).toEqual([]);
		expect(() => activeProcessIn(dir, "Runner.Worker", () => ({ status: 2, stdout: "" }))).toThrow(/Could not inspect/);
		expect(() => activeProcessIn(dir, "Runner.Worker", (file) => file === "pgrep" ? { status: 0, stdout: "123" } : { status: 1, stdout: "" }, () => true)).toThrow(/Could not inspect/);
		expect(activeProcessIn(dir, "Runner.Listener", (file) => file === "pgrep" ? { status: 0, stdout: "123" } : { status: 0, stdout: `p123\nfcwd\nn${dir}\n` }, () => true)).toEqual([123]);
	});

	it("waits for the exact prior listener to exit before starting a replacement", async () => {
		let scans = 0;
		await waitListenerGone(dir, 1000, () => ++scans === 1 ? [123] : [], async () => undefined);
		expect(scans).toBe(2);
		await expect(waitListenerGone(dir, 1, () => [123], async () => new Promise((resolve) => setTimeout(resolve, 2)))).rejects.toThrow(/remained active/);
	});
});
