import { api } from "@proagentstore/sdk/client";
import { useTieredPolling } from "@proagentstore/sdk/hooks";
import { useCallback, useEffect, useRef, useState } from "react";
import { type FleetResponse, type FleetTier, mergeFleet, POLL_MS } from "../lib/fleetTelemetry";

/**
 * The fleet's telemetry, live (#1259): one full load for the chosen range, then about one heartbeat apart only what is NEW
 * (`since=` the newest point held), folded in by `mergeFleet`. The page is never a snapshot and never reloads.
 *
 * A failed poll keeps the last good data and says so (`error`) rather than blanking the graphs; changing the range starts over.
 */
export function useFleet(tier: FleetTier): { data: FleetResponse | null; loading: boolean; error: string | null; updatedAt: number | null; nowMs: number; reload: () => Promise<void> } {
	const [data, setData] = useState<FleetResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [updatedAt, setUpdatedAt] = useState<number | null>(null);
	const [nowMs, setNowMs] = useState(() => Date.now());
	const held = useRef<FleetResponse | null>(null);
	const tierRef = useRef(tier);
	tierRef.current = tier;

	const fetchOnce = useCallback(async (full: boolean) => {
		const asked = tierRef.current;
		const cursor = !full && held.current?.tier === asked ? held.current.cursor : null;
		try {
			const qs = new URLSearchParams({ tier: asked });
			if (cursor) qs.set("since", cursor);
			const next = await api<FleetResponse>(`/v1/terminals/resources?${qs.toString()}`);
			if (tierRef.current !== asked) return; // the range changed while this was in flight: its answer is for a chart no longer shown
			const now = Date.now();
			held.current = mergeFleet(cursor ? held.current : null, next, now);
			setData(held.current);
			setError(null);
			setUpdatedAt(now);
			setNowMs(now);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
		setLoading(false);
	}, []);

	// A new range is a new chart: drop what is held and load it whole.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `tier` is the trigger — a new range starts over; the effect reads it through tierRef.
	useEffect(() => {
		held.current = null;
		setLoading(true);
		void fetchOnce(true);
	}, [tier, fetchOnce]);

	useTieredPolling(() => void fetchOnce(false), { activeMs: POLL_MS, passiveMs: POLL_MS * 2 }, true);
	return { data, loading, error, updatedAt, nowMs, reload: () => fetchOnce(true) };
}
