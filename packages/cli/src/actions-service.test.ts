import { describe, expect, it } from "vitest";
import { actionsServiceContent, actionsServiceLabel, actionsServicePlist, serviceForPlist } from "./actions-service.js";
import type { ServiceContext } from "./service-install.js";

const dir = "/Users/serge/.proagentstore/actions-runner/proappstore-online";
const ctx: ServiceContext = { platform: "darwin", home: "/Users/serge", user: "serge", uid: 501, nodePath: "/old/nvm/node", script: "/opt/homebrew/lib/node_modules/@proagentstore/cli/dist/bootstrap.js", configDir: "/Users/serge/.config/proagentstore", pathEnv: "/opt/homebrew/bin:/usr/bin" };

describe("macOS Actions system service (#1209)", () => {
	it("starts the PAGS supervisor as the owner, with a stable bootstrap and no token or pinned Node binary", () => {
		const plist = actionsServiceContent(dir, ctx);
		expect(plist).toContain("<key>UserName</key><string>serge</string>");
		expect(plist).toContain("<string>actions</string><string>supervise</string><string>--dir</string>");
		expect(plist).toContain("<key>ACTIONS_RUNNER_SVC</key><string>1</string>");
		expect(plist).toContain("/usr/bin/env</string><string>node");
		expect(plist).not.toContain("/old/nvm/node");
		expect(plist).not.toContain("--token");
	});

	it("recognizes the exact existing tiny/pink system plist and refuses unrelated scopes", () => {
		const old = { Label: "actions.runner.proappstore-online.pags-tiny-laptop", WorkingDirectory: dir, ProgramArguments: [`${dir}/runsvc.sh`] };
		expect(serviceForPlist("/Library/LaunchDaemons/actions.runner.proappstore-online.pags-tiny-laptop.plist", old, dir, 501)).toMatchObject({ domain: "system", owned: false });
		expect(serviceForPlist("/Library/LaunchDaemons/other.plist", old, "/Users/serge/.proagentstore/actions-runner/other", 501)).toBeNull();
		expect(serviceForPlist(actionsServicePlist(dir), { ...old, Label: actionsServiceLabel(dir) }, dir, 501)).toMatchObject({ owned: true });
	});
});
