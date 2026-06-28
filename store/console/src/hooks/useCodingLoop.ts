import { useState, useRef } from "react";
import { api } from "../lib/api";

interface CodingLoopOpts {
	instanceId: string;
	sessionId: string | null;
	onMessage: (msg: { role: string; content: string }) => void;
}

export function useCodingLoop({ instanceId, sessionId, onMessage }: CodingLoopOpts) {
	const [loopOn, setLoopOn] = useState(false);
	const [loopObjective, setLoopObjective] = useState("");
	const [loopIteration, setLoopIteration] = useState(0);
	const [loopMax, setLoopMax] = useState(10);
	const [showLoopForm, setShowLoopForm] = useState(false);

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
	loopOnRef.current = loopOn;
	loopObjectiveRef.current = loopObjective;
	loopIterationRef.current = loopIteration;
	loopMaxRef.current = loopMax;
	onMessageRef.current = onMessage;

	/** Update the summary history ref (call from parent when summaryHistory changes). */
	const syncHistory = (history: { role: string; content: string }[]) => {
		summaryRef.current = history;
	};

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
				setTimeout(() => runStepRef.current?.(), 3000);
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

				setTimeout(() => runStepRef.current?.(), 5000);
			} else if (decision.decision === "done") {
				setLoopOn(false);
				emitSystem(`Loop complete: ${decision.reason || "Objective met."}`);
			} else {
				setLoopOn(false);
				emitSystem(`Loop ${decision.decision}: ${decision.reason || "Needs your input."}`);
			}
		} catch (e) {
			setLoopOn(false);
			emitSystem(`Loop error: ${e instanceof Error ? e.message : String(e)}`);
		}
	};

	const start = () => {
		if (!loopObjective.trim() || !sessionId) return;
		setLoopOn(true);
		setLoopIteration(0);
		setShowLoopForm(false);
		emitSystem(`Loop started: ${loopObjective}`);
		api(`/v1/instances/${instanceId}/coding/sessions/${sessionId}/message`, {
			method: "POST",
			body: JSON.stringify({ text: loopObjective.trim() }),
		}).then(() => {
			setTimeout(() => runStepRef.current?.(), 5000);
		});
	};

	const stop = () => {
		setLoopOn(false);
		emitSystem("Loop stopped by user.");
	};

	return {
		loopOn, loopObjective, setLoopObjective, loopIteration, loopMax, setLoopMax,
		showLoopForm, setShowLoopForm,
		start, stop, syncHistory,
	};
}
