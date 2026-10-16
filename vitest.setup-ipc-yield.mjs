/**
 * One real event-loop turn before every test (#1093).
 *
 * A worker reports progress to the main process over vitest's RPC (`onTaskUpdate`), and the call
 * times out after 60s. The main process answers in milliseconds, but the worker can only READ the
 * answer when its own event loop reaches the I/O phase. A file whose tests settle entirely in
 * promise microtasks — synchronous `node:sqlite`, in-memory `app.request`, `spawnSync` — never gets
 * there: measured, `application-runner-routes.test.ts` alone ran 23.8s of tests as ONE 23.7s stall,
 * and in a loaded full suite the same file and `fail-before.test.mjs` stalled 72.7s and 87.6s. When the
 * loop finally turned, the timer phase ran before the I/O phase, so the 60s timeout fired on a reply
 * that had already arrived — "Timeout calling onTaskUpdate", with no test failing.
 *
 * Yielding through `setImmediate` lets the loop pass its I/O phase between tests, so a stall is bounded
 * by ONE test, not a whole file. The native function is captured at load, before any test installs fake
 * timers, so a test that fakes `setImmediate` cannot make this hang.
 */
import { beforeEach } from "vitest";

const realSetImmediate = globalThis.setImmediate;
beforeEach(() => new Promise((resolve) => realSetImmediate(resolve)));
