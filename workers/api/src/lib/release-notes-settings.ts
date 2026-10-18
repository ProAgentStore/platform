/**
 * Who receives an instance's release notes (#1217) — on/off and which granted channels.
 *
 * Two levels, resolved per field:
 *   account   `users.preferences.releaseNotes` — `{ enabled }`, the default every instance inherits,
 *             including ones subscribed later (inheritance is resolved on read, never copied in).
 *   instance  `agent_instances.config.releaseNotes` — `{ enabled?, channels? }`. An absent `enabled`
 *             follows the account; an absent `channels` means every channel granted to the instance.
 *
 * With nothing set anywhere, release notes are ON: granting an instance a channel is the owner's
 * consent to that instance posting there, which is how #1216 shipped.
 *
 * A channel is named by its GRANT id, so a choice can only ever name a channel the owner granted this
 * instance. Saving one that is not granted is refused; one revoked after it was saved is reported as
 * `missing` and simply receives nothing.
 */
import { HttpError } from "./auth.js";
import { listConnectorGrants } from "./connector-grants.js";
import { parseAccountPreferences } from "./preferences.js";
import type { AccountReleaseNotes, InstanceReleaseNotes, ReleaseChannel, ReleaseNoteProvider, ReleaseNotesEnabledFrom, ResolvedReleaseNotes } from "../agent-types.js";
import type { Env } from "../types.js";

/** The messaging connectors whose granted channels can receive a release note. */
export const RELEASE_NOTE_PROVIDERS: ReadonlyArray<{ provider: ReleaseNoteProvider; resourceType: string }> = [
	{ provider: "discord", resourceType: "discord_channel" },
	{ provider: "slack", resourceType: "slack_channel" },
];
export type { AccountReleaseNotes, InstanceReleaseNotes, ReleaseChannel, ReleaseNoteProvider, ReleaseNotesEnabledFrom, ResolvedReleaseNotes } from "../agent-types.js";

const CHANNELS_MAX = 50;

/** Strict on write: an unknown field or a wrong type is refused rather than dropped. */
export function validateAccountReleaseNotes(raw: unknown): AccountReleaseNotes {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "releaseNotes must be an object: { enabled: boolean }");
	const extra = Object.keys(raw).filter((k) => k !== "enabled");
	if (extra.length) throw new HttpError(400, `releaseNotes takes only \`enabled\`; unknown: ${extra.map((k) => `\`${k}\``).join(", ")}`);
	const { enabled } = raw as { enabled?: unknown };
	if (typeof enabled !== "boolean") throw new HttpError(400, "releaseNotes.enabled must be true or false");
	return { enabled };
}

/** An instance's stored setting — lenient on read, like the account's. */
export function readInstanceReleaseNotes(config: string | null | undefined): InstanceReleaseNotes {
	let raw: unknown;
	try {
		raw = (JSON.parse(config || "{}") as { releaseNotes?: unknown }).releaseNotes;
	} catch {
		return {}; // malformed config is no setting, as every other config reader treats it
	}
	const o = (raw && typeof raw === "object" ? raw : {}) as { enabled?: unknown; channels?: unknown };
	return {
		...(typeof o.enabled === "boolean" ? { enabled: o.enabled } : {}),
		...(Array.isArray(o.channels) ? { channels: o.channels.filter((c): c is string => typeof c === "string") } : {}),
	};
}

/**
 * Apply a write to the stored setting. Patch semantics per field: an omitted field is kept, `null`
 * clears it back to inherited (`enabled` → the account default, `channels` → every granted channel).
 * `channels` must name grants this instance holds — the grant check.
 */
export function applyInstanceReleaseNotesPatch(current: InstanceReleaseNotes, patch: unknown, granted: readonly ReleaseChannel[]): InstanceReleaseNotes {
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new HttpError(400, "Body must be an object: { enabled?: boolean | null, channels?: string[] | null }");
	const extra = Object.keys(patch).filter((k) => k !== "enabled" && k !== "channels");
	if (extra.length) throw new HttpError(400, `Unknown field ${extra.map((k) => `\`${k}\``).join(", ")} — the fields are \`enabled\` and \`channels\`.`);
	const p = patch as { enabled?: unknown; channels?: unknown };
	const next: InstanceReleaseNotes = { ...current };
	if (p.enabled === null) delete next.enabled;
	else if (p.enabled !== undefined) {
		if (typeof p.enabled !== "boolean") throw new HttpError(400, "enabled must be true, false, or null (follow the account default)");
		next.enabled = p.enabled;
	}
	if (p.channels === null) delete next.channels;
	else if (p.channels !== undefined) {
		if (!Array.isArray(p.channels) || p.channels.some((c) => typeof c !== "string")) throw new HttpError(400, "channels must be a list of grant ids, or null (every granted channel)");
		const ids = [...new Set(p.channels as string[])];
		if (ids.length > CHANNELS_MAX) throw new HttpError(400, `channels takes at most ${CHANNELS_MAX} grant ids`);
		const notGranted = ids.filter((id) => !granted.some((g) => g.grantId === id));
		if (notGranted.length) {
			const known = granted.map((g) => `${g.grantId} (${g.provider} ${g.name})`).join(", ") || "none — grant a Discord or Slack channel first";
			throw new HttpError(400, `Not a channel granted to this instance: ${notGranted.join(", ")}. Granted channels: ${known}.`);
		}
		next.channels = ids;
	}
	return next;
}

