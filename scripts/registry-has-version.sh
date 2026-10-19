#!/usr/bin/env bash
# Does the MCP registry already hold <name> at <version>? (#1227)
#
#   scripts/registry-has-version.sh io.github.ProAgentStore/platform 0.1.155
#
# Exit 0 — published (HTTP 200).  Exit 10 — not published (HTTP 404).  Exit 1 — the registry could
# not be asked, with the HTTP status and the endpoint named.
#
# It asks the BY-NAME endpoint for the exact version, not `/v0/servers?search=`: the search endpoint
# answered HTTP 504 after ~3 minutes in every failed publish run (38993491470, 39176456274,
# 39187059839) and was still timing out on 2026-10-19, while the by-name endpoint answered at once.
#
# Retries a 5xx, a 429 and a timeout or connection failure (HTTP 000) — 4 attempts, waiting 5s, 15s,
# then 30s between them. Any other status is not transient and fails at once. "Could not ask" never
# reads as "nothing to publish" (ADR 0002).
set -uo pipefail

name="${1:?usage: registry-has-version.sh <name> <version>}"
version="${2:?usage: registry-has-version.sh <name> <version>}"
base="${MCP_REGISTRY_BASE:-https://registry.modelcontextprotocol.io}"
encoded=$(jq -rn --arg n "$name" '$n | @uri')
url="${base}/v0/servers/${encoded}/versions/${version}"
delays=(5 15 30)

for attempt in 1 2 3 4; do
	code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 60 "$url" 2>/dev/null || true)
	code="${code:-000}"
	case "$code" in
		200) echo "registry: ${name} ${version} is published (HTTP 200 from ${url})"; exit 0 ;;
		404) echo "registry: ${name} ${version} is not published (HTTP 404 from ${url})"; exit 10 ;;
		5??|429|000) ;;
		*) echo "::error::MCP registry answered HTTP ${code} for ${url} — not a transient status, so not retried." >&2; exit 1 ;;
	esac
	if [ "$attempt" -lt 4 ]; then
		wait="${delays[$((attempt - 1))]}"
		echo "registry: attempt ${attempt}/4 got HTTP ${code} from ${url}; retrying in ${wait}s"
		sleep "$wait"
	fi
done
what=$([ "$code" = "000" ] && echo "no response (timeout or connection failure)" || echo "HTTP ${code}")
echo "::error::MCP registry unavailable: ${what} from ${url} on all 4 attempts (waited 5s, 15s, 30s). Re-run this workflow once the registry recovers." >&2
exit 1
