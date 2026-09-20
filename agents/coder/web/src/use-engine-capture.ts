// What `/capture` says about the ENGINE, on the open session's own timer (#248, #545, #731,
// #coding-auth).
//
// Lifted out of `CodingTab.tsx` (#776) rather than added to it. The four reports below are one
// job read from one response: each is a field the runner already sent and the console once
// discarded, and each was added to this poll for the same reason — an engine that is blocked,
// billing per token, forwarding raw stdout, or refusing every turn is otherwise indistinguishable
// from an engine that is merely quiet. Keeping them together is what makes the ORDER below
// reviewable: all four are written before `applyCapture`'s unchanged-pane early return, and that
// is a property of the sequence, not of any one line.
//
// The sign-in relay travels with them because it is the remedy for the first of the four: the
// prompt is read here and the POST that answers it is one call away.
//
// Unlike ./use-runner-status this takes setters rather than owning that state — deliberately.
// `setRepoStatuses`, `setCaptureOnline` and `setSessionAttachment` belong to that hook; this poll
// reads the SAME `/capture` response on a different timer, and a second copy of those three is
// exactly how #241 and #537 happened.

import { useCallback, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import { useTieredPolling } from "@proagentstore/sdk/hooks";
import type { Dispatch, SetStateAction } from "react";
import type { CodingSession } from "./types";
import type { AttachmentAnswer } from "./runner-offline-notice";
import type { CaptureSnapshot } from "./use-terminal-scrollback";
import type { EngineAuthReport } from "./engine-auth-view";
import type { EngineInvocationReport } from "./engine-invocation-mode";
import type { EngineTurnReport } from "./engine-turn-view";
import type { AuthPrompt } from "./EngineSigninPrompt";

export function useEngineCapture({
	instanceId,
	openSession,
	applyCapture,
	terminalBusy,
	setRepoStatuses,
	setCaptureOnline,
	setSessionAttachment,
}: {
	instanceId: string;
	openSession: CodingSession | null;
	applyCapture: (snap: CaptureSnapshot) => void;
	terminalBusy: boolean;
	setRepoStatuses: Dispatch<SetStateAction<Record<string, string>>>;
	setCaptureOnline: Dispatch<SetStateAction<boolean | null>>;
	setSessionAttachment: Dispatch<SetStateAction<AttachmentAnswer | null>>;
}) {
	// Terminal polling (1.5s when a session is open)
	// Engine sign-in relay (#coding-auth): the CLI's OAuth uses a LOOPBACK redirect, so the
	// browser must be on the runner machine — opening the link here would redirect to this
	// laptop's localhost, where nothing is listening.
	const [authPrompt, setAuthPrompt] = useState<AuthPrompt | null>(null);
	/** Which credential the engine actually ran on, straight from /capture (#248). */
	const [engineAuth, setEngineAuth] = useState<EngineAuthReport | null>(null);
	/** Whether the runner is parsing structured events or forwarding raw stdout (#731). */
	const [engineInvocation, setEngineInvocation] = useState<EngineInvocationReport | null>(null);
	/** How the engine's LAST TURN ended, straight from /capture (#545). Null on an older runner. */
	const [lastTurn, setLastTurn] = useState<EngineTurnReport | null>(null);
	const [signinMsg, setSigninMsg] = useState("");
	const startSignin = useCallback(async () => {
		if (!openSession) return;
		setSigninMsg("Opening the sign-in page on your runner machine…");
		try {
			const r = await api<{ ok: boolean; guidance?: string }>(
				`/v1/instances/${instanceId}/coding/sessions/${openSession.id}/signin`,
				{ method: "POST" },
			);
			setSigninMsg(r.ok ? "Opened — take over the browser to finish signing in." : (r.guidance ?? "Use the terminal below to choose an option."));
		} catch (e) {
			setSigninMsg(e instanceof Error ? e.message : String(e));
		}
	}, [instanceId, openSession]);

	const pollTerminal = useCallback(async () => {
		if (!openSession) return;
		try {
			const d = await api<{
				pane?: string;
				runState?: string;
				alive?: boolean;
				authPrompt?: AuthPrompt;
				runnerConnected?: boolean;
				attachment?: AttachmentAnswer;
				auth?: EngineAuthReport;
				invocation?: EngineInvocationReport;
				lastTurn?: EngineTurnReport;
			}>(`/v1/instances/${instanceId}/coding/sessions/${openSession.id}/capture`);
			// An engine blocked on sign-in is otherwise indistinguishable from a dead session:
			// idle state, a pane that stops changing, no error anywhere.
			setAuthPrompt(d.authPrompt ?? null);
			// Which credential this engine actually ran on (#248). MUST be set before the
			// unchanged-pane early return below, or an idle session would never report it.
			setEngineAuth(d.auth ?? null);
			setEngineInvocation(d.invocation ?? null);
			// How the last turn ended (#545). BEFORE the unchanged-pane early return for the same
			// reason: a refusing engine's pane stops changing the moment it starts refusing, which
			// is precisely when this has something to say.
			setLastTurn(d.lastTurn ?? null);
			// The header badge reads `repoStatuses[repoId]`, and the only other writer
			// (`pollStatuses`) is DISABLED while a session is open — so the badge added to say
			// Working/Idle sat on "Idle" for the whole session while the pane visibly scrolled.
			// This response already carries runState; write it. Must be BEFORE the
			// unchanged-text early return below, or a stable pane re-freezes the badge.
			setRepoStatuses((s) => (s[openSession.repoId] === (d.runState || "idle") ? s : { ...s, [openSession.repoId]: d.runState || "idle" }));
			if (typeof d.runnerConnected === "boolean") setCaptureOnline(d.runnerConnected);
			// Same pairing as `pollStatuses`: the diagnosis lives exactly as long as the verdict it
			// explains (#537).
			if (d.runnerConnected === false) setSessionAttachment(d.attachment ?? null);
			else if (d.runnerConnected === true) setSessionAttachment(null);
			// Fold the live pane into the stored scrollback (#432). It is not a REPLACEMENT for
			// the history — it is the same growing transcript — so it is stitched on, and when
			// there is neither the empty state says WHICH of the four causes applies.
			applyCapture(d);
		} catch {
			// IGNORABLE (#291): a 1.5s poll. Keeping the last good pane is the CORRECT response to
			// one dropped read — the terminal contents did not change because we failed to fetch
			// them — and the next tick either succeeds or the runner-offline banner explains the
			// silence. An error state per failed tick would flash faster than it can be read.
		}
		// The three setters are ./use-runner-status's, so they are listed: they arrive through a
		// return value rather than straight from `useState`, which is where the lint can prove a
		// setter is stable. They still are — same setters, same identity — so this changes nothing
		// at runtime and states the dependency truthfully rather than suppressing the question.
	}, [instanceId, openSession, applyCapture, setCaptureOnline, setSessionAttachment, setRepoStatuses]);

	useTieredPolling(pollTerminal, { activeMs: 1500, passiveMs: 6000 }, terminalBusy, !!openSession);

	return { authPrompt, engineAuth, engineInvocation, lastTurn, signinMsg, startSignin };
}
