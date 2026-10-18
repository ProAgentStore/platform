/**
 * Classify an error message as a TRANSIENT infrastructure event rather than a bug.
 * The main case: a Durable Object / isolate reset triggered by a code deploy, which
 * briefly interrupts in-flight work. A durable Workflow should retry/resume through it
 * (that's the point of Workflows surviving deploys), and it must NOT be logged as a
 * crash — otherwise every deploy manufactures fake "workflow crashed" errors that bury
 * the real ones. Pure + tested.
 *
 * Also an EVICTED Durable Object (#1159): a RelayDO evicted or redeployed while a runner command
 * is in flight makes `stub.fetch` throw "Connection closed: this Durable Object instance is no
 * longer active". The next request gets a fresh instance, so it is the same transient event.
 */
export function isTransientInfraError(msg: string): boolean {
	const m = (msg || "").toLowerCase();
	return (
		m.includes("durable object reset") ||
		m.includes("code was updated") ||
		m.includes("object has been reset") ||
		m.includes("reset because") ||
		m.includes("durable object instance is no longer active")
	);
}
