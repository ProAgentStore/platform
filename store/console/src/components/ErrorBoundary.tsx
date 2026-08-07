/**
 * Catches a render/lifecycle exception in the subtree and shows a recoverable
 * fallback instead of white-screening the whole console. Without this, a single bad
 * render (e.g. React error #31 — "Objects are not valid as a React child", seen in
 * the durable error log) takes down the entire page. Placed around the routed <Outlet>
 * so the header + nav survive and the user can navigate away or retry.
 *
 * `resetKey` (the route path) clears the error when the user navigates, so a crash on
 * one page doesn't wedge every other page until a full reload.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportClientError } from "@proagentstore/sdk/client";
import Button from "./Button";

interface Props {
	children: ReactNode;
	/** Change this (e.g. to the route path) to auto-clear a caught error on navigation. */
	resetKey?: string;
}

interface State {
	error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
	state: State = { error: null };

	static getDerivedStateFromError(error: Error): State {
		return { error };
	}

	componentDidUpdate(prev: Props) {
		// Navigated to a different route → drop the stale error so the new page renders.
		if (this.state.error && prev.resetKey !== this.props.resetKey) {
			this.setState({ error: null });
		}
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		// The global window.onerror handler does NOT fire for exceptions React catches in
		// a boundary, so log it here or a render crash becomes invisible server-side.
		reportClientError("react", `${error.name}: ${error.message}`, {
			stack: String(error.stack || "").slice(0, 600),
			componentStack: String(info.componentStack || "").slice(0, 600),
		});
	}

	render() {
		if (this.state.error) {
			return (
				<div className="flex-1 flex items-center justify-center p-6">
					<div className="max-w-md text-center">
						<h2 className="text-lg font-semibold mb-1">Something went wrong on this page</h2>
						<p className="text-sm text-muted mb-4">
							The rest of the console still works — try again, or head back to your agents.
						</p>
						<div className="flex gap-2 justify-center">
							<Button variant="primary" size="lg" onClick={() => this.setState({ error: null })}>
								Try again
							</Button>
							<Button size="lg" onClick={() => window.location.reload()}>
								Reload
							</Button>
						</div>
					</div>
				</div>
			);
		}
		return this.props.children;
	}
}
