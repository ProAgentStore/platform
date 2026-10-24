import { renderMd, toolCallSummary } from "@proagentstore/sdk/ui";
import { SafeHtmlView } from "@proagentstore/sdk/ui-react";
import { Wrench } from "lucide-react";

/**
 * A tool-call message collapsed to "Used <summary>" with the full output one click away (#187) —
 * written out line for line in the console's instance chat and the Coder's Co-pilot thread. The
 * caller decides what is a tool call (`classifyMessage(m) === "tool"`) and supplies the row's key.
 */
export function ToolCallRow({ content }: { content: string }) {
	return (
		<details className="self-start max-w-[90%]">
			<summary className="flex items-center gap-1.5 text-2xs text-muted cursor-pointer select-none py-0.5 px-2">
				<Wrench size={11} className="shrink-0" />
				<span>Used {toolCallSummary(content)}</span>
			</summary>
			<SafeHtmlView className="mt-1 bg-panel/50 border border-line rounded-lg p-2 text-2xs text-muted leading-relaxed msg-md" html={renderMd(content)} />
		</details>
	);
}
