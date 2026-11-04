import { Link, useParams } from "react-router-dom";
import Page from "../components/Page";
import { ApplicationsView } from "../tabs/ApplicationsTab";

/** A reloadable application destination under the existing shell and instance scope. */
export default function ApplicationDetail() {
	const { id, applicationId } = useParams<{ id: string; applicationId: string }>();
	if (!id || !applicationId) return <Page><p role="alert">Application link is incomplete.</p></Page>;
	return <Page className="min-w-0">
		<Link to={`/instances/${encodeURIComponent(id)}/applications`} className="inline-block text-sm text-accent underline mb-3">Back to applications</Link>
		<h1 className="text-xl font-bold mb-4">Application details</h1>
		<ApplicationsView key={`${id}:${applicationId}`} instanceId={id} applicationId={applicationId} />
	</Page>;
}
