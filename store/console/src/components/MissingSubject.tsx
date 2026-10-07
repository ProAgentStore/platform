import { Link } from "react-router-dom";
import Card from "./Card";

/**
 * A link — usually a notification's — to something that has since been deleted (#784, #894): said
 * plainly, with the way back, instead of loading forever or rendering a blank page.
 */
export default function MissingSubject({ title, children, backTo, backLabel, testId }: { title: string; children: React.ReactNode; backTo: string; backLabel: string; testId: string }) {
	return (
		<div className="flex-1 overflow-auto px-2 py-2 sm:px-4 sm:py-3">
			<Card tone="panel" data-testid={testId}>
				<h3 className="text-base font-bold mb-1">{title}</h3>
				<p className="text-sm text-muted mb-3">{children}</p>
				<Link to={backTo} className="text-sm font-semibold text-accent hover:underline">
					{backLabel}
				</Link>
			</Card>
		</div>
	);
}
