/**
 * Every timing value the cloud and the runner have to AGREE on, in one place (#1358).
 *
 * They used to be literals scattered across the relay Durable Object, the runner client, the capture, the workflow's step options
 * and the CLI, with the rules between them written in comments: "a read fails fast", "the lease outlives a decision", "the wait is
 * shorter than the claim goes stale". A comment cannot fail a build. `runner-timeouts.test.ts` states each rule as an assertion
 * over the values below (and over the values that live elsewhere and are too tied to their module to move), so changing one number
 * until it breaks another is a red test, not a production incident.
 *
 * A leaf: it imports nothing, so the relay DO, the runner client, the capture and the CLI-facing tests can all read it.
 */

/** How long a READ-type runner command waits (terminal capture, snapshot, status): a hung runner must free the socket quickly. */
export const READ_TIMEOUT_MS = 10_000;

/** The longest the relay waits for a runner's reply to any one command; a caller's own timeout can only shorten it. */
export const RELAY_DEFAULT_TIMEOUT_MS = 120_000;

/** How long the relay waits for a pong before it calls a listed socket dead (#846). */
export const RELAY_PONG_DEADLINE_MS = 1_500;

/**
 * How long the CLI keeps forwarding one command to its local runtime before it gives up (`relayLimits.forwardMs`, in the CLI
 * package, which this worker cannot import). It is the BACKSTOP: the relay times out first and tells the CLI to cancel, so this
 * only fires for a relay that never sends the cancel. `scripts/runner-timeouts.test.mjs` pins it to the CLI's real value.
 */
export const CLI_FORWARD_MS = 600_000;

/** One Pilot decision's longest recovery (#907): the ceiling a decide step must outlast. */
export const DECISION_RECOVERY_MAX_MS = 10 * 60_000;

/** The decide step's budget in the workflow (`DECIDE_RETRY.timeout`, "12 minutes"). */
export const DECIDE_STEP_MS = 12 * 60_000;

/** The idle-wait step's budget (`IDLE_RETRY.timeout`, "10 minutes"). */
export const IDLE_STEP_MS = 10 * 60_000;

/**
 * How long one capture keeps the runner believing a platform run owns the session (#1178). The Pilot may spend up to
 * {@link DECIDE_STEP_MS} deciding between two captures, so the lease is longer than that; the next capture renews it.
 */
export const RUN_OWNERSHIP_LEASE_MS = 15 * 60_000;

/** The longest lease the runner honours (`CodingRuntime.MAX_RUN_LEASE_MS`, browser-runner). A longer ask is capped to this. */
export const RUNNER_MAX_RUN_LEASE_MS = 20 * 60_000;
