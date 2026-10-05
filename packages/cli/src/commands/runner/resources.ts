import os from "node:os";

/**
 * The machine's resource sample, sent on the runner heartbeat (#924).
 *
 * In-process `os` reads only — no exec, no timer of its own — taken once per 30s heartbeat, so the
 * platform can say whether a machine was out of CPU or memory when its relay went quiet. The
 * platform validates and interprets it (`workers/api/src/lib/runner-resources.ts`).
 */
export interface ResourceSample {
	loadAvg: [number, number, number];
	cpus: number;
	memTotalBytes: number;
	memFreeBytes: number;
	platform: string;
	sampledAt: number;
}

export function sampleResources(read: Pick<typeof os, "loadavg" | "cpus" | "totalmem" | "freemem" | "platform"> = os, now: number = Date.now()): ResourceSample {
	const [l1 = 0, l5 = 0, l15 = 0] = read.loadavg();
	return {
		loadAvg: [l1, l5, l15],
		// `availableParallelism` would be better, but `cpus()` is what every supported Node has.
		cpus: Math.max(1, read.cpus().length),
		memTotalBytes: read.totalmem(),
		memFreeBytes: read.freemem(),
		platform: read.platform(),
		sampledAt: now,
	};
}
