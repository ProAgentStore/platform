/** A server visible to the owner's Discord bot in the channel-grant picker. */
export interface DiscordGuild {
	id: string;
	name: string;
}

/** A text or announcement channel visible to the owner's Discord bot. */
export interface DiscordChannel {
	id: string;
	name: string;
}

/** One owner-approved Discord channel for one private agent instance. */
export interface DiscordConnectorGrant {
	id: string;
	instanceId: string;
	userId: string;
	provider: string;
	resourceId: string;
	resourceName: string;
	resourceType: string;
	resourceUrl?: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface DiscordGuildListResponse {
	guilds: DiscordGuild[];
}

export interface DiscordChannelListResponse {
	channels: DiscordChannel[];
}

export interface DiscordGrantListResponse {
	grants: DiscordConnectorGrant[];
}

export interface DiscordGrantResponse {
	grant: DiscordConnectorGrant;
	/** Present when the grant asked for was not made as asked, and why (#1218). */
	note?: string;
}
