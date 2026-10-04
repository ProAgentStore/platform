import { useState, useCallback } from "react";
import Button from "../../components/Button";
import Card from "../../components/Card";
import RepoConnectPanel from "../../components/RepoConnectPanel";

interface Props {
	instanceId: string;
	instName: string;
	instNameMsg: string;
	isRepo?: boolean;
	onInstNameChange: (value: string) => void;
	onSaveInstName: () => Promise<void>;
}

export default function InstanceInfo({
	instanceId,
	instName,
	instNameMsg,
	isRepo,
	onInstNameChange,
	onSaveInstName,
}: Props) {
	const [instanceIdCopied, setInstanceIdCopied] = useState(false);

	const copyInstanceId = useCallback(() => {
		void navigator.clipboard?.writeText(instanceId).then(() => {
			setInstanceIdCopied(true);
			setTimeout(() => setInstanceIdCopied(false), 2000);
		});
	}, [instanceId]);

	return (
		<>
			{/* Instance ID — unique identifier for deep links (#909) */}
			<Card className="mb-3 sm:mb-4">
				<h3 className="text-base font-bold mb-1">Instance ID</h3>
				<p className="text-sm text-muted mb-3">
					Your instance's unique identifier — use it to construct deep links like{" "}
					<code className="text-xs bg-paper px-1 py-0.5 rounded">
						/instances/{"{"}
						{"{id}"}
						{"}"}​/secure-inputs/{"{request_id}"}
					</code>
					.
				</p>
				<div className="flex gap-2 items-center flex-wrap">
					<code
						className="bg-paper border border-line rounded px-2 py-1.5 text-xs font-mono text-muted"
						data-testid="instance-id-value"
					>
						{instanceId}
					</code>
					<Button size="sm" onClick={copyInstanceId} data-testid="instance-id-copy-button">
						{instanceIdCopied ? "Copied!" : "Copy ID"}
					</Button>
				</div>
			</Card>

			{/* Instance name — distinguishes multiple instances of the same agent */}
			<Card className="mb-3 sm:mb-4">
				<h3 className="text-base font-bold mb-1" id="inst-name-label">
					Instance name
				</h3>
				<p className="text-sm text-muted mb-3">
					Shown on your dashboard and in the header — rename it to tell multiple instances of the same agent apart (e.g. "Legal PDFs" vs "Product Manuals").
				</p>
				<div className="flex gap-2 items-center flex-wrap">
					<input
						aria-labelledby="inst-name-label"
						value={instName}
						onChange={(e) => onInstNameChange(e.target.value)}
						maxLength={60}
						className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5 w-full sm:w-72"
					/>
					<Button variant="primary" onClick={onSaveInstName}>
						Save
					</Button>
					{instNameMsg && <span className="text-xs text-muted">{instNameMsg}</span>}
				</div>
			</Card>

			{/* Repository connection — setup only (#727) */}
			{isRepo && <RepoConnectPanel instanceId={instanceId} />}
		</>
	);
}
