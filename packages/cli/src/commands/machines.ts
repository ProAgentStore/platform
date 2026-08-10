// `pags machines` — see what PAGS thinks your machines are, claim a name this one has used,
// and un-claim a name it should not have (#467).
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
import { loadMachineIdentity, machineFilePath, saveMachineIdentity, withClaimedNames, withUnclaimedName } from "../machine.js";
import { apiPathSegment, pagsApiBase, requestPags } from "./runner/http.js";

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
		writeLine("  Remove a wrong claim:                       pags machines unclaim <name>");
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

const unclaimCommand = new Command("unclaim")
	.description("Remove a mistaken machine name claim from this machine (#467)")
	.argument("<name...>", "Node name(s) to un-claim, as shown by `pags machines list`")
	.action(async (names: string[]) => {
		const session = requireSession();
		const identity = loadMachineIdentity();
		if (!identity.id) {
			writeError("This machine has no id — `~/.config/proagentstore/` is not writable, so the claim record cannot be found.");
			process.exit(1);
		}

		let anyFailed = false;
		for (const raw of names) {
			const name = raw.trim();
			if (!name) continue;

			// Safety: the current hostname is the name this machine is actively registering under.
			// Removing it from machine.json would make the next `pags up` re-add it (via `withName`),
			// so the local half of the un-claim cannot be kept. The server half would also be re-stamped
			// on the next register. Refuse loudly rather than appear to work and silently revert.
			if (name === identity.names[0]) {
				writeError(`  ✗ ${name}: this is the machine's CURRENT hostname. You cannot un-claim the name it is actively registering under — stop \`pags up\` and rename the machine first.`);
				anyFailed = true;
				continue;
			}

			if (!identity.names.includes(name)) {
				writeError(`  ✗ ${name}: this machine does not claim that name.`);
				anyFailed = true;
				continue;
			}

			// Call the server. The server also enforces all the safety checks (connected, blockers).
			try {
				await requestPags<{ unclaimed: string; rowsUpdated: number }>(
					"DELETE",
					`/v1/terminals/nodes/${apiPathSegment(name)}/claim`,
					{ pagsToken: session.token, apiBase: pagsApiBase() },
					{ machineId: identity.id },
				);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				writeError(`  ✗ ${name}: ${msg}`);
				anyFailed = true;
				continue;
			}

			// Update the local file: remove the name, add it to declined so the #460 first-run
			// prompt does not re-offer it on the next `pags up`.
			const updated = withUnclaimedName(identity, name);
			if (!saveMachineIdentity(updated)) {
				writeError(`  ✗ Server un-claimed ${name} but could not update ${machineFilePath()} — the next \`pags up\` may re-stamp it. Edit that file by hand and remove "${name}" from the names array.`);
				anyFailed = true;
				continue;
			}
			writeLine(`  ✓ ${name} — un-claimed on server and removed from ${machineFilePath()}.`);
		}

		if (anyFailed) process.exit(1);
	});

export const machinesCommand = new Command("machines")
	.description("Show and claim the machine names ProAgentStore has for this account")
	.addCommand(listCommand, { isDefault: true })
	.addCommand(claimCommand)
	.addCommand(unclaimCommand);
