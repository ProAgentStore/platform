import { useState, useRef, useEffect } from "react";
import { api } from "@proagentstore/sdk/client";
import {
	issueWasHandled,
	loopOutcomeNotice,
	loopRaceCancelFailureNotice,
	loopRunEnded,
	loopStartFailureNotice,
	loopStartNotice,
	type LoopRunSnapshot,
} from "./coding-loop-run";

/** The next issue proposed to work (issues-mode). Body included so we build a real objective. */
export interface ProposedIssue {
	number: number;
	title: string;
	body?: string;
	url?: string;
}

interface CodingLoopOpts {
	instanceId: string;
	sessionId: string | null;
	/** The repo the open session belongs to — the issue source, and the engine the run drives. */
	repoId?: string | null;
	/** "direct" = user types each objective; "issues" = source it from the next open issue. */
	workMode?: "direct" | "issues";
	onMessage: (msg: { role: string; content: string }) => void;
}

/**
 * The Coding tab's Loop: a WATCHER over a server-driven run (#374).
 *
 * It used to be the loop itself — `setTimeout`, `/capture`, `/loop-decide`, relay to `/message` —
 * which put an autonomous driver on the human-typing path and therefore outside merge authority
 * (#314), the one-driver-per-engine claim (#208) and the delegation budget (#184). It now presses
 * the same `POST /loop` button the Assistant tab presses, which dispatches through
 * `lib/loop-drivers.ts` to the Pilot with all three in force, and polls `/loop/:runId` to report.
 *
 * The decisions it still makes — what the thread says, and whether issues-mode may strike an issue
 * off — are in ./coding-loop-run, with the reasoning for each.
 */
