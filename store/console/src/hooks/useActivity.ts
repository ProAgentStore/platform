import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import { indexActivity, type ActivityResponse, type InstanceActivity } from "../lib/instanceActivity";

/**
 * Poll what every instance is doing (#815 slice 4).
 *
 * ONE call for the whole account — `GET /v1/instances/my/activity` answers in two queries, which
 * is the reason this screen can have live status at all. The per-card alternative was one
 * `/loop` per instance, and at 43 instances that is not a slow screen, it is a reason not to build
 * the feature.
 *
 * ── A failed poll keeps the last answer and MARKS it
 *
 * It does not blank the list, and it does not silently keep showing stale dots as if they were
 * fresh. #291's rule: a fallback indistinguishable from a real answer is the dangerous one. So
 * `stale` becomes true and `asOf` says how old the data on screen is; the caller decides how loudly
 * to say so. Every value here is time-relative, which is why the endpoint sends `asOf` at all.
 *
 * ── Paused when the tab is hidden
 *
 * A dashboard left open in a background tab is the common case, and polling it is spend with
 * nobody reading it. Resuming fires immediately rather than waiting out the interval, because the
 * first thing someone does on returning is look at the dots.
 */
export const ACTIVITY_POLL_MS = 15_000;

export interface ActivityState {
	byInstance: Map<string, InstanceActivity>;
	/** ms epoch the server computed these verdicts. 0 before the first successful poll. */
	asOf: number;
	/** True once a poll has failed and the data on screen is older than it looks. */
	stale: boolean;
	refresh: () => void;
}

export function useActivity(enabled: boolean): ActivityState {
	const [byInstance, setByInstance] = useState<Map<string, InstanceActivity>>(new Map());
	const [asOf, setAsOf] = useState(0);
	const [stale, setStale] = useState(false);
	// Read inside the interval so a re-render does not reschedule it.
	const enabledRef = useRef(enabled);
	enabledRef.current = enabled;

	const load = useCallback(async () => {
		try {
			const data = await api<ActivityResponse>("/v1/instances/my/activity");
			setByInstance(indexActivity(data));
			setAsOf(data.asOf || Date.now());
			setStale(false);
		} catch {
			// Deliberately keeps `byInstance`. An instance that WAS stalled 30 seconds ago still
			// most likely is, and blanking the column would replace a slightly old truth with no
			// information at all — then invite the reading that everything is fine.
			setStale(true);
		}
	}, []);

	useEffect(() => {
		if (!enabled) return;
		let timer: ReturnType<typeof setInterval> | null = null;
		const tick = () => {
			if (!document.hidden && enabledRef.current) void load();
		};
		const start = () => {
			if (timer) return;
			timer = setInterval(tick, ACTIVITY_POLL_MS);
		};
		const stop = () => {
			if (timer) clearInterval(timer);
			timer = null;
		};
		const onVisibility = () => {
			if (document.hidden) {
				stop();
			} else {
				// Fire at once rather than waiting out the interval: the first thing someone does on
				// coming back to this tab is read the dots, and a 15-second-old screen is the one
				// state this whole poll exists to avoid.
				void load();
				start();
			}
		};
		void load();
		start();
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			stop();
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [enabled, load]);

	return { byInstance, asOf, stale, refresh: load };
}
