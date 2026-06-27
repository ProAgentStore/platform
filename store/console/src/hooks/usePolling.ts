import { useEffect, useRef } from "react";

/** Call `fn` every `ms` milliseconds while the component is mounted. */
export function usePolling(fn: () => void, ms: number, enabled = true) {
	const savedFn = useRef(fn);
	savedFn.current = fn;

	useEffect(() => {
		if (!enabled || ms <= 0) return;
		const id = setInterval(() => savedFn.current(), ms);
		return () => clearInterval(id);
	}, [ms, enabled]);
}
