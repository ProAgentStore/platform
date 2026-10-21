# Cloudflare Email bridge (ProAgentStore #1270)

A Worker you deploy in **your own Cloudflare account** so a private ProAgentStore agent can read
Email Routing mail and send through Email Sending — without Google OAuth and without giving PAGS a
Cloudflare API key. Setup, the sender/route/reply rules, the inbound event format and the audit
guarantees are in [`platform-docs/cloudflare-email-bridge.md`](../../platform-docs/cloudflare-email-bridge.md).

* `src/bridge.ts` — the logic (the `email-worker/v1` contract, the sender check, inbound handling).
  Dependency-free and tested by the PAGS suite.
* `src/index.ts` — wires the real Cloudflare bindings to it.
* `wrangler.toml` — set `DOMAINS`, `SENDERS`, `REPLY_IDENTITIES`, `ROUTES`, create the KV namespace,
  then `wrangler secret put BRIDGE_SECRET` and `wrangler secret put PAGS_INBOUND_URL`.

A routed-only address can receive but is **refused for sending**.
