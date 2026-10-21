// The explicit readiness picture of a private agent's worker-backed mail (#1277).
//
// One PURE function over what the routes already load (credential-free connection info, the instance pin, the
// per-connection profile and the instance's write consent), so every way mail can be unavailable is a distinct,
// named `blockers[].code` rather than one generic "no connection": absent connection, ambiguous choice, stale pin,
// unreachable bridge (with the adapter's failure class), a bridge that has not reported its identities, no approved
// sender, no reply identity, and write consent off or gated. Nothing here sees a secret.
import { describeIdentities } from "./connectors/email-worker.js";
import { type EmailWorkerConnectionInfo, type EmailWorkerPin, resolveEmailWorkerConnectionFrom } from "./email-worker-connections.js";
import { type ConnectionProfile, replyDecision, senderDecision } from "./email-worker-identities.js";

export type BlockerCode =
	| "no_connection"
	| "ambiguous_connection"
	| "stale_pin"
	| "bridge_unreachable"
	| "no_identity_report"
	| "no_approved_sender"
	| "no_reply_identity"
	| "write_consent_off"
	| "write_consent_ask";

export interface Blocker {
	code: BlockerCode;
	/** `blocks` = nothing of that kind works; `gated` = works only after the owner approves each call. */
	effect: "blocks_reads" | "blocks_sends" | "gated_sends";
	message: string;
	failureClass?: string;
}

export interface ConnectionStatus {
	endpoint: string;
	accountId: string;
	label: string | null;
	contractVersion: string | null;
	pinnedToThisInstance: boolean;
	identities: Record<string, unknown>;
}

export interface EmailWorkerStatus {
	state: "absent" | "ambiguous" | "stale_pin" | "connected";
	pinned: EmailWorkerPin | null;
	resolved: { endpoint: string; accountId: string; label: string } | null;
	connections: ConnectionStatus[];
	writeConsent: "off" | "ask" | "always";
	blockers: Blocker[];
	/** True only when the agent can read AND send (an `ask` consent still counts: sends then wait for the owner). */
	readyToRead: boolean;
	readyToSend: boolean;
}

export function buildEmailWorkerStatus(input: {
	connections: readonly EmailWorkerConnectionInfo[];
	profiles: ReadonlyMap<string, ConnectionProfile>;
	pinned: EmailWorkerPin | null;
	writeConsent: "off" | "ask" | "always";
}): EmailWorkerStatus {
	const { connections, profiles, pinned, writeConsent } = input;
	const key = (c: { endpoint: string; accountId: string }) => `${c.endpoint}\u0000${c.accountId}`;
	const res = resolveEmailWorkerConnectionFrom(connections, pinned ?? undefined);
	const statuses: ConnectionStatus[] = connections.map((c) => {
		const profile = profiles.get(key(c));
		return {
			endpoint: c.endpoint,
			accountId: c.accountId,
			label: c.accountLabel,
			contractVersion: c.contractVersion,
			pinnedToThisInstance: pinned?.endpoint === c.endpoint && pinned.accountId === c.accountId,
			identities: profile ? describeIdentities(profile) : {},
		};
	});
	const blockers: Blocker[] = [];
	let state: EmailWorkerStatus["state"] = "connected";
	if (!res.ok) {
		state = res.reason === "not_connected" ? "absent" : res.reason === "ambiguous" ? "ambiguous" : "stale_pin";
		const code: BlockerCode = res.reason === "not_connected" ? "no_connection" : res.reason === "ambiguous" ? "ambiguous_connection" : "stale_pin";
		blockers.push({ code, effect: "blocks_reads", message: res.message });
	} else {
		const profile = profiles.get(key(res));
		if (profile) {
			if (profile.health.lastProbeOk === false) {
				blockers.push({ code: "bridge_unreachable", effect: "blocks_reads", failureClass: profile.health.lastFailureClass ?? "bridge_failure", message: `The bridge failed its last check (${profile.health.lastFailureClass ?? "bridge_failure"}). Test the connection; if it is an auth failure, re-enroll the secret.` });
			}
			if (profile.provider === "cloudflare") {
				if (!profile.snapshot) {
					blockers.push({ code: "no_identity_report", effect: "blocks_sends", message: "The bridge has not reported its identities yet. Test the connection." });
				} else {
					const sender = senderDecision(profile, undefined);
					if (!sender.ok) blockers.push({ code: "no_approved_sender", effect: "blocks_sends", message: sender.message });
					else {
						const reply = replyDecision(profile);
						if (!reply.ok) blockers.push({ code: "no_reply_identity", effect: "blocks_sends", message: reply.message });
					}
				}
			}
		}
		if (writeConsent === "off") blockers.push({ code: "write_consent_off", effect: "blocks_sends", message: "Write consent for worker-backed email is off for this instance, so every send is refused. Only the owner can turn it on, in the console." });
		else if (writeConsent === "ask") blockers.push({ code: "write_consent_ask", effect: "gated_sends", message: "Write consent is set to ask: each send waits on the board for the owner's approval." });
	}
	const blocksReads = blockers.some((b) => b.effect === "blocks_reads");
	const blocksSends = blocksReads || blockers.some((b) => b.effect === "blocks_sends");
	return { state, pinned, resolved: res.ok ? { endpoint: res.endpoint, accountId: res.accountId, label: res.label } : null, connections: statuses, writeConsent, blockers, readyToRead: !blocksReads, readyToSend: !blocksSends };
}
