// @proagentstore/sdk/hooks — React hooks for agent UIs.
//
// Shared hooks the console shell and agent UIs both call, so every agent's UI
// talks to platform "system services" the same way, exposed on the
// `./hooks` subpath. React is an optional peer dependency (only UIs pull it in).
// More hooks (useInstance, useRunner, useVoice…) move here from the console as
// the agent-OS SDK forms. See ../../PLAN-agent-os.md.

import { useEffect, useRef } from "react";

export { useVoice } from "./voice/use-voice.js";
export { buildTranscribePrompt } from "./voice/prompt.js";

/** Call `fn` every `ms` milliseconds while the component is mounted (and `enabled`). */
export function usePolling(fn: () => void, ms: number, enabled = true): void {
	const savedFn = useRef(fn);
	savedFn.current = fn;

	useEffect(() => {
		if (!enabled || ms <= 0) return;
		const id = setInterval(() => savedFn.current(), ms);
		return () => clearInterval(id);
	}, [ms, enabled]);
}
