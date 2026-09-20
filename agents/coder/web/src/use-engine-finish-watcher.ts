// Watch the Engine after a delegation — poll until it goes idle, then say what it did (#122).
//
// Lifted out of `CodingTab.tsx` (#776). Three refs and a bounded poll that only ever run
// together: the timer that has to be cancelled, the voice handle that speaks the result, and the
// session id the result belongs to. Each exists for a failure this has already had — a summary
// spoken into a DIFFERENT session's thread after the user switched repos, an engine that never
// went idle and polled forever, and an empty `/explain` reply that ended a session in silence.
// Holding them in one place is what keeps the next reader from re-deriving which ref guards which.

import { useCallback, useEffect, useRef } from "react";
import { api } from "@proagentstore/sdk/client";
import type { Dispatch, SetStateAction } from "react";
import type { CodingSession } from "./types";
import { isEngineBusy } from "./engine-busy";

/** One turn in the Co-pilot thread. `audioKey` is the saved recording a double-tap replays. */
export interface CopilotMessage {
	role: string;
	content: string;
	time?: string;
	audioKey?: string;
}

export function useEngineFinishWatcher({ instanceId, openSession, voice, setSummaryHistory }: {
	instanceId: string;
	openSession: CodingSession | null;
	voice: { maybeSpeakResponse: (text: string) => void };
	setSummaryHistory: Dispatch<SetStateAction<CopilotMessage[]>>;
}) {
	const watcherRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const voiceRef = useRef(voice);
	voiceRef.current = voice;
	// Track the open session so a watcher started for one session can't dump its completion
	// summary (or speak it) into a DIFFERENT session's Co-pilot thread after the user switches
	// repos/sessions. The durable server-side watch still persists the summary to the right
	// session's timeline, so bailing here loses nothing.
	const openSessionRef = useRef<string | null>(null);
	openSessionRef.current = openSession?.id ?? null;
	const watchForFinish = useCallback((sid: string) => {
		if (watcherRef.current) clearTimeout(watcherRef.current);
		let attempts = 0;
		const MAX_ATTEMPTS = 60; // ~3 min max watch time
		const poll = async () => {
			if (openSessionRef.current !== sid) return; // user switched away — stop watching this one
			attempts++;
			if (attempts > MAX_ATTEMPTS) {
				setSummaryHistory((prev) => [...prev, { role: "system", content: "Stopped watching — Engine is taking too long. Check the Terminal view." }]);
				return;
			}
			try {
				const d = await api<{ pane?: string; runState?: string }>(`/v1/instances/${instanceId}/coding/sessions/${sid}/capture`);
				const state = d.runState || "idle";
				if (isEngineBusy(state)) {
					watcherRef.current = setTimeout(poll, 3000);
					return;
				}
				// Engine finished — get a completion summary
				const summary = await api<{ reply?: string }>(`/v1/instances/${instanceId}/coding/sessions/${sid}/explain`, {
					method: "POST",
					// persist:false — the durable server watch workflow already saves this
					// summary; we only need it here to show + speak (avoids a duplicate bubble).
					body: JSON.stringify({ finished: true, persist: false }),
				});
				// Always surface a closing message when the engine goes idle. Previously, if
				// /explain returned an empty reply the session ended SILENTLY (no bubble) — the
				// "session-end message sometimes not shown" bug (#122). Fall back to a clear
				// system note so the user never just sees the agent go quiet.
				const reply = summary.reply?.trim();
				if (reply) {
					setSummaryHistory((prev) => [...prev, { role: "assistant", content: reply }]);
					voiceRef.current.maybeSpeakResponse(reply);
				} else {
					setSummaryHistory((prev) => [...prev, { role: "system", content: "The engine finished and is now idle. Open the Terminal view for the full output." }]);
				}
			} catch {
				setSummaryHistory((prev) => [...prev, { role: "system", content: "Lost connection to the Engine — check your runner." }]);
			}
		};
		watcherRef.current = setTimeout(poll, 4000);
	}, [instanceId, setSummaryHistory]);

	// Cleanup watcher on unmount
	useEffect(() => () => { if (watcherRef.current) clearTimeout(watcherRef.current); }, []);

	return watchForFinish;
}