export function useCodingLoop({ instanceId, sessionId, repoId, workMode = "direct", onMessage }: CodingLoopOpts) {
	const [loopOn, setLoopOn] = useState(false);
	const [loopObjective, setLoopObjective] = useState("");
	const [loopIteration, setLoopIteration] = useState(0);
	const [loopMax, setLoopMax] = useState(10);
	const [showLoopForm, setShowLoopForm] = useState(false);
	// The run being watched. Null while starting, and again once it reaches a terminal state.
	const [runId, setRunId] = useState<string | null>(null);
	// Issues-mode: the issue currently proposed for approval (null = none pending).
	const [proposedIssue, setProposedIssue] = useState<ProposedIssue | null>(null);
	const [issueBusy, setIssueBusy] = useState(false);

	/** Emit a system message to the UI + persist to timeline. */
	const emitSystem = (content: string) => {
		onMessageRef.current({ role: "system", content });
		if (sessionId) {
			api(`/v1/instances/${instanceId}/coding/sessions/${sessionId}/system-message`, {
				method: "POST",
				body: JSON.stringify({ content }),
			}).catch(() => {});
		}
	};

	const loopOnRef = useRef(false);
	const loopObjectiveRef = useRef("");
	const loopMaxRef = useRef(10);
	const runIdRef = useRef<string | null>(null);
	const onMessageRef = useRef(onMessage);
	const repoIdRef = useRef<string | null | undefined>(repoId);
	const workModeRef = useRef(workMode);
	// Issues declined or already completed THIS run — skipped when proposing the next.
	const excludeRef = useRef<Set<number>>(new Set());
	// The issue currently being looped (issues-mode), so a clean finish can mark it handled + advance.
	const activeIssueRef = useRef<ProposedIssue | null>(null);
	loopOnRef.current = loopOn;
	loopObjectiveRef.current = loopObjective;
	loopMaxRef.current = loopMax;
	runIdRef.current = runId;
	onMessageRef.current = onMessage;
	repoIdRef.current = repoId;
	workModeRef.current = workMode;

	// ── Issues-mode: propose / approve / skip ────────────────────────────────
	const proposeNextIssueRef = useRef<() => Promise<void>>(async () => {});
	proposeNextIssueRef.current = async () => {
		const rid = repoIdRef.current;
		if (!rid) return;
		setIssueBusy(true);
		try {
			const ex = [...excludeRef.current].join(",");
			const r = await api<{ issue: ProposedIssue | null; error?: string }>(
				`/v1/instances/${instanceId}/coding/repos/${rid}/next-issue${ex ? `?exclude=${encodeURIComponent(ex)}` : ""}`,
			);
			setProposedIssue(r.issue ?? null);
			if (!r.issue) emitSystem("No more open issues to work — the backlog is clear. 🎉");
		} catch (e) {
			emitSystem(`Couldn't fetch the next issue: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setIssueBusy(false);
		}
	};
	const proposeNextIssue = () => proposeNextIssueRef.current();

	/**
	 * Poll the run the server is driving.
	 *
	 * The old version of this function WAS the loop; this one only reports. Note what it does not
	 * do: it never sends anything to the engine, so there is no path from this tab to the Engine
	 * that skips the Pilot's screen.
	 */
	const pollRunRef = useRef<() => Promise<void>>(async () => {});
	pollRunRef.current = async () => {
		const rid = runIdRef.current;
		if (!rid) return;
		try {
			const run = await api<LoopRunSnapshot>(`/v1/instances/${instanceId}/loop/${rid}`);
			setLoopIteration(run.iteration ?? 0);
			if (!loopRunEnded(run)) return;
			setLoopOn(false);
			loopOnRef.current = false;
			setRunId(null);
			runIdRef.current = null;
			emitSystem(loopOutcomeNotice(run));
			// Issues-mode: only a clean finish strikes the issue off and offers the next one for
			// approval (approve-per-issue — never auto-chain without the human). Every other ending
			// leaves it open so it can be retried; see ./coding-loop-run.
			const issue = activeIssueRef.current;
			activeIssueRef.current = null;
			if (workModeRef.current === "issues" && issue && issueWasHandled(run)) {
				excludeRef.current.add(issue.number);
				void proposeNextIssueRef.current();
			}
		} catch {
			// A transient read failure must not kill the WATCHER — the run is durable and carries
			// on regardless of whether this tab can see it. Clearing the run id here would stop the
			// poll while the Pilot kept driving and spending, with no counter and no Stop button:
			// on screen, identical to a run that finished.
		}
	};

	// 3s, matching the Assistant tab's watcher. Only while there is something to watch.
	useEffect(() => {
		if (!loopOn || !runId) return;
		const t = setInterval(() => { void pollRunRef.current(); }, 3000);
		void pollRunRef.current();
		return () => clearInterval(t);
	}, [loopOn, runId]);

	/** Start the loop with an explicit objective (issues-mode approves an issue this way). */
	const startWith = async (objective: string) => {
		const obj = objective.trim();
		// The REPO, not the session: the driver opens or reuses the session itself, and it is the
		// repo id that tells it which engine the user means. On a multi-repo Coder, omitting it
		// would drive `repos[0]` — a different checkout, and a different session's driver claim.
		if (!obj || !repoIdRef.current) return;
		loopObjectiveRef.current = obj;
		setLoopObjective(obj);
		// Optimistic, so the Stop control and the counter appear on the tap rather than after a
		// round trip that includes opening a session on the user's laptop.
		setLoopOn(true);
		loopOnRef.current = true;
		setLoopIteration(0);
		setShowLoopForm(false);
		try {
			const run = await api<{ runId: string; driver?: string }>(`/v1/instances/${instanceId}/loop`, {
				method: "POST",
				body: JSON.stringify({ objective: obj, maxIterations: loopMaxRef.current, repoId: repoIdRef.current }),
			});
			// Stop pressed while the start was in flight. The run EXISTS now, so flipping a local
			// flag would leave it driving the engine with nothing watching it — cancel it instead.
			if (!loopOnRef.current) {
				try {
					await api(`/v1/instances/${instanceId}/loop/${run.runId}/cancel`, { method: "POST" });
				} catch (e) {
					// The cancel is the ENTIRE mitigation for the sentence above, and its failure
					// used to be swallowed (#291) — so the branch written to avoid an unwatched run
					// created one. Adopt the run instead: it is real and it is driving the engine,
					// so put it back under the watcher, which restores the counter and the Stop
					// button. `stop()` takes the same position for the same reason.
					setLoopOn(true);
					loopOnRef.current = true;
					setRunId(run.runId);
					runIdRef.current = run.runId;
					emitSystem(loopRaceCancelFailureNotice(e));
				}
				return;
			}
			emitSystem(loopStartNotice({ driver: run.driver, objective: obj, maxIterations: loopMaxRef.current }));
			setRunId(run.runId);
			runIdRef.current = run.runId;
		} catch (e) {
			// Without this, a refused start (runner offline, the session already driven, no such
			// repo) left `loopOn` true with nothing to watch: the Stop button and counter 0
			// appeared and then nothing ever happened.
			setLoopOn(false);
			loopOnRef.current = false;
			activeIssueRef.current = null;
			emitSystem(loopStartFailureNotice(e));
		}
	};

	const start = () => startWith(loopObjectiveRef.current || loopObjective);

	/** Approve the proposed issue → build its objective and run one issue. */
	const approveProposedIssue = () => {
		const iss = proposedIssue;
		if (!iss) return;
		activeIssueRef.current = iss;
		setProposedIssue(null);
		void startWith(`Fix issue #${iss.number}: ${iss.title}${iss.body ? `\n\n${iss.body}` : ""}`);
	};

	/** Skip the proposed issue (leave it open) and propose the next. */
	const skipProposedIssue = () => {
		if (proposedIssue) excludeRef.current.add(proposedIssue.number);
		setProposedIssue(null);
		void proposeNextIssue();
	};

	/**
	 * Stop = ask the server to cancel; the watcher stays up and reports the real ending.
	 *
	 * Cooperative, so the Pilot finishes its current step and settles its spend before it stops —
	 * which on a coding run is minutes, not seconds. Faking a local "stopped" here would be a lie
	 * about an engine that is still editing the repo, so the thread says what is actually
	 * happening and the counter keeps moving until the run really ends.
	 */
	const stop = async () => {
		const rid = runIdRef.current;
		setProposedIssue(null);
		if (!rid) {
			// Nothing started yet (or the start is still in flight — `startWith` reads this flag
			// after its POST and cancels the run it created).
			setLoopOn(false);
			loopOnRef.current = false;
			activeIssueRef.current = null;
			emitSystem("Loop stopped by user.");
			return;
		}
		try {
			await api(`/v1/instances/${instanceId}/loop/${rid}/cancel`, { method: "POST" });
			emitSystem("Stopping the loop — the engine finishes its current step first.");
		} catch (e) {
			// Deliberately does NOT clear the watcher: the run is durable and is still going, so
			// pretending otherwise would remove the counter and the Stop button from a run that is
			// still spending — on screen, identical to a stop that worked.
			emitSystem(`Couldn't stop the loop — it's still running. ${e instanceof Error ? e.message : ""}`.trim());
		}
	};

	// Detach when the OPEN SESSION changes. The run belongs to a repo and keeps going on the
	// server; this tab simply stops watching one it is no longer looking at. It is NOT cancelled —
	// that would make switching repos mid-run destroy work, and durability is the point of the
	// change. Not on first mount (prev === current), so a fresh session isn't spuriously reported.
	//
	// The dep list is `[sessionId]` ON PURPOSE and the suppression below is the reason, not an
	// oversight. This is an EDGE DETECTOR: it must run when the session id changes and at no
	// other time. `emitSystem` is redeclared on every render, so listing it would re-run the
	// effect on every render — the opposite of what the list is stating — and taking Biome's
	// advice on a dep list in this codebase has already shipped an outage once (#309, which
	// killed every instance tab in production). The closure it captures is not stale in any way
	// that matters: `emitSystem` only reads `instanceId` and the very `sessionId` this effect is
	// keyed on.
	const prevSessionRef = useRef(sessionId);
	// biome-ignore lint/correctness/useExhaustiveDependencies: edge detector on sessionId — emitSystem is a fresh closure each render, so listing it would fire this every render (see above).
	useEffect(() => {
		if (prevSessionRef.current === sessionId) return;
		prevSessionRef.current = sessionId;
		if (!loopOnRef.current) return;
		loopOnRef.current = false;
		setLoopOn(false);
		setRunId(null);
		runIdRef.current = null;
		setProposedIssue(null);
		activeIssueRef.current = null;
		emitSystem("You switched sessions — the loop keeps running on the server. Stop it from Settings → Loop runs.");
	}, [sessionId]);

	return {
		loopOn, loopObjective, setLoopObjective, loopIteration, loopMax, setLoopMax,
		showLoopForm, setShowLoopForm,
		start, stop,
		// Issues-mode
		proposedIssue, issueBusy, proposeNextIssue, approveProposedIssue, skipProposedIssue,
	};
}
