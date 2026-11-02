import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import { browserSettingLabel, type BrowserEngine, type BrowserMode, type BrowserProfilePolicy } from "../lib/browserSettings";
import Card from "./Card";
import Button from "./Button";

export interface BrowserLaunchReceipt {
	engine: BrowserEngine;
	browserType: "chromium" | "firefox" | "webkit";
	channel: string | null;
	version: string;
	executable: string | null;
	mode: BrowserMode;
	profilePolicy: BrowserProfilePolicy;
	profileId: string;
	transport: "playwright";
	launchedAt: string;
	active: boolean;
}

export interface BrowserSessionView {
	status: "connected" | "offline" | "unsupported" | "unavailable";
	launch: BrowserLaunchReceipt | null;
	launches: BrowserLaunchReceipt[];
	detail?: string;
}

export function BrowserLaunchDetails({ launch }: { launch: BrowserLaunchReceipt | null }) {
	if (!launch) return <p className="text-sm text-muted">No browser launch has been reported. Saved settings do not confirm which browser has actually opened.</p>;
	const rows = [
		["State", launch.active ? "Active" : "Closed"],
		["Browser", `${browserSettingLabel("engine", launch.engine)} (${launch.version})`],
		["Mode", browserSettingLabel("mode", launch.mode)],
		["Profile", browserSettingLabel("profile", launch.profilePolicy)],
		["Profile ID", launch.profileId],
		["Launched", launch.launchedAt],
		["Browser type", launch.browserType],
		["Channel", launch.channel ?? "Bundled browser"],
		["Executable", launch.executable ?? "Not reported for installed browser channels"],
		["Connection", launch.transport],
	];
	return <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
		{rows.map(([label, value]) => <div key={label} className="contents"><dt className="font-semibold">{label}</dt><dd className="break-words min-w-0">{value}</dd></div>)}
	</dl>;
}

export default function BrowserSessionReceipt({ instanceId }: { instanceId: string }) {
	const [data, setData] = useState<BrowserSessionView | null>(null);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(true);
	const load = useCallback(async () => {
		setLoading(true);
		setError("");
		try {
			setData(await api<BrowserSessionView>(`/v1/instances/${instanceId}/browser-settings/session`));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, [instanceId]);
	useEffect(() => { void load(); }, [load]);
	return <Card className="mb-3 sm:mb-4" data-testid="browser-launch-receipt">
		<div className="flex flex-wrap gap-2 items-center justify-between mb-2">
			<h3 className="text-base font-bold">Last reported browser launch</h3>
			<Button onClick={() => void load()} disabled={loading}>Refresh</Button>
		</div>
		<p className="text-xs text-muted mb-2">Reported by the runner after a successful launch. It can differ from newly saved settings until the next launch.</p>
		{loading ? <p className="text-sm text-muted">Checking runner…</p> : error ? <p role="status" className="text-sm text-muted">Could not read the actual browser launch: {error}</p> : data?.status !== "connected" ? <p role="status" className="text-sm text-muted">Browser launch evidence is {data?.status ?? "unavailable"}. {data?.detail}</p> : <BrowserLaunchDetails launch={data.launch} />}
	</Card>;
}
