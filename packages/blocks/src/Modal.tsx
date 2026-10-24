import { type ReactNode, useEffect } from "react";

/**
 * A minimal dialog shell (#187): backdrop, titled panel, Escape and a full-screen dismiss button behind the panel. It
 * never opens a native alert or confirm — confirmation is the caller's content and `onClose` is the
 * only exit. Renders nothing when closed.
 */
export function Modal({
	open,
	onClose,
	title,
	children,
}: {
	open: boolean;
	onClose: () => void;
	title: string;
	children?: ReactNode;
}) {
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [open, onClose]);
	if (!open) return null;
	return (
		<div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4">
			<button type="button" aria-label="Close" tabIndex={-1} onClick={onClose} className="absolute inset-0 cursor-default" />
			<div role="dialog" aria-modal="true" aria-label={title} className="relative bg-panel border border-line rounded-t-xl sm:rounded-xl w-full max-w-md p-4">
				<div className="font-semibold text-sm mb-2">{title}</div>
				{children}
			</div>
		</div>
	);
}
