import type { CSSProperties, Ref, UIEventHandler } from "react";
import { renderTerminal, terminalTail } from "@proagentstore/sdk/ui";
import { SafeHtmlView } from "@proagentstore/sdk/ui-react";

/**
 * Raw terminal / tmux pane output, colorized, in a `<pre>` (#187).
 *
 * The block every terminal view composes: the SDK's escaping colorizer (`renderTerminal`)
 * mounted through the product's one HTML sink (`SafeHtmlView`). Layout is the caller's — the
 * Coder's full-height scrolling pane and the Terminals page's three-line preview share the
 * rendering, not the box — so `className`/`style` are passed straight through.
 */
export function TerminalPane({
	text,
	tailChars,
	className,
	style,
	paneRef,
	onScroll,
}: {
	/** The pane's raw text, as the runner captured it. */
	text: string;
	/** Render only the last N characters of the pane — a preview of a long one (`terminalTail`). */
	tailChars?: number;
	className?: string;
	style?: CSSProperties;
	paneRef?: Ref<HTMLPreElement>;
	onScroll?: UIEventHandler<HTMLPreElement>;
}) {
	return (
		<SafeHtmlView<HTMLPreElement>
			as="pre"
			ref={paneRef}
			className={className}
			style={style}
			onScroll={onScroll}
			html={renderTerminal(tailChars === undefined ? text : terminalTail(text, tailChars))}
		/>
	);
}
