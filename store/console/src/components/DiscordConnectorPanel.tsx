import { useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import type { DiscordChannel, DiscordChannelListResponse, DiscordConnectorGrant, DiscordGuild, DiscordGuildListResponse } from "../lib/discordTypes";

export type { DiscordConnectorGrant } from "../lib/discordTypes";

interface Props {
	grants: DiscordConnectorGrant[];
	message: string;
	onAddGrant: (channelId: string) => Promise<void>;
	onRemoveGrant: (grant: DiscordConnectorGrant) => Promise<void>;
}

/**
 * A Discord credential belongs to the owner; a channel grant belongs to one agent.  Keep the
 * picker here rather than accepting a pasted channel id, so the grant is chosen from channels
 * the connected bot can actually see.
 */
export function DiscordConnectorPanel({ grants, message, onAddGrant, onRemoveGrant }: Props) {
	const [guilds, setGuilds] = useState<DiscordGuild[] | null>(null);
	const [guildId, setGuildId] = useState("");
	const [channels, setChannels] = useState<DiscordChannel[] | null>(null);
	const [channelId, setChannelId] = useState("");
	const [error, setError] = useState("");
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		api<DiscordGuildListResponse>("/v1/discord/guilds")
			.then((data) => setGuilds(data.guilds))
			.catch(() => setError("Add a Discord bot token in Profile → API Keys before choosing a channel."));
	}, []);

	useEffect(() => {
		setChannelId("");
		if (!guildId) {
			setChannels(null);
			return;
		}
		setChannels(null);
		api<DiscordChannelListResponse>(`/v1/discord/guilds/${encodeURIComponent(guildId)}/channels`)
			.then((data) => setChannels(data.channels))
			.catch(() => setError("Discord channels could not be loaded. Check that the bot can view this server."));
	}, [guildId]);

	const grantChannel = async () => {
		if (!channelId) return;
		setSaving(true);
		setError("");
		try {
			await onAddGrant(channelId);
			setChannelId("");
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not grant this Discord channel.");
		} finally {
			setSaving(false);
		}
	};

	const removeChannel = async (grant: DiscordConnectorGrant) => {
		setError("");
		try {
			await onRemoveGrant(grant);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not remove this Discord channel grant.");
		}
	};

	return (
		<div className="mb-4" data-testid="discord-connector-panel">
			<div className="text-sm mb-2">
				<span className="font-semibold">Discord bot</span>
				<p className="text-2xs text-muted-soft mt-0.5">Channels this agent may read or post in. Other agents get their own grants.</p>
			</div>
			<div className="pl-0 sm:pl-3 border-l-0 sm:border-l sm:border-line">
				<div className="flex gap-2 flex-wrap mb-2">
					<select aria-label="Discord server" value={guildId} onChange={(e) => { setError(""); setGuildId(e.target.value); }} className="flex-1 min-w-0 sm:min-w-[12rem] bg-paper border border-line rounded-lg px-3 py-2 text-sm">
						<option value="">{guilds === null ? "Loading Discord servers…" : "Choose a Discord server"}</option>
						{guilds?.map((guild) => <option key={guild.id} value={guild.id}>{guild.name}</option>)}
					</select>
					<select aria-label="Discord channel to grant this agent" value={channelId} disabled={!guildId || channels === null} onChange={(e) => setChannelId(e.target.value)} className="flex-1 min-w-0 sm:min-w-[12rem] bg-paper border border-line rounded-lg px-3 py-2 text-sm disabled:opacity-50">
						<option value="">{channels === null ? "Choose a server first" : "Choose a text channel"}</option>
						{channels?.map((channel) => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}
					</select>
					<button type="button" onClick={() => void grantChannel()} disabled={!channelId || saving} className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted font-bold hover:border-accent hover:text-accent disabled:opacity-50">
						Grant channel
					</button>
				</div>
				{error && <p className="text-xs text-danger mb-2">{error}</p>}
				{message && <p className="text-xs text-muted mb-2">{message}</p>}
				<div className="flex flex-col gap-1.5">
					{grants.length === 0 ? <p className="text-xs text-muted">No Discord channels granted to this agent yet.</p> : grants.map((grant) => (
						<div key={grant.id} className="flex items-center justify-between gap-2 text-xs bg-paper border border-line rounded-lg px-2.5 py-2">
							<span className="min-w-0 truncate">{grant.resourceName}</span>
							<button type="button" onClick={() => void removeChannel(grant)} className="shrink-0 text-muted hover:text-danger">Remove</button>
						</div>
					))}
				</div>
				<p className="text-2xs text-muted-soft mt-1.5">Posting and reactions also need Discord write consent in the tool permissions above. The bot's Discord server permissions still apply.</p>
			</div>
		</div>
	);
}

export default DiscordConnectorPanel;
