// Preloaded into every process the release smoke test starts (`NODE_OPTIONS=--import`, #1152).
//
// `pags up` talks to https://api.proagentstore.online, and a RELEASED version has that address compiled in, so the previous
// release under test cannot be pointed at a fake platform by a setting. This rewrites the two ways any release reaches it —
// global fetch and global WebSocket — onto SMOKE_API, in every child process too (the runner, the launcher) because
// NODE_OPTIONS is inherited. Nothing here runs unless SMOKE_API is set.
const FROM = "https://api.proagentstore.online";
const to = process.env.SMOKE_API;
if (to) {
	const realFetch = globalThis.fetch;
	globalThis.fetch = (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		return realFetch(url.startsWith(FROM) ? to + url.slice(FROM.length) : input, init);
	};
	const RealWebSocket = globalThis.WebSocket;
	if (RealWebSocket) {
		globalThis.WebSocket = class extends RealWebSocket {
			constructor(url, ...rest) {
				super(String(url).replace(/^wss:\/\/api\.proagentstore\.online/, to.replace(/^http/, "ws")), ...rest);
			}
		};
	}
}
