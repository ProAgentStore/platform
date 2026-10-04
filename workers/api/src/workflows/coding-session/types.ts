// Core types and interfaces for the CodingSessionWorkflow
// These are extracted from the main run() method for clarity and reuse

import type {
	CodingResult,
	CodingDeps,
	CodingDecision,
	CodingActionKind,
	CodingPaneSnapshot,
} from "../../lib/coding-loop.js";
import type { RunStep, CodingRunProbe } from "../../lib/runner-availability.js";
import type { RunnerConn } from "../../lib/runner-client.js";
import type { EngineWaitState } from "../../lib/coding-wait.js";
import type { PauseDeps, LoopStopReason } from "../../lib/coding-pause.js";
import type { MergePolicy } from "../../lib/coding-authority.js";
import type { InterruptionResume } from "../../lib/coding-interrupt.js";
import type { CodingGoal } from "../../lib/coding-loop.js";
import type { CodingSessionParams } from "../coding-session-params.js";

// State tracking for a run
export interface RunState {
	pilotSteps: number;
	pilotThoughts: number;
	ownerTurns: number;
	crashReason: LoopStopReason | null;
	lastActivityTouchAt: number;
	interruptions: number;
}

// Context for tracing a run
export interface TraceContext {
	userId: string;
	instanceId: string;
	sessionId: string;
	runId: string | null;
	repo: string;
}

// Retry configuration
export interface RetryConfig {
	retries: { limit: number; delay: string; backoff: string };
	timeout: string;
}

// Re-exports for convenience
export type {
	CodingResult,
	CodingDeps,
	CodingDecision,
	CodingActionKind,
	CodingPaneSnapshot,
	RunnerConn,
	EngineWaitState,
	PauseDeps,
	MergePolicy,
	InterruptionResume,
	CodingGoal,
	CodingSessionParams,
};
