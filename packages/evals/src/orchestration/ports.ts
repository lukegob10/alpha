import type { AttemptLifecycleEvent, AttemptPhase, TrialTerminalStatus } from "../lifecycle/index"

export type AttemptSnapshot = {
	id: number
	attemptNumber: number
	phase: AttemptPhase
	terminalStatus?: TrialTerminalStatus
	version: number
}

export interface AttemptLifecyclePort {
	ensureAttempt(taskId: number, attemptNumber: number): Promise<AttemptSnapshot>
	applyEvent(attemptId: number, event: AttemptLifecycleEvent): Promise<AttemptSnapshot>
	findAttempt(taskId: number, attemptId: number): Promise<AttemptSnapshot | undefined>
}

export type GradeDecision = Extract<
	TrialTerminalStatus,
	"passed" | "outcome_failed" | "safety_failed" | "budget_exhausted" | "cancelled" | "human_handoff" | "grader_error"
>

export type AttemptObservation = {
	type:
		| "attempt_started"
		| "setup_completed"
		| "agent_completed"
		| "evidence_collected"
		| "grade_completed"
		| "attempt_failed"
		| "attempt_skipped"
	attemptId: number
	attemptNumber: number
	detail?: string
}

export interface AttemptObserver {
	emit(observation: AttemptObservation): Promise<void>
}

export interface AttemptExecutionPorts {
	lifecycle: AttemptLifecyclePort
	setup(): Promise<void>
	executeAgent(): Promise<void>
	collectEvidence(attempt: AttemptSnapshot): Promise<void>
	grade(attempt: AttemptSnapshot): Promise<GradeDecision>
	validateEvidence?(attempt: AttemptSnapshot): Promise<void>
	cleanup(): Promise<void>
	observer?: AttemptObserver
}

export interface HarnessClock {
	now(): Date
	monotonicMs(): number
}

export interface HarnessSleeper {
	sleep(ms: number): Promise<void>
}

export interface HarnessRandomSource {
	next(): number
}

export type HarnessProcessSpec = {
	command: string
	args: string[]
	cwd?: string
	env?: Record<string, string>
	timeoutMs: number
	maxOutputBytes: number
}

export type HarnessProcessResult = {
	exitCode: number | null
	stdout: string
	stderr: string
	durationMs: number
	timedOut: boolean
	outputTruncated: boolean
	fullStdout?: string
	fullStderr?: string
}

export interface HarnessProcessRunner {
	run(spec: HarnessProcessSpec): Promise<HarnessProcessResult>
}

export type ArtifactRecord = {
	id: string
	mediaType: string
	bytes: Uint8Array
	digest: string
}

export interface ArtifactStore {
	put(id: string, bytes: Uint8Array, mediaType: string): Promise<ArtifactRecord>
	get(id: string): Promise<ArtifactRecord | undefined>
}
