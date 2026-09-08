import { useEffect, useState } from "react";
import { useHref } from "react-router-dom";
import Button from "./Button";
import Card from "./Card";

/**
 * "Save this instance to your home screen" (#784) — the direct-entry half of the ticket.
 *
 * ── What already existed, and what did not
 *
 * The stable URL was never the missing piece: `/instances/:id/*` has been the route since the
 * console was built, `lib/console-links.ts` builds it for every notification, and it opens on
 * the Assistant tab with the existing session (no token of its own — the shell's auth gate is
 * what signs the visit in). What was missing is that nothing SHOWED the URL to the owner, and
 * that installing the console as an app opened the instance LIST regardless of where you
 * installed it from: `store/manifest.json` has `start_url: "/console/"`, and both Chrome and
 * Safari read `start_url` at install time and open it, not the page you were on.
 *
 * ── How the install lands on the instance
 *
 * While this panel is mounted, the document's `<link rel="manifest">` points at
 * `/manifest.json?start=<this instance's path>&name=<this instance's name>`. The host worker
 * serves the same manifest with `start_url` and the names substituted (validated there, see
 * `workers/host/src/manifest.ts`), so "Add to Home Screen" from this page installs an icon that
 * opens THIS instance. The link is put back on unmount, so installing from anywhere else still
 * installs the console. The host caches the pinned manifest for an hour, the default for a day.
 *
 * ── What it does not do
 *
 * It does not create a token, a second route, or a per-device record. A shortcut is a URL; the
 * owner's session is what makes it theirs. A deleted instance behind a shortcut lands on the
 * page's own not-found state (`useInstanceRecord`), never on a silent loader.
 */
export default function HomeScreenShortcut({ instanceId, instanceName }: { instanceId: string; instanceName?: string }) {
	// `useHref` folds in the router's basename, so the same code is right on
	// proagentstore.online/console/… and on console.proagentstore.online/….
	const path = useHref(`/instances/${instanceId}`);
	const url = typeof window === "undefined" ? path : `${window.location.origin}${path}`;
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
		if (!link) return;
		const previous = link.getAttribute("href");
		const qs = new URLSearchParams({ start: path, name: (instanceName || "Agent").slice(0, 30) });
		link.setAttribute("href", `/manifest.json?${qs.toString()}`);
		return () => {
			if (previous) link.setAttribute("href", previous);
		};
	}, [path, instanceName]);

	const copy = () => {
		void navigator.clipboard?.writeText(url).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		});
	};

	return (
		<Card>
			<div className="flex items-center justify-between gap-3 mb-2">
				<div>
					<h3 className="text-sm font-semibold">Home screen shortcut</h3>
					<p className="text-xs text-muted mt-0.5">
						A direct link to this instance. Bookmark it, or add it to your home screen — the icon opens
						straight here, skipping the instance list.
					</p>
				</div>
				<Button onClick={copy}>{copied ? "Copied" : "Copy link"}</Button>
			</div>
			<code className="block text-xs break-all bg-paper border border-line rounded px-2 py-1.5 mb-2" data-testid="instance-shortcut-url">
				{url}
			</code>
			<ul className="text-2xs text-muted-soft space-y-0.5">
				<li>
					<b>iPhone / iPad</b> — Safari, Share, <i>Add to Home Screen</i>.
				</li>
				<li>
					<b>Android</b> — Chrome menu, <i>Add to Home screen</i> (or <i>Install app</i>).
				</li>
				<li>
					<b>Desktop</b> — the install icon in the address bar, or bookmark this page.
				</li>
			</ul>
			<p className="text-2xs text-muted-soft mt-2">
				Opens with your existing sign-in. If the instance is later removed, the link says so instead of
				opening an empty page.
			</p>
		</Card>
	);
}
