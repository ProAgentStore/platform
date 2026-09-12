import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import { useTieredPolling } from "@proagentstore/sdk/hooks";
import type { CodingSession } from "./types";
import { anyEngineBusy } from "./engine-busy";
import { resolveRunnerOnline } from "./runner-online";
import { type AttachmentAnswer, runnerOfflineNotice } from "./runner-offline-notice";

/**
 * Is the user's machine reachable, why not when it isn't, and what is each repo's engine doing.
 *
 * This owns its five pieces of state outright rather than taking setters, which is the whole
 * reason it is a hook and not a function CodingTab calls: `relayOnline`, `captureOnline`, the two
 * attachment diagnoses and `repoStatuses` are only ever written by the two polls below. Anything
 * that took them as arguments would be a second writer, and a second writer is how the header dot
 * and the tab body came to disagree in the first place.
 *
 * Two connectivity signals rather than one flag (#241). The flag was writable only from a live
 * session's capture, so once the runner dropped AND the session ended, `false` could never be
 * cleared — the offline state was unrecoverable while `pags up` was demonstrably running.
 * `checkRelay` polls independently of any session, on the same route the header dot and the
 * Settings tab read, so the tab recovers by itself and the two cannot report different things.
 *
 * Two attachment diagnoses because they answer different questions (#537): `/capture` knows the
 * SESSION's machine, `/runtime/status` knows the instance's. A boolean cannot carry either — with
 * one machine off and another running `pags up`, the only remedy a boolean can express is "run
 * `pags up`", read by someone already running it. ./runner-offline-notice decides which wins.
 *
 * `setCaptureOnline`, `setSessionAttachment` and `setRepoStatuses` come back out because the
 * open-session terminal poll writes all three from the same `/capture` response — it is the same
 * reading, taken on a different timer, and giving it its own copy would recreate the disagreement.
 */
export function useRunnerStatus({ instanceId, sessions, openSession }: {
	instanceId: string;
	sessions: CodingSession[];
	openSession: CodingSession | null;
}) {
	const [relayOnline, setRelayOnline] = useState<boolean | null>(null);
	const [captureOnline, setCaptureOnline] = useState<boolean | null>(null);
	const [sessionAttachment, setSessionAttachment] = useState<AttachmentAnswer | null>(null);
	const [relayAttachment, setRelayAttachment] = useState<AttachmentAnswer | null>(null);
	const [repoStatuses, setRepoStatuses] = useState<Record<string, string>>({});

	// Repo status polling (3s) — use ref for sessions to avoid interval restarts
	const sessionsRef = useRef(sessions);
	sessionsRef.current = sessions;
	const hasActiveSessions = sessions.some((s) => s.status === "active");

	// The one answer the whole tab reads. A capture's verdict is dropped as soon as the sessions
	// that produced it are gone, so an offline state always clears itself once the runner is back.
	const runnerOnline = resolveRunnerOnline({ relay: relayOnline, capture: captureOnline, hasActiveSessions });
	// One sentence for every offline banner on this tab, so two of them cannot say different
	// things about the same machine (#537).
	const offlineNotice = runnerOfflineNotice({ runnerOnline, sessionAttachment, relayAttachment });

	// Authoritative relay check, on a timer that does NOT require a session to exist — the missing
	// piece that made the offline state unrecoverable (#241). Same route the header dot and the
	// Settings tab use, so the header and this body cannot report different things.
	const checkRelay = useCallback(async () => {
		try {
			const d = await api<{ relay?: { connected?: boolean }; attachment?: AttachmentAnswer }>(`/v1/instances/${instanceId}/runtime/status`);
			setRelayOnline(d.relay?.connected === true);
			// Already in this response and previously discarded — it is what names a stale "Runs on"
			// pin, and the banner had no way to say that (#461/#537).
			setRelayAttachment(d.attachment ?? null);
		} catch {
			setRelayOnline(false);
			setRelayAttachment(null);
		}
	}, [instanceId]);
	useEffect(() => { void checkRelay(); }, [checkRelay]);
	// 10s while it matters, not the header's 4s: this exists to notice the runner COMING BACK.
	//
	// It is treated as "busy" whenever we believe the runner is OFFLINE, not only when an engine
	// is running — offline is exactly the state a change is imminent from and worth watching for,
	// and slowing it down would regress #241 (the unrecoverable offline state). A settled ONLINE
	// runner is the opposite: a boolean that changes about twice a day, so once a minute while
	// you are looking at it, and not at all while the tab is in the background.
	const relayWatchBusy = anyEngineBusy(repoStatuses) || relayOnline === false;
	useTieredPolling(checkRelay, { activeMs: 10000, passiveMs: 60000 }, relayWatchBusy);

	const pollStatuses = useCallback(async () => {
		const activeSessions = sessionsRef.current.filter((s) => s.status === "active");
		if (!activeSessions.length) return;
		const results = await Promise.allSettled(
			activeSessions.map((s) =>
				api<{ runState?: string; runnerConnected?: boolean; attachment?: AttachmentAnswer }>(
					`/v1/instances/${instanceId}/coding/sessions/${s.id}/capture`,
				).then((d) => ({ repoId: s.repoId, state: d.runState || "idle", connected: d.runnerConnected, attachment: d.attachment ?? null }))
			),
		);
		const statuses: Record<string, string> = {};
		for (let i = 0; i < results.length; i++) {
			const r = results[i];
			if (r.status === "fulfilled") {
				statuses[r.value.repoId] = r.value.state;
				if (r.value.connected !== undefined) setCaptureOnline(r.value.connected);
				// Held only while the capture that produced it still says offline. A diagnosis that
				// outlived its verdict would explain a banner that is no longer on screen.
				if (r.value.connected === false) setSessionAttachment(r.value.attachment);
				else if (r.value.connected === true) setSessionAttachment(null);
			} else {
				statuses[activeSessions[i].repoId] = "offline";
			}
		}
		setRepoStatuses(statuses);
	}, [instanceId]);

	// One `/capture` per active session, per tick — so N idle sessions cost N relay round-trips
	// to the user's laptop every 3s to re-learn "still idle". Full rate only while an engine is
	// actually mid-turn.
	useTieredPolling(pollStatuses, { activeMs: 3000, passiveMs: 12000 }, anyEngineBusy(repoStatuses), hasActiveSessions && !openSession);

	return { runnerOnline, offlineNotice, repoStatuses, setRepoStatuses, setCaptureOnline, setSessionAttachment, sessionsRef };
}
