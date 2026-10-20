import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Button from "./Button";
import type { DiscordChannel, DiscordChannelListResponse, DiscordGrantListResponse, DiscordGrantResponse, DiscordGuild, DiscordGuildListResponse } from "../lib/discordTypes";
import type { InstanceReleaseNotesResponse, ReleaseNoteTestResponse, SlackBotConnectResponse, SlackBotStatusResponse, SlackChannelListResponse, SlackGrantResponse, SlackOauthStartResponse } from "../lib/types";

interface Props {
	instanceId: string;
	/** Changes when the page's Discord grants change, so the channel list re-reads. */
	refreshKey?: string;
}

const errorText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/**
 * Release notes (#1216, #1217): whether this agent posts one note per coder run that ships to the
 * default branch, which of its granted Discord and Slack channels receive it, and a test send per
 * channel. Slack is connected here too — the bot belongs to the owner, a channel grant to one agent,
 * as with Discord. A Discord channel can be granted here for release notes alone (#1218): a coder declares
 * no Discord tools, so the agent grant is refused for it, and this grant gives the agent no reach. Every rule (inheritance, which grant ids are allowed) is the server's; this panel
 * renders `effective` and never resolves precedence itself.
 */
export default function ReleaseNotesPanel({ instanceId, refreshKey = "" }: Props) {
	const [view, setView] = useState<InstanceReleaseNotesResponse | null>(null);
	const [slack, setSlack] = useState<SlackBotStatusResponse | null>(null);
	const [slackChannels, setSlackChannels] = useState<SlackChannelListResponse | null>(null);
	const [slackChannelId, setSlackChannelId] = useState("");
	const [slackToken, setSlackToken] = useState("");
	const [guilds, setGuilds] = useState<DiscordGuild[] | null>(null);
	const [guildId, setGuildId] = useState("");
	const [discordChannels, setDiscordChannels] = useState<DiscordChannel[] | null>(null);
	const [discordChannelId, setDiscordChannelId] = useState("");
	/** Discord grants made for release notes alone — the only ones this panel may remove; the rest are the agent's. */
	const [releaseOnly, setReleaseOnly] = useState<Set<string>>(new Set());
	const [message, setMessage] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState("");

	const load = useCallback(async () => {
		setError("");
		try {
			setView(await api<InstanceReleaseNotesResponse>(`/v1/instances/${instanceId}/release-notes`));
			const s = await api<SlackBotStatusResponse>("/v1/slack/bot");
			setSlack(s);
			const dg = await api<DiscordGrantListResponse>(`/v1/discord/instances/${instanceId}/grants`).catch(() => null);
			setReleaseOnly(new Set((dg?.grants ?? []).filter((g) => g.resourceType === "discord_release_channel").map((g) => g.id)));
			setSlackChannels(s.connected && s.valid ? await api<SlackChannelListResponse>("/v1/slack/channels") : null);
		} catch (e) {
			setError(errorText(e, "Release-notes settings could not be loaded."));
		}
	}, [instanceId]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `refreshKey` is the re-read trigger (the page's Discord grants changed), not a value the effect reads.
	useEffect(() => {
		void load();
	}, [load, refreshKey]);

	// The bot is the owner's: with none connected the guild list is refused and the Discord picker stays hidden.
	useEffect(() => {
		api<DiscordGuildListResponse>("/v1/discord/guilds")
			.then((d) => setGuilds(d.guilds))
			.catch(() => setGuilds(null));
	}, []);

	useEffect(() => {
		setDiscordChannelId("");
		setDiscordChannels(null);
		if (!guildId) return;
		api<DiscordChannelListResponse>(`/v1/discord/guilds/${encodeURIComponent(guildId)}/channels`)
			.then((d) => setDiscordChannels(d.channels))
			.catch(() => setError("Discord channels could not be loaded. Check that the bot can view this server."));
	}, [guildId]);

	const run = async (label: string, fn: () => Promise<void>) => {
		setBusy(label);
		setError("");
		setMessage("");
		try {
			await fn();
		} catch (e) {
			setError(errorText(e, "That did not work."));
		} finally {
			setBusy("");
		}
	};

	const save = (patch: { enabled?: boolean | null; channels?: string[] | null }) =>
		run("save", async () => {
			setView(await api<InstanceReleaseNotesResponse>(`/v1/instances/${instanceId}/release-notes`, { method: "PUT", body: JSON.stringify(patch) }));
			setMessage("Saved.");
		});

	const toggleChannel = (grantId: string, on: boolean) => {
		if (!view) return;
		const current = view.effective.channels.filter((c) => c.selected).map((c) => c.grantId);
		const next = on ? [...new Set([...current, grantId])] : current.filter((id) => id !== grantId);
		void save({ channels: next });
	};

	const sendTest = (grantId: string) =>
		run(`test:${grantId}`, async () => {
			const d = await api<ReleaseNoteTestResponse>(`/v1/instances/${instanceId}/release-notes/test`, { method: "POST", body: JSON.stringify({ grantId }) });
			setMessage(`Test note sent to ${d.channel.provider} ${d.channel.name}.`);
		});

	const grantDiscord = () =>
		run("discord-grant", async () => {
			const d = await api<DiscordGrantResponse>(`/v1/discord/instances/${instanceId}/grants`, { method: "POST", body: JSON.stringify({ channelId: discordChannelId, purpose: "release_notes" }) });
			setDiscordChannelId("");
			setMessage(d.note ?? `Release notes can now be posted to ${d.grant.resourceName}.`);
			await load();
		});

	const revokeDiscord = (grantId: string, name: string) =>
		run(`discord-revoke:${grantId}`, async () => {
			await api(`/v1/discord/instances/${instanceId}/grants/${encodeURIComponent(grantId)}`, { method: "DELETE" });
			setMessage(`Removed ${name}.`);
			await load();
		});

	const connectSlack = () =>
		run("slack-connect", async () => {
			const d = await api<SlackBotConnectResponse>("/v1/slack/bot", { method: "PUT", body: JSON.stringify({ token: slackToken.trim() }) });
			setSlackToken("");
			setMessage(`Connected the Slack bot for ${d.bot.team}.${d.revoked.grants ? ` ${d.revoked.grants} grant(s) for the previous workspace were revoked.` : ""}`);
			await load();
		});

	const addToSlack = () =>
		run("slack-oauth", async () => {
			const d = await api<SlackOauthStartResponse>("/v1/slack/oauth/start");
			window.open(d.url, "_blank", "noopener");
			setMessage("Finish in the Slack tab, then come back and reload this panel.");
		});

	const grantSlack = () =>
		run("slack-grant", async () => {
			const d = await api<SlackGrantResponse>(`/v1/slack/instances/${instanceId}/grants`, { method: "POST", body: JSON.stringify({ channelId: slackChannelId }) });
			setSlackChannelId("");
			setMessage(d.note ?? `Granted ${d.grant.resourceName} to this agent.`);
			await load();
		});

	const revokeSlack = (grantId: string, name: string) =>
		run(`slack-revoke:${grantId}`, async () => {
			await api(`/v1/slack/instances/${instanceId}/grants/${encodeURIComponent(grantId)}`, { method: "DELETE" });
			setMessage(`Removed ${name}.`);
			await load();
		});

	const eff = view?.effective;
	const followLabel = `Follow account default (${view?.account ? (view.account.enabled ? "on" : "off") : "on"})`;
	const enabledValue = view?.settings.enabled === undefined ? "" : view.settings.enabled ? "on" : "off";

	return (
		<div className="mb-4" data-testid="release-notes-panel">
			<div className="text-sm mb-2">
				<span className="font-semibold">Release notes</span>
				<p className="text-2xs text-muted-soft mt-0.5">One note per coder run that ships to the default branch — what changed, the issues it closed, and CI/deploy status — posted to the channels below.</p>
			</div>
			<div className="pl-0 sm:pl-3 border-l-0 sm:border-l sm:border-line">
				<label htmlFor="release-notes-enabled" className="text-xs text-muted block mb-1">Post release notes</label>
				<select
					id="release-notes-enabled"
					value={enabledValue}
					disabled={!view || busy === "save"}
					onChange={(e) => void save({ enabled: e.target.value === "" ? null : e.target.value === "on" })}
					className="text-sm bg-paper border border-line rounded-lg px-3 py-2 block w-full sm:w-72 mb-3"
				>
					<option value="">{followLabel}</option>
					<option value="on">On for this agent</option>
					<option value="off">Off for this agent</option>
				</select>

				<div className="flex items-center justify-between gap-2 mb-1.5">
					<span className="text-xs text-muted">Channels</span>
					{eff?.channelsFrom === "instance" && (
						<button type="button" className="text-2xs text-muted hover:text-ink" onClick={() => void save({ channels: null })}>
							Use every granted channel
						</button>
					)}
				</div>
				<div className="flex flex-col gap-1.5 mb-3">
					{!eff ? null : eff.channels.length === 0 ? (
						<p className="text-xs text-muted">No channels granted yet. Grant a Discord or Slack channel below.</p>
					) : (
						eff.channels.map((c) => (
							<div key={c.grantId} className="flex items-center justify-between gap-2 text-xs bg-paper border border-line rounded-lg px-2.5 py-2">
								<label className="flex items-center gap-2 min-w-0">
									<input type="checkbox" checked={c.selected} disabled={busy === "save"} onChange={(e) => toggleChannel(c.grantId, e.target.checked)} aria-label={`Send release notes to ${c.provider} ${c.name}`} />
									<span className="text-muted-soft shrink-0">{c.provider === "slack" ? "Slack" : "Discord"}</span>
									<span className="truncate">{c.name}</span>
								</label>
								<div className="flex items-center gap-3 shrink-0">
									<button type="button" className="text-muted hover:text-ink disabled:opacity-50" disabled={busy === `test:${c.grantId}`} onClick={() => void sendTest(c.grantId)}>
										{busy === `test:${c.grantId}` ? "Sending…" : "Send test"}
									</button>
									{(c.provider === "slack" || releaseOnly.has(c.grantId)) && (
										<button type="button" className="text-muted hover:text-danger" onClick={() => void (c.provider === "slack" ? revokeSlack(c.grantId, c.name) : revokeDiscord(c.grantId, c.name))}>
											Remove
										</button>
									)}
								</div>
							</div>
						))
					)}
					{eff && eff.missing.length > 0 && <p className="text-2xs text-muted-soft">{eff.missing.length} chosen channel(s) were since revoked and receive nothing.</p>}
				</div>

				{guilds && (
					<>
						<div className="text-xs text-muted mb-1">Discord</div>
						<div className="flex gap-2 flex-wrap mb-1">
							<select aria-label="Discord server" value={guildId} onChange={(e) => setGuildId(e.target.value)} className="flex-1 min-w-0 sm:min-w-[10rem] bg-paper border border-line rounded-lg px-3 py-2 text-sm">
								<option value="">Choose a server</option>
								{guilds.map((g) => (
									<option key={g.id} value={g.id}>
										{g.name}
									</option>
								))}
							</select>
							<select
								aria-label="Discord channel for release notes"
								value={discordChannelId}
								disabled={!guildId}
								onChange={(e) => setDiscordChannelId(e.target.value)}
								className="flex-1 min-w-0 sm:min-w-[10rem] bg-paper border border-line rounded-lg px-3 py-2 text-sm"
							>
								<option value="">{guildId && !discordChannels ? "Loading channels…" : "Choose a channel"}</option>
								{discordChannels?.map((ch) => (
									<option key={ch.id} value={ch.id}>
										#{ch.name}
									</option>
								))}
							</select>
							<Button onClick={() => void grantDiscord()} disabled={!discordChannelId || busy === "discord-grant"}>
								Grant for release notes
							</Button>
						</div>
						<p className="text-2xs text-muted-soft mb-3">Posts release notes only — the agent itself gets no access to this channel. To let the agent read or post there, grant it under Discord above.</p>
					</>
				)}

				<div className="text-xs text-muted mb-1">Slack</div>
				{slack && (!slack.connected || !slack.valid) ? (
					<div className="flex flex-col gap-2 mb-2">
						{slack.error && <p className="text-xs text-danger">{slack.error}</p>}
						<div className="flex gap-2 flex-wrap">
							<input
								type="password"
								aria-label="Slack bot token"
								placeholder="Slack bot token (xoxb-…)"
								value={slackToken}
								onChange={(e) => setSlackToken(e.target.value)}
								className="flex-1 min-w-0 sm:min-w-[16rem] bg-paper border border-line rounded-lg px-3 py-2 text-sm"
							/>
							<Button onClick={() => void connectSlack()} disabled={!slackToken.trim() || busy === "slack-connect"}>
								Connect Slack
							</Button>
							{slack.oauthConfigured && (
								<Button onClick={() => void addToSlack()} disabled={busy === "slack-oauth"}>
									Add to Slack
								</Button>
							)}
						</div>
						<p className="text-2xs text-muted-soft">Your Slack app's Bot User OAuth Token, with chat:write, channels:read and groups:read. Stored encrypted for your account; never shown again.</p>
					</div>
				) : slack ? (
					<div className="flex gap-2 flex-wrap mb-2">
						<select
							aria-label="Slack channel to grant this agent"
							value={slackChannelId}
							onChange={(e) => setSlackChannelId(e.target.value)}
							className="flex-1 min-w-0 sm:min-w-[12rem] bg-paper border border-line rounded-lg px-3 py-2 text-sm"
						>
							<option value="">{slackChannels ? `Choose a channel in ${slack.bot?.team ?? "Slack"}` : "Loading Slack channels…"}</option>
							{slackChannels?.channels.map((ch) => (
								<option key={ch.id} value={ch.id}>
									#{ch.name}
									{ch.isMember ? "" : " (bot not in channel)"}
								</option>
							))}
						</select>
						<Button onClick={() => void grantSlack()} disabled={!slackChannelId || busy === "slack-grant"}>
							Grant channel
						</Button>
					</div>
				) : null}

				{error && <p className="text-xs text-danger mt-1">{error}</p>}
				{message && <p className="text-xs text-muted mt-1">{message}</p>}
			</div>
		</div>
	);
}
