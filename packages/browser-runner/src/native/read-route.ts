/**
 * The runner's native READ routes (#1057, slice 2): a path from the contract's route table → its read.
 * Kept out of `server.ts` so the routing is testable without an HTTP server. Null = not a read route.
 */
import { NATIVE_READ_ROUTES, type NativeReadResult, type NativeReadTool, nativeReadInputError } from "./contract.js";
import { accessibilityTree, listApps, maestroDevices, maestroHierarchy, type ReadDeps } from "./read.js";

const TOOL_BY_PATH = new Map<string, NativeReadTool>(Object.entries(NATIVE_READ_ROUTES).map(([tool, r]) => [r.path, tool as NativeReadTool]));

export async function nativeReadRoute(path: string, body: Record<string, unknown>, deps: ReadDeps = {}): Promise<{ status: 200 | 400; body: NativeReadResult<unknown> } | null> {
	const tool = TOOL_BY_PATH.get(path);
	if (!tool) return null;
	const invalid = nativeReadInputError(tool, body);
	if (invalid) return { status: 400, body: { ok: false, code: "NATIVE_INVALID_REQUEST", message: invalid } };
	switch (tool) {
		case "native_list_apps":
			return { status: 200, body: await listApps(deps) };
		case "native_accessibility_tree":
			return { status: 200, body: await accessibilityTree({ app: body.app as string | undefined, maxDepth: body.maxDepth as number | undefined }, deps) };
		case "native_maestro_devices":
			return { status: 200, body: await maestroDevices(deps) };
		case "native_maestro_hierarchy":
			return { status: 200, body: await maestroHierarchy({ deviceId: body.deviceId as string }, deps) };
	}
}
