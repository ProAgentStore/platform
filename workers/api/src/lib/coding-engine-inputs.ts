/**
 * A runner's input ledger as a snapshot reports it (browser-runner coding/input-ledger.ts, #1019). `ledger`
 * names one session's record — an id absent from it proves nothing about another ledger, such as a different
 * runner or the session re-created after a restart — and `epoch` names the engine process, so a replacement
 * process is never credited with what its predecessor read. Entries are `[id, contentDigest, acceptingEpoch]`
 * and `[id, readingEpoch]`, newest last. A dependency-free leaf, like coding-objective-origin.ts.
 */
export interface EngineInputs {
	ledger: string;
	epoch: number;
	accepted: Array<[string, string, number]>;
	consumed: Array<[string, number]>;
}
