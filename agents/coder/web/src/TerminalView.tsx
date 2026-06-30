import { type RefObject } from "react";
import { Send } from "lucide-react";
import { renderTerminal } from "./render-terminal";

/** Raw tmux pane view: a send-to-Engine input + the colorized, auto-scrolling pane. */
export default function TerminalView({
	termInput, setTermInput, sendTerminalMessage,
	terminalText, termRef, termAutoScroll, setTermAutoScroll,
}: {
	termInput: string;
	setTermInput: (v: string) => void;
	sendTerminalMessage: () => void;
	terminalText: string;
	termRef: RefObject<HTMLPreElement | null>;
	termAutoScroll: boolean;
	setTermAutoScroll: (v: boolean) => void;
}) {
	return (
		<div className="flex flex-col flex-1 min-h-0 relative">
			<div className="flex gap-1 px-2 py-2 shrink-0 items-center border-b border-line">
				<input
					value={termInput}
					onChange={(e) => setTermInput(e.target.value)}
					onKeyDown={(e) => { if (e.key === "Enter") sendTerminalMessage(); }}
					placeholder="Send a message to the Engine..."
					className="flex-1 min-w-0 bg-panel border border-line rounded-xl px-3 py-2.5 text-sm"
				/>
				<button type="button" onClick={sendTerminalMessage} aria-label="Send" className="px-3 py-2.5 bg-accent text-white rounded-xl font-bold text-sm">
					<Send size={14} />
				</button>
			</div>
			<pre
				ref={termRef}
				className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden bg-[#0b0b0f] text-xs leading-snug p-3 m-0 select-text"
				style={{ wordBreak: "break-word", whiteSpace: "pre-wrap" }}
				onScroll={() => {
					if (!termRef.current) return;
					const el = termRef.current;
					const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
					setTermAutoScroll(atBottom);
				}}
				dangerouslySetInnerHTML={{ __html: renderTerminal(terminalText) }}
			/>
			{!termAutoScroll && (
				<button
					type="button"
					onClick={() => {
						if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight;
						setTermAutoScroll(true);
					}}
					className="absolute bottom-4 right-4 bg-accent text-white text-xs px-3 py-1.5 rounded-full shadow-lg font-bold animate-bounce"
				>
					New output below
				</button>
			)}
		</div>
	);
}
