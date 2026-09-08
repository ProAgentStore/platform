import { useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import type { Instance } from "../lib/types";

/**
 * The instance record behind `/instances/:id/*`, and whether it exists at all (#784).
 *
 * Pulled out of `InstanceDetail` for two reasons. The page had one state — `instance | null` —
 * for three situations: not fetched yet, fetched and found, fetched and NOT found. The third
 * rendered exactly like the first, forever: a bookmark to a deleted instance (which #784 makes
 * a first-class thing to have) opened a page that was silently, permanently loading. The hook
 * returns `missing` as its own fact so the page can say what happened.
 *
 * The second reason is the page's size pin: the fetch is the same code it always was, moved
 * so the not-found branch has room to exist.
 *
 * `live` guards the write the way the original effect did: a response that outlives its effect
 * must never land, because the capabilities it sets decide which tabs render — the
 * wrong-agent-on-screen bug (#240).
 */
export function useInstanceRecord(id: string | undefined): { instance: Instance | null; missing: boolean } {
	const [instance, setInstance] = useState<Instance | null>(null);
	const [missing, setMissing] = useState(false);

	useEffect(() => {
		if (!id) return;
		let live = true;
		setInstance(null);
		setMissing(false);
		(async () => {
			try {
				const data = await api<{ instances: Instance[] }>("/v1/instances/my/instances");
				const inst = (data.instances || []).find((i) => i.id === id || i.slug === id);
				if (!live) return;
				if (inst) setInstance(inst);
				// A successful list that does not contain the id is the only honest "missing": a
				// failed list is a failed list, and stays on the loading state it always had.
				else setMissing(true);
			} catch (e) {
				console.error(e);
			}
		})();
		return () => {
			live = false;
		};
	}, [id]);

	return { instance, missing };
}
