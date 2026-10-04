// Coding Session Workflow Orchestrator
// This module coordinates the refactored components of the CodingSessionWorkflow
//
// Module structure:
// - types.ts: Core types, interfaces, and constants shared across modules
// - session-init.ts: Session initialization, policy resolution, and runner connection setup
// - cleanup.ts: Cleanup, finalization, and state termination logic
// - index.ts (this file): Main orchestrator that imports and re-exports the workflow

import { CodingSessionWorkflow } from "../coding-session.js";

// Re-export the workflow class for backward compatibility
// The actual implementation remains in coding-session.ts to preserve
// exact Cloudflare Workflow semantics and execution behavior
export { CodingSessionWorkflow };
export type { CodingSessionParams } from "../coding-session-params.js";

// Helper modules are available for incremental refactoring
// These can be imported into the main run() method as the implementation evolves
export { initializeSession } from "./session-init.js";
export { cleanupAfterRun } from "./cleanup.js";
export type { TraceContext, RunState } from "./types.js";
