import { renderMd } from "@proagentstore/sdk/ui";
import { SafeHtmlView } from "@proagentstore/sdk/ui-react";
import { splitInlineNumberedList } from "../lib/agentText";

/**
 * Text an agent or a model wrote, rendered as markdown (#1129): bold, lists, code, links. Through the
 * SDK's `renderMd`, which escapes the WHOLE input first and admits only http(s) links, so agent output
 * cannot inject markup. An inline numbered list is put on its own lines first, so it reads as a list.
 */
export default function MarkdownText({ text, className = "", as = "div" }: { text: string; className?: string; as?: "div" | "span" }) {
	return <SafeHtmlView as={as} className={`msg-md min-w-0 break-words ${className}`} html={renderMd(splitInlineNumberedList(text))} />;
}
