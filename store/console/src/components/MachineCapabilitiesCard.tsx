import { useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Card from "./Card";
import { browserLine, type MachineCapabilitiesResponse, resourceLine, supportLine } from "../lib/machineCapabilities";

/**
 * What this machine can do (#1312): its OS, which browser engines actually launch (a real probe, with the reason when one
 * does not), iOS / Android / Docker, the Node and Playwright versions, a bounded tool inventory and what changed lately.
 * Read-only: the runner reports it, the platform checks job requirements against it before a run starts.
 */
export default function MachineCapabilitiesCard({ machineId }: { machineId: string }) {
	const [data, setData] = useState<MachineCapabilitiesResponse | null>(null);
	const [error, setError] = useState("");
	useEffect(() => {
		api<MachineCapabilitiesResponse>(`/v1/terminals/machines/${encodeURIComponent(machineId)}/capabilities?history=1`)
			.then(setData)
			.catch((e) => setError(e instanceof Error ? e.message : "Could not load this machine's capabilities."));
	}, [machineId]);

	const s = data?.summary;
	return (
		<Card className="p-4" data-testid="machine-capabilities">
			<div className="flex items-baseline justify-between gap-3">
				<h2 className="font-semibold text-sm">Capabilities</h2>
				{s && <span className="text-xs text-muted">reported {s.reportedAt.slice(0, 16).replace("T", " ")}</span>}
			</div>
			{error && <p className="text-xs text-danger mt-2" role="alert">{error}</p>}
			{data && !data.reported && <p className="text-sm text-muted mt-1" data-testid="machine-capabilities-unreported">{data.message}</p>}
			{s && (
				<div className="mt-2 grid gap-1 text-sm">
					<div data-testid="machine-capabilities-os">{s.os} · {s.arch} · {resourceLine(s)}</div>
					<div className="text-muted">Node {s.nodeVersion ?? "—"} · Playwright {s.playwrightVersion ?? "not installed"}</div>
					<ul className="mt-1" data-testid="machine-capabilities-browsers">
						{(["chromium", "firefox", "webkit"] as const).map((b) => {
							const l = browserLine(b, s.browsers[b]);
							return <li key={b} className={l.tone === "ok" ? "text-success" : l.tone === "bad" ? "text-danger" : "text-muted"}>{l.text}</li>;
						})}
					</ul>
					<div className="text-muted mt-1">{[supportLine("iOS simulators", s.ios), supportLine("Android adb", s.android), supportLine("Docker", s.docker)].join(" · ")}</div>
					{data?.capabilities?.inventory.length ? (
						<div className="text-xs text-muted mt-1" data-testid="machine-capabilities-inventory">{data.capabilities.inventory.map((i) => `${i.name} ${i.version}`).join(" · ")}</div>
					) : null}
					{data?.history?.length ? (
						<details className="mt-1">
							<summary className="text-xs text-muted cursor-pointer">Recent changes ({data.history.length})</summary>
							<ul className="text-xs text-muted mt-1">
								{data.history.map((h) => (
									<li key={h.hash + h.changedAt}>{h.changedAt.slice(0, 16)} — {h.changes.join("; ") || "changed"}</li>
								))}
							</ul>
						</details>
					) : null}
				</div>
			)}
		</Card>
	);
}
