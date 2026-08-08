/**
 * Which localhost port ONE e2e run owns (#452).
 *
 * This lives in its own module, with its own tests, because the property it holds cannot be seen
 * by reading the expression: **Playwright re-evaluates `playwright.config.ts` in every worker
 * process.** A port written inline as `4273 + (process.pid % 500)` therefore resolves a DIFFERENT
 * number in the parent and in each worker — measured on 2026-08-08: parent 4282, workers 4288 and
 * 4289, against a server bound to 4282. Every spec would fail to connect, and the reason would be
 * nowhere in the diff.
 *
 * The fix is that the resolved value is written BACK into the environment the workers inherit at
 * spawn, so the second and subsequent evaluations read a decision instead of making a new one.
 * `env` is a parameter rather than a reach for `process.env` so that exact behaviour is testable.
 *
 * Why the default is not a constant: a fixed 4273 on a machine where several full suites run at
 * once by design (#253) is the collision itself. `reuseExistingServer: false` only rejects a port
 * that is already answering when Playwright pre-flights it, so a neighbour's server appearing a
 * moment later is accepted and the whole suite runs against it — reproduced, and the source of a
 * day of `console.spec.ts` failures reported as known-bad on `main`. A pid clash under this
 * scheme gives EADDRINUSE, which is loud; the fixed default gave silence.
 */

export const PORT_BASE = 4273;
export const PORT_SPREAD = 500;

/**
 * @param {Record<string, string | undefined>} env - the run's environment; MUTATED on first call.
 * @param {number} pid - the resolving process's pid.
 * @returns {number} the port every process in this run must use.
 */
export function resolveE2EPort(env, pid) {
	if (!env.E2E_PORT) env.E2E_PORT = String(PORT_BASE + (Math.abs(pid) % PORT_SPREAD));
	return Number(env.E2E_PORT);
}
