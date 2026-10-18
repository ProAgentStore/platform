/**
 * No test writes the machine's real update log (#1151). `logUpdateStep` (packages/cli/src/bootstrap/update-log.ts)
 * appends to `~/.config/proagentstore/update.log` — the file an owner reads after an update that did not come back —
 * and the restart, stub and relay paths under test all call it. Pointed at a per-run temp file here, before any test
 * file loads, and inherited by every child process a test starts.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PAGS_UPDATE_LOG ||= join(tmpdir(), `pags-update-log-test-${process.pid}.log`);
