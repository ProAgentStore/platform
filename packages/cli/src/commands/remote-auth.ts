// `pags remote-auth` — the local relay for a PAS remote MCP sign-in (#1005, design A from #1006).
//
// The PAS companion client on this machine creates the sign-in request at ProAppStore itself (broker v2,
// PAS #355) and keeps every secret of it here: its machine proof, PKCE verifier and private key. It hands
// this command only the request's PUBLIC details, and this command relays them to ProAgentStore with the
// owner's existing `pags login` — so the owner's phone gets a push that opens that exact request, and the
// page there sends them to ProAppStore's own approval page. ProAgentStore never holds a PAS credential and
// never calls PAS; the companion collects the result from ProAppStore directly and reports its state here.
//
//   pags remote-auth relay  < request.json      → {"id","url","state","duplicate"}
//   pags remote-auth state <id> <state>         → {"id","state","changed"}
import { Command } from "commander";
import { hostname } from "node:os";
import { loadMachineIdentity } from "../machine.js";
import { writeError, writeLine } from "../output.js";
import { apiPathSegment, requestPags } from "./runner/http.js";

const CONSOLE = "https://proagentstore.online/console";
const FIELDS = ["request_id", "agent", "machine", "resource", "scopes", "approval_url", "expires_at"] as const;
/** What a companion must keep on this machine. A relay carrying any of these is refused before it leaves. */
const SECRET_KEY = /verifier|proof|private|secret|token|password|credential|ciphertext|session|cookie|^code$/i;
export const REMOTE_AUTH_STATES = ["pending", "approving", "approved_awaiting_machine", "consumed", "connected", "denied", "expired", "cancelled", "failed"] as const;

/** Every key in a JSON value, at any depth — a secret nested under `machine` is still a secret. */
function keysOf(v: unknown, out: string[] = []): string[] {
	if (v && typeof v === "object") {
		for (const [k, x] of Object.entries(v)) {
			out.push(k);
			keysOf(x, out);
		}
	}
	return out;
}

/** The body to relay, or why not. Only the public fields go; a secret-shaped key anywhere refuses it all. */
export function buildRelayBody(input: unknown, identity: { id: string; node: string }): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
	if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Expected the request as a JSON object on stdin." };
	const secret = keysOf(input).filter((k) => SECRET_KEY.test(k));
	if (secret.length) return { ok: false, error: `Refused: the request carries ${[...new Set(secret)].join(", ")}. Keep proofs, verifiers, keys and tokens on this machine — relay only the public request details.` };
	const src = input as Record<string, unknown>;
	const body: Record<string, unknown> = {};
	for (const f of FIELDS) if (f in src) body[f] = src[f];
	body.relayed_by = { node: identity.node, machine_id: identity.id || null };
	return { ok: true, body };
}

function identity() {
	const id = loadMachineIdentity();
	return { id: id.id, node: id.names[0] ?? hostname() };
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const c of process.stdin) chunks.push(c as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

const relayCommand = new Command("relay")
	.description("Relay a PAS sign-in request's public details (JSON on stdin) so the owner gets a push for it")
	.action(async () => {
		let input: unknown;
		try {
			input = JSON.parse(await readStdin());
		} catch {
			writeError("Expected the request as JSON on stdin.");
			process.exit(2);
		}
		const built = buildRelayBody(input, identity());
		if (!built.ok) {
			writeError(built.error);
			process.exit(2);
		}
		try {
			const res = await requestPags<{ request: { id: string; state: string }; duplicate: boolean }>("POST", "/v1/remote-auth/requests", {}, built.body);
			writeLine(JSON.stringify({ id: res.request.id, url: `${CONSOLE}/remote-auth/${res.request.id}`, state: res.request.state, duplicate: res.duplicate }));
		} catch (e) {
			writeError(e instanceof Error ? e.message : String(e));
			process.exit(1);
		}
	});

const stateCommand = new Command("state")
	.description("Report the PAS broker state this machine observed for a relayed request")
	.argument("<id>", "The id `pags remote-auth relay` returned (rar_…)")
	.argument("<state>", REMOTE_AUTH_STATES.join(" | "))
	.action(async (id: string, state: string) => {
		if (!(REMOTE_AUTH_STATES as readonly string[]).includes(state)) {
			writeError(`state must be one of: ${REMOTE_AUTH_STATES.join(", ")}`);
			process.exit(2);
		}
		const me = identity();
		try {
			const res = await requestPags<{ request: { id: string; state: string }; changed: boolean }>("POST", `/v1/remote-auth/requests/${apiPathSegment(id)}/state`, {}, { state, relayed_by: { node: me.node, machine_id: me.id || null } });
			writeLine(JSON.stringify({ id: res.request.id, state: res.request.state, changed: res.changed }));
		} catch (e) {
			writeError(e instanceof Error ? e.message : String(e));
			process.exit(1);
		}
	});

export const remoteAuthCommand = new Command("remote-auth")
	.description("Relay a ProAppStore remote MCP sign-in request to your phone (used by the PAS companion client)")
	.addCommand(relayCommand)
	.addCommand(stateCommand);
