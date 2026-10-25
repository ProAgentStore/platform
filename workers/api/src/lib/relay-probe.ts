import { rttEcho } from "./relay-liveness.js";

/**
 * The relay connection a candidate CLI opens to prove it CAN (#1148): the same URL, token and WebSocket upgrade as a real
 * runner's, answered here in the Worker and never forwarded to the instance's RelayDO. So it does not take, evict or share an
 * instance's relay slot (one socket per instance per machine), and the running runner is unaffected while the new payload is
 * tried beside it. It speaks the one thing a probe needs — the round-trip echo (`rtt:<id>` → `rtt-echo:<id>`) — says
 * `probe-ok` on open, and closes itself after {@link PROBE_LIFETIME_MS} whatever the client does.
 */
export const PROBE_LIFETIME_MS = 30_000;

interface ProbeSocket {
	accept(): void;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

export type ProbePair = { client: unknown; server: ProbeSocket };

const realPair = (): ProbePair => {
	const pair = new WebSocketPair();
	return { client: pair[0], server: pair[1] as unknown as ProbeSocket };
};

/** The probe's whole behaviour on the Worker-side socket; split from the Response so it can be driven without a WebSocketPair. */
export function serveProbe(server: ProbeSocket, setTimer: (fn: () => void, ms: number) => unknown = setTimeout): void {
	server.accept();
	server.send("probe-ok");
	server.addEventListener("message", (event) => {
		const echo = typeof event.data === "string" ? rttEcho(event.data) : null;
		if (echo) server.send(echo);
	});
	setTimer(() => {
		try {
			server.close(1000, "probe finished");
		} catch {
			/* already closed */
		}
	}, PROBE_LIFETIME_MS);
}

export function relayProbeResponse(makePair: () => ProbePair = realPair): Response {
	const { client, server } = makePair();
	serveProbe(server);
	// `webSocket` is the Workers-only ResponseInit field that completes the upgrade.
	return new Response(null, { status: 101, webSocket: client } as ResponseInit);
}
