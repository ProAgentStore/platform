import type { Readiness } from "../lib/releaseGate";

/**
 * Whether a production note can reach a channel (#1347). Says "Ready to publish" only for a verdict with
 * no findings; every other state lists what is in the way. The verdict is `readiness()`'s, not computed here.
 */
export default function ReleaseReadiness({ verdict }: { verdict: Readiness }) {
	return (
		<div className="mb-3" data-testid="release-readiness" data-ready={verdict.ready}>
			{verdict.ready ? (
				<p className="text-xs text-success" role="status">
					Ready to publish: a verified production note is posted once its checks pass for a pushed commit.
				</p>
			) : (
				<div role="status" className="border border-warning-line rounded-lg px-3 py-2">
					<p className="text-xs font-semibold mb-1">Not ready to publish</p>
					<ul className="list-disc pl-4 flex flex-col gap-0.5">
						{verdict.items.map((i) => (
							<li key={i.id} className="text-2xs text-muted break-words" data-readiness={i.id}>
								{i.text}
							</li>
						))}
					</ul>
				</div>
			)}
			{verdict.notes.length > 0 && (
				<ul className="list-disc pl-4 mt-1 flex flex-col gap-0.5" data-testid="release-readiness-notes">
					{verdict.notes.map((n) => (
						<li key={n} className="text-2xs text-muted break-words">
							{n}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
