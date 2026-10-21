import { type BridgeEnv, handleInbound, handleRequest, type RoutedEmail } from "./bridge.js";

// The deployed Worker: wires the real Cloudflare bindings (declared in wrangler.toml) to the pure
// handlers in bridge.ts, which is where the logic — and its tests — live.
export default {
	fetch: (req: Request, env: BridgeEnv): Promise<Response> => handleRequest(req, env),
	email: async (message: RoutedEmail, env: BridgeEnv): Promise<void> => {
		await handleInbound(message, env);
	},
};
