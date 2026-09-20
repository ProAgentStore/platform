// The four things you can do TO an open session: end it, restart the CLI inside it, abandon it
// for a clean one, and copy its conversation out.
//
// Lifted out of `CodingTab.tsx` (#776). They belong together because they are one control group
// — the header menu renders all four, and the single-repo strip renders three of them — and
// because each is a write whose local effect must not outrun the server's answer. The pair worth
// reading next to each other is `endSession` and `freshStart`: both POST `/end`, and the
// difference between them is the `fresh: true` on what comes after.
//
// Plain functions rather than `useCallback`s, deliberately unchanged from where they lived: they
// are re-created every render today, the header hook owns the dep list that stops that being a
// render storm, and memoising them here would be a behaviour change smuggled into a move.

import { api } from "@proagentstore/sdk/client";
import type { Dispatch, SetStateAction } from "react";
import type { CodingSession } from "./types";
import { timelineExcerpt, type TimelinePayload } from "./timeline-chat";
import type { CopilotMessage } from "./use-engine-finish-watcher";

export function useSessionCommands({
	instanceId,
	openSession,
	defaultEngine,
	closeTerminal,
	loadCoding,
	openTerminal,
	setTerminalText,
	setSummaryHistory,
}: {
	instanceId: string;
	openSession: CodingSession | null;
	defaultEngine: string;
	closeTerminal: () => void;
	loadCoding: () => Promise<void>;
	openTerminal: (session: CodingSession) => Promise<void>;
	setTerminalText: (text: string) => void;
	setSummaryHistory: Dispatch<SetStateAction<CopilotMessage[]>>;
}) {
	const endSession = async () => {
		if (!openSession) return;
		await api(`/v1/instances/${instanceId}/coding/sessions/${openSession.id}/end`, { method: "POST" });
		closeTerminal();
		loadCoding();
	};

	const restartSession = async () => {
		if (!openSession) return;
		try {
			await api(`/v1/instances/${instanceId}/coding/sessions/${openSession.id}/restart`, { method: "POST" });
			setTerminalText("(restarting CLI...)");
			setSummaryHistory([]);
		} catch (e) {
			alert("Restart failed: " + (e instanceof Error ? e.message : String(e)));
		}
	};

	// End current session + start a brand new one (clean state). `fresh: true` is load-bearing
	// since #408: a new session continues the repo's recent conversation by default, and the one
	// this just ended is the most recent there is — without the flag this hands back the exact
	// state the user pressed it to escape.
	const freshStart = async () => {
		if (!openSession) return;
		const repoId = openSession.repoId;
		try {
			await api(`/v1/instances/${instanceId}/coding/sessions/${openSession.id}/end`, { method: "POST" });
			const d = await api<{ session: CodingSession }>(`/v1/instances/${instanceId}/coding/sessions`, {
				method: "POST",
				body: JSON.stringify({ repoId, engineId: defaultEngine, fresh: true }),
			});
			if (d.session) {
				await loadCoding();
				openTerminal(d.session);
			}
		} catch (e) {
			alert("Fresh start failed: " + (e instanceof Error ? e.message : String(e)));
		}
	};

	const copySummaryJson = async () => {
		if (!openSession) return;
		try {
			const d = await api<TimelinePayload>(`/v1/instances/${instanceId}/coding/sessions/${openSession.id}/timeline?full=1`);
			const entries = timelineExcerpt(d);
			await navigator.clipboard.writeText(JSON.stringify({ sessionId: openSession.id, count: entries.length, timeline: entries }, null, 2));
		} catch (e) {
			alert("Copy failed: " + (e instanceof Error ? e.message : String(e)));
		}
	};

	return { endSession, restartSession, freshStart, copySummaryJson };
}
