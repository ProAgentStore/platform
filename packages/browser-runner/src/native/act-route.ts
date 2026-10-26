/**
 * The runner's native ACT routes (#1057, slice 3): a path from the contract's route table → its action, plus halt and resume.
 * Kept out of `server.ts` so the routing is testable without an HTTP server. Null = not an act route.
 */
import { NATIVE_ACT_ROUTES, NATIVE_HALT_PATH, NATIVE_RESUME_PATH, type NativeActTool, nativeActInputError, type NativeReadResult } from "./contract.js";
import { type ActDeps, click, halt, launchApp, pressKey, resume, screenshot, scroll, typeText } from "./act.js";

const TOOL_BY_PATH = new Map<string, NativeActTool>(Object.entries(NATIVE_ACT_ROUTES).map(([tool, r]) => [r.path, tool as NativeActTool]));

export async function nativeActRoute(path: string, body: Record<string, unknown>, deps: ActDeps = {}): Promise<{ status: 200 | 400; body: NativeReadResult<unknown> } | null> {
	if (path === NATIVE_HALT_PATH) return { status: 200, body: halt(deps) };
	if (path === NATIVE_RESUME_PATH) return { status: 200, body: resume(deps) };
	const tool = TOOL_BY_PATH.get(path);
	if (!tool) return null;
	const invalid = nativeActInputError(tool, body);
	if (invalid) return { status: 400, body: { ok: false, code: "NATIVE_INVALID_REQUEST", message: invalid } };
	switch (tool) {
		case "native_launch_app":
			return { status: 200, body: await launchApp({ app: body.app as string }, deps) };
		case "native_click":
			return { status: 200, body: await click({ x: body.x as number, y: body.y as number, button: body.button as "left" | "right" | undefined, double: body.double as boolean | undefined }, deps) };
		case "native_type":
			return { status: 200, body: await typeText({ text: body.text as string }, deps) };
		case "native_key":
			return { status: 200, body: await pressKey({ key: body.key as string }, deps) };
		case "native_scroll":
			return { status: 200, body: await scroll({ dx: body.dx as number | undefined, dy: body.dy as number | undefined }, deps) };
		case "native_screenshot":
			return { status: 200, body: await screenshot(deps) };
	}
}