/** The instance's granted messaging channels, Discord and Slack. */
export async function grantedReleaseChannels(env: Env, instanceId: string, userId: string): Promise<ReleaseChannel[]> {
	const out: ReleaseChannel[] = [];
	for (const { provider, resourceType } of RELEASE_NOTE_PROVIDERS) {
		for (const g of await listConnectorGrants(env, instanceId, userId, provider)) {
			if (g.resourceType === resourceType) out.push({ provider, grantId: g.id, channelId: g.resourceId, name: g.resourceName });
		}
	}
	return out;
}

/** Resolve the effective setting: instance over account over platform (on), and which channels receive it. */
export function resolveReleaseNotes(account: AccountReleaseNotes | undefined, instance: InstanceReleaseNotes, granted: readonly ReleaseChannel[]): ResolvedReleaseNotes {
	const enabledFrom: ReleaseNotesEnabledFrom = instance.enabled !== undefined ? "instance" : account ? "account" : "platform";
	const enabled = instance.enabled ?? account?.enabled ?? true;
	const chosen = instance.channels ? new Set(instance.channels) : null;
	return {
		enabled,
		enabledFrom,
		channels: granted.map((g) => ({ ...g, selected: chosen ? chosen.has(g.grantId) : true })),
		channelsFrom: chosen ? "instance" : "all",
		missing: instance.channels?.filter((id) => !granted.some((g) => g.grantId === id)) ?? [],
	};
}

/** Read everything and resolve, for the route, the MCP tool and the run-end delivery alike. */
export async function loadReleaseNotes(env: Env, instanceId: string, userId: string): Promise<{ account: AccountReleaseNotes | undefined; instance: InstanceReleaseNotes; effective: ResolvedReleaseNotes } | null> {
	const row = await env.DB.prepare("SELECT ai.config AS config, u.preferences AS preferences FROM agent_instances ai JOIN users u ON u.id = ai.user_id WHERE ai.id = ?1 AND ai.user_id = ?2")
		.bind(instanceId, userId)
		.first<{ config: string | null; preferences: string | null }>();
	if (!row) return null;
	const account = parseAccountPreferences(row.preferences).releaseNotes;
	const instance = readInstanceReleaseNotes(row.config);
	return { account, instance, effective: resolveReleaseNotes(account, instance, await grantedReleaseChannels(env, instanceId, userId)) };
}
