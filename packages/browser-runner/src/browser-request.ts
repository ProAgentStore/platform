import type { IncomingMessage } from "node:http";
import type { LocalRunner } from "./runner.js";
import { instanceOf, readJson } from "./request-instance.js";

/** Only requests that can launch/use a browser apply a mode; health/log/status reads never recycle it. */
export async function withBrowserRequest<T>(runner: LocalRunner, req: IncomingMessage, fn: () => Promise<T>): Promise<T> {
	const path = (req.url || "").split("?")[0].replace(/\/$/, "");
	let newRun = req.method === "POST" && ["/local-browser/run", "/local-apply/run", "/local-apply/preflight", "/local-apply/sign-in", "/local-apply/reconciliation/run"].includes(path);
	if (newRun && (path === "/local-browser/run" || path === "/local-apply/run")) {
		const runtime = path === "/local-browser/run" ? runner.localBrowser : runner.localApply;
		if (runtime.hasRequest(await readJson(req))) newRun = false;
	}
	if (req.method === "POST" && path === "/tasks") {
		const body = await readJson<{ type?: unknown }>(req);
		newRun = ["browser.open", "browser.task", "job.apply_agent", "local_browser.research", "local_browser.apply"].includes(String(body.type));
	}
	const approvingId = req.method === "POST" ? path.match(/^\/tasks\/([^/]+)\/approve$/)?.[1] : undefined;
	const approvingBrowser = approvingId && runner.store.getTask(approvingId)?.type === "browser.open" ? approvingId : undefined;
	const configure = !!approvingBrowser || newRun || /^\/browser\/(act|snapshot|handoff)$/.test(path) || /^\/local-(browser|apply)\/resume$/.test(path);
	const bodyTask = req.method === "POST" && path.startsWith("/browser/") ? (await readJson<{ taskId?: string }>(req)).taskId : undefined;
	const trackTask = approvingBrowser ?? (bodyTask && runner.store.getTask(bodyTask) ? bodyTask : undefined);
	return runner.browsers.run(instanceOf(req), req.headers["x-pags-browser-mode"], newRun, () => { if (trackTask) runner.browsers.current.taskIds.add(trackTask); return fn(); }, configure, { engine: req.headers["x-pags-browser-engine"], profilePolicy: req.headers["x-pags-browser-profile-policy"] });
}
