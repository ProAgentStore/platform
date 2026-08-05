import { useEffect, useRef } from "react";

/**
 * Render a plain DOM node inside React's tree.
 *
 * The bridge for agent-published surfaces: a bundle owns a vanilla DOM subtree and may ship its own
 * framework, so when it hands the platform a header it hands an `HTMLElement`, not a React node —
 * handing it React is exactly the coupling `DynamicSurface` exists to avoid. This adopts that
 * element into the shell's header slot without either side knowing about the other's renderer.
 *
 * Adopting, not cloning: the bundle keeps the reference it created and can keep updating the node
 * (a live status, a spinner) after handing it over. On unmount the node is released rather than
 * destroyed, so the bundle can hand back the same element if the surface remounts.
 */
export default function HostedNode({ el }: { el: HTMLElement }) {
	const host = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const parent = host.current;
		if (!parent) return;
		parent.appendChild(el);
		return () => {
			// Only remove what we actually adopted — the bundle may already have moved it.
			if (el.parentNode === parent) parent.removeChild(el);
		};
	}, [el]);

	return <div ref={host} className="contents" />;
}
