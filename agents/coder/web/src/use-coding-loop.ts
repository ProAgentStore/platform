import { useState, useRef, useEffect } from "react";
import { api } from "@proagentstore/sdk/client";

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
	/** The repo the open session belongs to — the issue source for issues-mode. */
	repoId?: string | null;
	/** "direct" = user types each objective; "issues" = source it from the next open issue. */
	workMode?: "direct" | "issues";
	onMessage: (msg: { role: string; content: string }) => void;
}

export function useCodingLoop({ instanceId, sessionId, repoId, workMode = "direct", onMessage }: CodingLoopOpts) {
	const [loopOn, setLoopOn] = useState(false);
	const [loopObjective, setLoopObjective] = useState("");
	const [loopIteration, setLoopIteration] = useState(0);
	const [loopMax, setLoopMax] = useState(10);
	const [showLoopForm, setShowLoopForm] = useState(false);
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
	const loopIterationRef = useRef(0);
	const loopMaxRef = useRef(10);
	const onMessageRef = useRef(onMessage);
	const summaryRef = useRef<{ role: string; content: string }[]>([]);
	const repoIdRef = useRef<string | null | undefined>(repoId);
	const workModeRef = useRef(workMode);
	// Issues declined or already completed THIS run — skipped when proposing the next.
	const excludeRef = useRef<Set<number>>(new Set());
	// The issue currently being looped (issues-mode), so 'done' can mark it handled + advance.
	const activeIssueRef = useRef<ProposedIssue | null>(null);
	loopOnRef.current = loopOn;
	loopObjectiveRef.current = loopObjective;
	loopIterationRef.current = loopIteration;
	loopMaxRef.current = loopMax;
	onMessageRef.current = onMessage;
	repoIdRef.current = repoId;
	workModeRef.current = workMode;

	/** Update the summary history ref (call from parent when summaryHistory changes). */
	const syncHistory = (history: { role: string; content: string }[]) => {
		summaryRef.current = history;
	};

	// The loop self-schedules via setTimeout. Track the pending id so we can cancel it
	// on unmount — otherwise navigating away mid-loop keeps firing runStep on a dead
	// component (network calls + setState + the whole closure graph pinned alive).
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => () => {
		loopOnRef.current = false;
		if (timerRef.current) clearTimeout(timerRef.current);
	}, []);

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

	const runStepRef = useRef<() => Promise<void>>(async () => {});
	runStepRef.current = async () => {
		if (!loopOnRef.current || !sessionId) return;
		try {
			const capture = await api<{ pane?: string; runState?: string }>(
				`/v1/instances/${instanceId}/coding/sessions/${sessionId}/capture`,
			);
			const termSnap = capture.pane || "(empty terminal)";
			const runState = capture.runState || "idle";

			if (runState === "thinking" || runState === "working") {
				timerRef.current = setTimeout(() => runStepRef.current?.(), 3000);
				return;
			}

			const recent = [
				...summaryRef.current.slice(-4).map((m) => ({ role: m.role, content: m.content })),
				{ role: "assistant", content: `[Terminal output]\n${termSnap.slice(-2000)}` },
			];

			const decision = await api<{ decision: string; nextInstruction?: string; reason?: string }>(
				`/v1/instances/${instanceId}/loop-decide`,
				{
					method: "POST",
					body: JSON.stringify({
						objective: loopObjectiveRef.current,
						messages: recent,
						iteration: loopIterationRef.current,
						maxIterations: loopMaxRef.current,
					}),
				},
			);

			if (!loopOnRef.current) return;

			if (decision.decision === "continue" && decision.nextInstruction) {
				setLoopIteration((i) => i + 1);
				emitSystem(`Loop ${loopIterationRef.current + 1}/${loopMaxRef.current}: ${decision.nextInstruction}`);

				await api(`/v1/instances/${instanceId}/coding/sessions/${sessionId}/message`, {
					method: "POST",
					body: JSON.stringify({ text: decision.nextInstruction }),
				});

				timerRef.current = setTimeout(() => runStepRef.current?.(), 5000);
			} else if (decision.decision === "done") {
				setLoopOn(false);
				emitSystem(`Loop complete: ${decision.reason || "Objective met."}`);
				// Issues-mode: this issue is handled → don't re-propose it, then offer the next
				// one for approval (approve-per-issue — never auto-chain without the human).
				if (workModeRef.current === "issues" && activeIssueRef.current) {
					excludeRef.current.add(activeIssueRef.current.number);
					activeIssueRef.current = null;
					void proposeNextIssueRef.current();
				}
			} else {
				setLoopOn(false);
				emitSystem(`Loop ${decision.decision}: ${decision.reason || "Needs your input."}`);
				// Escalated/failed → keep the issue (NOT marked done) so you can retry it.
			}
		} catch (e) {
			setLoopOn(false);
			emitSystem(`Loop error: ${e instanceof Error ? e.message : String(e)}`);
		}
	};

	/** Start the loop with an explicit objective (issues-mode approves an issue this way). */
	const startWith = (objective: string) => {
		const obj = objective.trim();
		if (!obj || !sessionId) return;
		loopObjectiveRef.current = obj;
		setLoopObjective(obj);
		setLoopOn(true);
		setLoopIteration(0);
		setShowLoopForm(false);
		emitSystem(`Loop started: ${obj.length > 120 ? `${obj.slice(0, 120)}…` : obj}`);
		api(`/v1/instances/${instanceId}/coding/sessions/${sessionId}/message`, {
			method: "POST",
			body: JSON.stringify({ text: obj }),
		}).then(() => {
			timerRef.current = setTimeout(() => runStepRef.current?.(), 5000);
		});
	};

	const start = () => startWith(loopObjectiveRef.current || loopObjective);

	/** Approve the proposed issue → build its objective and run one issue. */
	const approveProposedIssue = () => {
		const iss = proposedIssue;
		if (!iss) return;
		activeIssueRef.current = iss;
		setProposedIssue(null);
		startWith(`Fix issue #${iss.number}: ${iss.title}${iss.body ? `\n\n${iss.body}` : ""}`);
	};

	/** Skip the proposed issue (leave it open) and propose the next. */
	const skipProposedIssue = () => {
		if (proposedIssue) excludeRef.current.add(proposedIssue.number);
		setProposedIssue(null);
		void proposeNextIssue();
	};

	const stop = () => {
		setLoopOn(false);
		setProposedIssue(null);
		activeIssueRef.current = null;
		emitSystem("Loop stopped by user.");
	};

	return {
		loopOn, loopObjective, setLoopObjective, loopIteration, loopMax, setLoopMax,
		showLoopForm, setShowLoopForm,
		start, stop, syncHistory,
		// Issues-mode
		proposedIssue, issueBusy, proposeNextIssue, approveProposedIssue, skipProposedIssue,
	};
}
