import BrowserModeCapabilityCard from "./BrowserModeCapabilityCard";
import LocalBrowserCapabilityCard from "./LocalBrowserCapabilityCard";
import { takesBrowserScreenshots } from "../lib/browserScreenshots";

export default function BrowserCapabilityCards({ agentId, runtime, surfaces }: { agentId: string; runtime: string; surfaces: string[] }) {
	return <>
		<LocalBrowserCapabilityCard agentId={agentId} runtime={runtime} />
		{takesBrowserScreenshots({ runtime, surfaces }) && <BrowserModeCapabilityCard agentId={agentId} />}
	</>;
}
