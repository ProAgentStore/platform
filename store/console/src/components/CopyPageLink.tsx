import { useEffect, useRef, useState } from "react";
import { Link2 } from "lucide-react";
import Button from "./Button";

/**
 * Copy this page's URL (#1130). An installed PWA has no address bar, so without this there is no
 * way to grab the link to the page you are looking at — to report a bug on it, or send it to
 * someone. It lives in the shared header (`Layout.tsx`), so every console page has it without
 * opting in. If the clipboard refuses (no permission, no gesture), the toast shows the URL itself
 * so it can still be selected by hand rather than the tap silently doing nothing.
 */
export default function CopyPageLink({ size }: { size: number }) {
	const [toast, setToast] = useState<{ ok: boolean; url: string } | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);

	const copy = async () => {
		const url = window.location.href;
		const ok = await navigator.clipboard?.writeText(url).then(() => true, () => false) ?? false;
		setToast({ ok, url });
		clearTimeout(timer.current);
		timer.current = setTimeout(() => setToast(null), ok ? 2000 : 8000);
	};

	return (
		<>
			<Button variant="ghost" size="icon" className="shrink-0" onClick={() => void copy()} title="Copy link to this page" aria-label="Copy link to this page">
				<Link2 size={size} />
			</Button>
			{toast && (
				<output aria-live="polite" className="fixed bottom-4 left-1/2 -translate-x-1/2 z-80 max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink shadow-lg break-all">
					{toast.ok ? "Link copied" : <>Couldn't copy — select the link: <span className="select-all">{toast.url}</span></>}
				</output>
			)}
		</>
	);
}
