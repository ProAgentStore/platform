import { useState } from "react";
import { Check, Copy } from "lucide-react";

/**
 * Per-message copy button — top-right of a bubble, subtle, 16px. Shows a green check for 1.5s
 * after copying (#187: one definition for what was a copy in the console and another in the Coder).
 *
 * `reveal` is the one way the two copies differed, kept as an explicit choice rather than merged:
 *   - `"hover"` — hidden until the bubble is hovered, at every width (the console's chat);
 *   - `"hover-from-sm"` — always visible on a phone, which has no hover, and hover-revealed from
 *     `sm` up (the Coder's Co-pilot thread).
 *
 * 24×24 clears WCAG 2.5.8; `tap-target` adds 44px of vertical reach via an ::after — the axis a
 * thumb misses on a scrolling thread (#389) — without changing the box the #445 timestamp-overlap
 * guard measures. `data-msg-action` is how that guard finds every action control.
 */
export function CopyButton({ text, reveal }: { text: string; reveal: "hover" | "hover-from-sm" }) {
	const [copied, setCopied] = useState(false);
	const visibility = reveal === "hover" ? "opacity-0 group-hover:opacity-100" : "opacity-100 sm:opacity-0 sm:group-hover:opacity-100";
	return (
		<button
			type="button"
			data-msg-action="copy"
			onClick={(e) => {
				e.stopPropagation();
				navigator.clipboard
					.writeText(text)
					.then(() => {
						setCopied(true);
						setTimeout(() => setCopied(false), 1500);
					})
					.catch(() => {});
			}}
			onDoubleClick={(e) => e.stopPropagation()}
			title={copied ? "Copied" : "Copy"}
			aria-label="Copy message"
			className={`tap-target absolute top-1 right-1.5 ${visibility} p-1 rounded bg-black/40 text-muted hover:text-accent transition-opacity`}
		>
			{copied ? <Check size={16} className="text-success" /> : <Copy size={16} />}
		</button>
	);
}
