import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import Button from "./Button";
import { connectionStateBadge, type McpConnectionDisplay, mcpConnectionActionLabel, openableEndpoint } from "../lib/mcpConnections";
import { mcpConnectionPath } from "../lib/permissionRequestFocus";

const TONE = { green: "text-success", amber: "text-warning", red: "text-danger" } as const;

/**
 * The top of one MCP server row (#1285): the FULL endpoint in a field you can see, select and copy; what the agent is
 * ALLOWED to do (the grant); and what is actually TRUE about the connection (its state, and the account a call would use).
 *
 * Why the two are separate lines. A grant is a permission and the connection is an operational fact. The row used to show only the
 * grant ("read & write") beside a truncated URL, so a server with no token and no connected account looked like a working one while
 * every call refused. The permission is now labelled "Permission", the state "Connection", and the state is never conveyed by colour
 * alone — each has its own words and a leading symbol.
 *
 * The endpoint is the normalized `host + path` the whole panel keys on: it carries no query, no credential and no token, so
 * copying it, opening it and putting it in a link leaks nothing. It is opened only when it is exactly an https URL of that form.
 */
export default function McpConnectionHeader({
	instanceId,
	endpoint,
	wildcard,
	grantCount,
	state,
	accountName,
	focused,
	primary,
	idPrefix,
}: {
	instanceId: string;
	endpoint: string;
	wildcard: boolean;
	grantCount: number;
	state: McpConnectionDisplay;
	/** The account a call would use right now (connected state), by the name the owner gave it. */
	accountName: string | null;
	/** This row is the one a deep link named. */
	focused: boolean;
	/** The one thing to do about this state, or null (e.g. connected: nothing). */
	primary: { label: string; onClick: () => void; disabled?: boolean } | null;
	idPrefix: string;
}) {
	const badge = connectionStateBadge(state);
	const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
	const field = useRef<HTMLTextAreaElement>(null);
	const openHref = openableEndpoint(endpoint);

	useEffect(() => {
		if (focused) field.current?.closest("li")?.scrollIntoView?.({ block: "center" });
	}, [focused]);

	const doCopy = async () => {
		try {
			await navigator.clipboard.writeText(endpoint);
			setCopy("copied");
		} catch {
			// No clipboard permission (or an insecure context): select the text so the owner can copy it by hand.
			field.current?.select();
			setCopy("failed");
		}
	};

	return (
		<div className={`mb-1 ${focused ? "rounded border border-accent p-1.5" : ""}`} data-testid="mcp-connection-header" data-state={state}>
			<p id={`${idPrefix}-label`} className="text-2xs text-muted-soft mb-0.5">
				Server URL
			</p>
			{/* A read-only text field that sizes to its content and wraps — never truncated, so the whole URL is on screen on a phone. It is a native field, so it is focusable, labelled and selectable by every assistive technology; focus selects all of it. */}
			<textarea
				id={`${idPrefix}-url`}
				ref={field}
				readOnly
				rows={1}
				value={endpoint}
				spellCheck={false}
				aria-labelledby={`${idPrefix}-label`}
				data-testid="mcp-endpoint"
				className="block w-full resize-none field-sizing-content font-mono text-sm break-all select-all bg-paper border border-line rounded px-2 py-1 text-muted"
				onFocus={(e) => e.currentTarget.select()}
			/>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-xs">
				<button type="button" className="text-accent hover:underline" aria-label="Copy endpoint URL" aria-describedby={`${idPrefix}-url`} onClick={() => void doCopy()}>
					Copy
				</button>
				<span role="status" aria-live="polite" className="text-2xs text-muted-soft">
					{copy === "copied" ? "Copied" : copy === "failed" ? "Copy blocked — the URL is selected, press Ctrl/⌘+C" : ""}
				</span>
				{openHref && (
					<a href={openHref} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
						Open server<span className="sr-only"> (opens in a new tab)</span>
					</a>
				)}
				<Link to={mcpConnectionPath(instanceId, endpoint)} className="text-muted-soft hover:underline">
					Link to this server
				</Link>
				{primary && (
					<Button size="sm" variant="secondary" disabled={primary.disabled} onClick={primary.onClick} aria-label={mcpConnectionActionLabel(primary.label, endpoint)}>
						{primary.label}
					</Button>
				)}
			</div>
			<dl className="grid grid-cols-[max-content_1fr] gap-x-2 gap-y-0.5 mt-1.5 text-xs">
				<dt className="text-muted-soft">Permission</dt>
				<dd className="text-muted">{wildcard ? "read & write, all tools" : `${grantCount} individual grant${grantCount === 1 ? "" : "s"}`}</dd>
				<dt className="text-muted-soft">Connection</dt>
				<dd>
					<span className={`font-semibold ${TONE[badge.tone]}`} data-testid="mcp-connection-state">
						<span aria-hidden="true">{badge.symbol} </span>
						{badge.label}
					</span>
					{state === "connected" && accountName && <span className="text-muted"> · using {accountName}</span>}
				</dd>
			</dl>
			<p className="text-2xs text-muted-soft leading-snug mt-0.5">{badge.consequence}</p>
		</div>
	);
}
