// `pags machines` — see what PAGS thinks your machines are, and claim a name this one has used.
//
// The first-run prompt in `pags up` (#460) is the remedy that finds the user; this is the one they
// can be TOLD about. It is not a substitute — the whole defect is that the remedy was invisible —
// but it is the only route on a box where the prompt can never fire: `--headless`, a service, CI,
// or any machine with no keyboard attached. Same rules, same refusals, no guessing.
import { Command } from "commander";
import { requireSession } from "./login.js";
import { writeError, writeLine } from "../output.js";
import {
	describeCandidate,
	fetchNodeSummaries,
	type NodeSummary,
	resolveClaimByName,
} from "../machine-claim.js";
import { loadMachineIdentity, machineFilePath, saveMachineIdentity, withClaimedNames } from "../machine.js";

const API_BASE = "https://api.proagentstore.online";

async function loadNodes(token: string): Promise<NodeSummary[]> {
	const nodes = await fetchNodeSummaries({ token, apiBase: API_BASE });
	if (!nodes) {
		writeError("Could not reach ProAgentStore to list your machines.");
		process.exit(1);
	}
	return nodes;
}

const listCommand = new Command("list")
	.description("List the machines ProAgentStore has seen on this account")
	.action(async () => {
		const session = requireSession();
		const nodes = await loadNodes(session.token);
		const identity = loadMachineIdentity();
		writeLine("");
		writeLine(`  This machine: ${identity.names[0] ?? "unknown"}  ${identity.id ? `(id ${identity.id})` : "(no id — check that ~/.config/proagentstore/ is writable)"}`);
		if (identity.names.length > 1) writeLine(`  Also claims: ${identity.names.slice(1).join(", ")}`);
		writeLine("");
		if (!nodes.length) writeLine("  No machines registered yet — run `pags up`.");
		const now = Date.now();
		for (const n of nodes) {
			const owner = n.machineId ? (n.machineId === identity.id ? "this machine" : "claimed") : "unclaimed";
			writeLine(`  ${n.node}`);
			writeLine(`      ${describeCandidate(n, now)} · ${n.connected ? "connected" : "offline"} · ${owner}`);
		}
		writeLine("");
		writeLine("  Claim a name this machine has used before:  pags machines claim <name>");
		writeLine("");
	});

const claimCommand = new Command("claim")
	.description("Record that a machine name on this account is THIS machine")
	.argument("<name...>", "Node name(s) to claim, as shown by `pags machines list`")
	.action(async (names: string[]) => {
		const session = requireSession();
		const identity = loadMachineIdentity();
		if (!identity.id) {
			writeError("This machine has no id — `~/.config/proagentstore/` is not writable, so a claim could not be sent.");
			process.exit(1);
		}
		const nodes = await loadNodes(session.token);
		const { claim, problems } = resolveClaimByName(names, nodes, identity);
		for (const p of problems) writeError(`  ✗ ${p}`);
		if (!claim.length) {
			// Refusing loudly. A "claim" that reports success while stamping nothing is the exact
			// invisible no-op #393 was reported as.
			writeError("  Nothing claimed.");
			process.exit(problems.length ? 1 : 0);
		}
		if (!saveMachineIdentity(withClaimedNames(identity, claim))) {
			writeError(`  ✗ Could not write ${machineFilePath()} — nothing claimed.`);
			process.exit(1);
		}
		writeLine(`  ✓ Claimed ${claim.join(", ")}. Restart \`pags up\` to merge them onto this machine.`);
	});

export const machinesCommand = new Command("machines")
	.description("Show and claim the machine names ProAgentStore has for this account")
	.addCommand(listCommand, { isDefault: true })
	.addCommand(claimCommand);
