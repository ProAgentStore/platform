import type { ApplicationQueueItem } from "../lib/types";

/** Uses the run's frozen policy, never the owner's current settings. */
export default function FullBrowserRunNotice({ toolAccess, submissionVerification, submitAttempted }: Pick<ApplicationQueueItem, "toolAccess" | "submissionVerification" | "submitAttempted">) {
	if (toolAccess !== "full") return null;
	return <div className="rounded border border-warning p-2 mb-3 text-sm" role="note">
		<p className="font-semibold">This run uses full Playwright tools.</p>
		<p>Native code may bypass masking, website and no-submit controls. An instruction to fill without submitting does not guarantee that nothing was submitted or changed.</p>
		<p>{submitAttempted ? "A submission attempt was observed." : "No supervised submission attempt was recorded; this does not prove that no submission occurred."} {submissionVerification === "unverified" ? "Submission remains unverified." : "Check the employer's own record before retrying."}</p>
	</div>;
}
