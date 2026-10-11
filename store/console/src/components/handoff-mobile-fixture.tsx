// Development-only Playwright fixture. This is not a Console route or production entry point.
import { createRoot } from "react-dom/client";
import { useState } from "react";
import ApplicationHandoffLive from "./ApplicationHandoffLive";

const reconciliation = new URLSearchParams(location.search).get("reconciliation") === "1";

function Fixture() {
	const [closed, setClosed] = useState(false);
	if (closed) return <p data-testid="handoff-fixture-closed">closed</p>;
	return <ApplicationHandoffLive
		instanceId="instance-1"
		runId="run-1"
		handoffId="handoff-1"
		reconciliation={reconciliation}
		onClose={() => setClosed(true)}
		onChanged={() => undefined}
	/>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
