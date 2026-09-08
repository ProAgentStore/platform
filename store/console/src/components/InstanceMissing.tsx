import { Link } from "react-router-dom";
import Card from "./Card";

/**
 * The page behind a link to an instance that no longer exists (#784).
 *
 * Before this, `/instances/<gone>` rendered the loading state forever: the record fetch
 * succeeded, found nothing, and nothing said so. That was tolerable while the only way to
 * reach an instance page was the list (which cannot link to a deleted one) and a notification
 * (whose rows outlive the instance, but rarely). A home-screen shortcut is a link that
 * outlives everything, so the not-found case became a page someone will actually see.
 */
export default function InstanceMissing({ id }: { id?: string }) {
	return (
		<div className="flex-1 overflow-auto px-2 py-2 sm:px-4 sm:py-3">
			<Card tone="panel" data-testid="instance-missing">
				<h3 className="text-base font-bold mb-1">This instance is no longer here</h3>
				<p className="text-sm text-muted mb-3">
					{id ? <code className="text-xs">{id}</code> : "The link you followed"} does not match any instance
					on your account — it was cancelled, or it belongs to another sign-in. If you saved a shortcut to it,
					it is safe to remove.
				</p>
				<Link to="/instances" className="text-sm font-semibold text-accent hover:underline">
					Back to your instances
				</Link>
			</Card>
		</div>
	);
}
