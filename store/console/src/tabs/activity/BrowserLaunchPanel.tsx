import { BrowserLaunchDetails, useBrowserSession } from "../../components/BrowserSessionReceipt";
import Button from "../../components/Button";
import Card from "../../components/Card";
import LoadFailed from "../../components/LoadFailed";
import { type PanelProps, useReport } from "./useReport";

/**
 * Activity → History → the browser launch the runner last reported (#1590; it was a card under Settings →
 * Browser settings). Nothing to show unless a runner is connected and has reported one: the old card
 * always rendered, with "No browser launch has been reported…", which History must not.
 */
export default function BrowserLaunchPanel({ instanceId, onReport }: PanelProps) {
	const { data, error, loading, load } = useBrowserSession(instanceId);
	const launch = data?.status === "connected" ? data.launch : null;
	useReport("browser-launch", onReport, data ? "ready" : error ? "failed" : "loading", launch ? 1 : 0, false);

	if (!data && error) return <LoadFailed what="the last browser launch" detail={error} onRetry={() => void load()} testId="history-failed-browser-launch" compact />;
	if (!launch) return null;
	return (
		<Card className="mb-3 sm:mb-4" data-testid="browser-launch-receipt">
			<div className="flex flex-wrap gap-2 items-center justify-between mb-2">
				<h3 className="text-base font-bold">Last reported browser launch</h3>
				<Button onClick={() => void load()} disabled={loading}>Refresh</Button>
			</div>
			<p className="text-xs text-muted mb-2">Reported by the runner after a successful launch. It can differ from newly saved settings until the next launch.</p>
			<BrowserLaunchDetails launch={launch} />
		</Card>
	);
}
