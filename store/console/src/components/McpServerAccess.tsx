/** One grant for normal read/write operations, including tools added by the server later. */
export default function McpServerAccess({ endpoint, enabled, busy, onChange }: { endpoint: string; enabled: boolean; busy: boolean; onChange: (enabled: boolean) => void }) {
	return (
		<div className="my-1.5">
			<label className="flex items-center gap-2 text-xs cursor-pointer">
				<input type="checkbox" checked={enabled} disabled={busy} onChange={(event) => onChange(event.target.checked)} aria-label={`Read and write access to ${endpoint}`} />
				<span className="font-semibold">Read &amp; write access to this server</span>
			</label>
			<p className="text-2xs text-muted-soft ml-6 mt-0.5">Includes current and future tools. Destructive actions need an individual grant in Advanced permissions. Account selection and the MCP write-access setting still apply.</p>
		</div>
	);
}
