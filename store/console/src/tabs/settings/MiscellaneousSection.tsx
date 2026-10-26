import { useCallback } from "react";
import Button from "../../components/Button";
import Card from "../../components/Card";
import ConnectionGuide from "../../components/ConnectionGuide";
import OperatorManualCard from "../../components/OperatorManualCard";
import HomeScreenShortcut from "../../components/HomeScreenShortcut";
import PauseCard from "../../components/PauseCard";
import type { DisabledRecord } from "../../lib/instancePause";
import { unsubscribeScope, type RosterInstance } from "../../lib/unsubscribeScope";

interface Props {
	instanceId: string;
	instanceName?: string;
	isApply: boolean;
	isCoding?: boolean;
	isRepo?: boolean;
	roster: RosterInstance[] | null;
	maintMsg: string;
	resyncMsg: string;
	instStatus: string | null;
	instDisabled?: DisabledRecord | null;
	onClearFinished: () => Promise<void>;
	onResyncIdentity: () => Promise<void>;
	onUnsubscribe: () => void;
}

export default function MiscellaneousSection({
	instanceId,
	instanceName,
	isApply,
	isCoding,
	isRepo,
	roster,
	maintMsg,
	resyncMsg,
	instStatus,
	instDisabled,
	onClearFinished,
	onResyncIdentity,
	onUnsubscribe,
}: Props) {
	const scope = unsubscribeScope(roster, instanceId);

	const handleUnsubscribe = useCallback(() => {
		if (!confirm(scope.confirm)) return;
		onUnsubscribe();
	}, [scope, onUnsubscribe]);

	return (
		<>
			{/* Board maintenance */}
			<Card className="mb-3 sm:mb-4">
				<h3 className="text-base font-bold mb-1">Board maintenance</h3>
				<p className="text-sm text-muted mb-3">Tidy up the board. These only clear your view of finished items.</p>
				<div className="flex gap-2 flex-wrap">
					<Button onClick={onClearFinished}>Clear finished tasks</Button>
				</div>
				{maintMsg && <div className="text-sm text-muted mt-2">{maintMsg}</div>}
			</Card>

			{/* Where things live */}
			<Card className="mb-3 sm:mb-4">
				<h3 className="text-base font-bold mb-1">Where things live</h3>
				<ul className="text-sm text-muted leading-relaxed pl-4 list-disc">
					{isApply && (
						<>
							<li>
								<b>Resume</b> & documents → Knowledge → Documents
							</li>
							<li>
								<b>Job application details</b> & preferences → Profile
							</li>
						</>
					)}
					{isCoding && (
						<li>
							<b>Repository</b> → configure it in the Coding tab
						</li>
					)}
					{isRepo && (
						<li>
							<b>Repository</b> → connect it here; manage it in the Repo tab
						</li>
					)}
					<li>
						<b>Rules / special instructions</b> → Knowledge → Rules & Tips
					</li>
					<li>
						<b>Logins & secrets</b> → Knowledge → Credentials
					</li>
				</ul>
			</Card>

			{/* Operator manual — the template's, inherited, above this instance's own (#1237) */}
			<OperatorManualCard instanceId={instanceId} />

			{/* Connection guide */}
			<div className="mb-3 sm:mb-4">
				<ConnectionGuide instanceId={instanceId} active />
			</div>

			{/* Home screen shortcut */}
			<div className="mb-3 sm:mb-4">
				<HomeScreenShortcut instanceId={instanceId} instanceName={instanceName} />
			</div>

			{/* Personality resync (#496) */}
			<Card className="mb-3 sm:mb-4">
				<h3 className="text-base font-bold mb-1">Maintenance</h3>
				<p className="text-sm text-muted mb-2">
					Bring this instance's personality up to the agent's current template, without touching its guardrails, goal, or welcome message.
				</p>
				<Button onClick={onResyncIdentity}>Resync personality</Button>
				{resyncMsg && <p className="text-xs text-muted mt-2">{resyncMsg}</p>}
			</Card>

			{/* Disable / enable (#825, #1383) */}
			<PauseCard instanceId={instanceId} initialStatus={instStatus} initialDisabled={instDisabled} />

			{/* Danger zone */}
			<Card>
				<h3 className="text-base font-bold mb-1 text-danger">Danger zone</h3>
				<p className="text-sm text-muted mb-3" id="inst-unsubscribe-scope">
					{scope.statement}
				</p>
				<Button variant="danger" onClick={handleUnsubscribe}>
					{scope.button}
				</Button>
			</Card>
		</>
	);
}
