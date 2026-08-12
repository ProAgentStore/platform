import FeedbackList from "../components/FeedbackList";

/**
 * One agent's feedback (#514) — a TAB, not a sub-tab of Knowledge or Activity.
 *
 * #509 landed the day before this: Knowledge was offering Documents, Files and Index to agents
 * that declare no tool to read them, and the lesson recorded there is that a surface hidden one
 * level inside a composite is a surface nobody finds. Feedback is universal — every agent can be
 * complained about — so it is registered with `show: () => true` beside Behaviour and Stats,
 * which is the same treatment for the same stated reason.
 */
export default function FeedbackTab({ instanceId }: { instanceId: string }) {
	return <FeedbackList instanceId={instanceId} />;
}
