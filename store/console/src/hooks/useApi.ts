import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../lib/api";

interface UseApiResult<T> {
	data: T | null;
	loading: boolean;
	error: string | null;
	refetch: () => Promise<void>;
}

export function useApi<T>(
	path: string | null,
	opts?: RequestInit,
): UseApiResult<T> {
	const [data, setData] = useState<T | null>(null);
	const [loading, setLoading] = useState(!!path);
	const [error, setError] = useState<string | null>(null);
	const optsRef = useRef(opts);
	optsRef.current = opts;

	const refetch = useCallback(async () => {
		if (!path) return;
		setLoading(true);
		setError(null);
		try {
			const result = await api<T>(path, optsRef.current);
			setData(result);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, [path]);

	useEffect(() => {
		if (path) refetch();
	}, [path, refetch]);

	return { data, loading, error, refetch };
}
