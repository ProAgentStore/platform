/**
 * The Secure link, from the relay's own lifecycle lines (#1300).
 *
 * `pags up` marked the link online on "Relay connected:" and nothing took it back: the real "Relay disconnected: … — reconnecting
 * in Ns" left the pane saying "connected to ProAgentStore" for as long as the socket was down. And a runner holds one relay
 * PER AGENT, so a single flag cannot be right: one agent connecting is not "all connected", and one dropping must not mark the
 * healthy ones offline. This keeps the state per agent (by the 8-character id the lines carry) and reduces it.
 *
 * Registration and heartbeat are separate facts with their own status lines; nothing here touches them.
 */
export type LinkState = "starting" | "online" | "offline";

export interface LinkSummary {
	tunnel: LinkState;
	/** What to say on the Secure link row instead of its stock sentence, or "" for the stock one. */
	note: string;
	/** The event for the status line, when the line changed anything. */
	event: string;
}

type Per = "connecting" | "connected" | "reconnecting" | "conflict";

const LINE = /^Relay (connected|disconnected|conflict cleared|conflict): ([0-9a-zA-Z-]+)…/;

export class RelayLinks {
	private readonly agents = new Map<string, Per>();
	private readonly reasons = new Map<string, string>();

	constructor(ids: Iterable<string> = []) {
		for (const id of ids) this.agents.set(id.slice(0, 8), "connecting");
	}

	/** Apply one complete runner output line. Returns null for a line that is not a relay lifecycle line. */
	apply(line: string): LinkSummary | null {
		const m = LINE.exec(line.trim());
		if (!m) return null;
		const id = m[2].slice(0, 8);
		switch (m[1]) {
			case "connected":
				this.agents.set(id, "connected");
				this.reasons.delete(id);
				break;
			case "disconnected":
				this.agents.set(id, "reconnecting");
				this.reasons.set(id, (/\(([^)]*)\)/.exec(line)?.[1] ?? "").trim());
				break;
			case "conflict":
				this.agents.set(id, "conflict");
				break;
			case "conflict cleared":
				this.agents.set(id, "reconnecting");
				break;
		}
		return this.summary(m[1] === "connected" ? "Relay connected" : m[1] === "conflict" ? "Another runner holds an agent — run `pags up --force` here to take it over" : m[1] === "conflict cleared" ? "Relay conflict cleared — reattaching" : `Relay disconnected${this.reasons.get(id) ? ` (${this.reasons.get(id)})` : ""} — reconnecting`);
	}

	summary(event = ""): LinkSummary {
		const all = [...this.agents.values()];
		const total = all.length;
		const up = all.filter((s) => s === "connected").length;
		const conflicts = all.filter((s) => s === "conflict").length;
		if (total === 0 || (up === 0 && all.every((s) => s === "connecting"))) return { tunnel: "starting", note: "", event };
		if (up === total) return { tunnel: "online", note: "", event };
		const lost = total - up;
		if (up === 0) {
			return { tunnel: "offline", note: conflicts === total ? "another runner holds this agent — run `pags up --force` to take it over" : "lost the connection — reconnecting automatically", event };
		}
		return { tunnel: "starting", note: `${up} of ${total} agents connected — ${lost} reconnecting${conflicts ? ` (${conflicts} held by another runner: \`pags up --force\`)` : ""}`, event };
	}
}
