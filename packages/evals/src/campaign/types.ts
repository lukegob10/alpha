export type CampaignStatus =
	| "created"
	| "running"
	| "paused"
	| "completed"
	| "budget_exhausted"
	| "failed"
	| "cancelled"

export type AttemptTerminalStatus =
	| "passed"
	| "validation_failed"
	| "budget_exhausted"
	| "infrastructure_error"
	| "cancelled"

export interface CampaignCommand {
	id: string
	command: string
	args: string[]
	cwd: string
}

export interface CampaignBudgets {
	maxCampaignWallMs: number
	maxCommandWallMs: number
	maxCommands: number
	maxOutputBytesPerCommand: number
}

export interface CampaignConfig {
	version: 1
	id: string
	target: string
	suite?: string
	artifactRoot: string
	budgets: CampaignBudgets
	allowedCommandPrefixes: string[][]
	validationCommands: CampaignCommand[]
	model: { enabled: false }
}

export interface CommandArtifact {
	id: string
	command: string
	args: string[]
	cwd: string
	startedAt: string
	finishedAt: string
	durationMs: number
	exitCode: number | null
	status: "passed" | "failed" | "timed_out" | "infrastructure_error"
	stdoutArtifact: string
	stderrArtifact: string
	stdoutDigest: string
	stderrDigest: string
	stdoutBytes: number
	stderrBytes: number
	outputTruncated: boolean
	error?: string
}

export interface CampaignAttempt {
	id: string
	status: "running" | AttemptTerminalStatus
	startedAt: string
	finishedAt?: string
	durationMs?: number
	commands: CommandArtifact[]
	reason?: string
}

export interface CampaignState {
	version: 1
	id: string
	configDigest: string
	status: CampaignStatus
	createdAt: string
	updatedAt: string
	attempts: CampaignAttempt[]
}

export interface ProcessSpec {
	command: string
	args: string[]
	cwd: string
	timeoutMs: number
	maxOutputBytes: number
}

export interface ProcessResult {
	exitCode: number | null
	stdout: string
	stderr: string
	durationMs: number
	timedOut: boolean
	outputTruncated: boolean
}

export interface ProcessRunner {
	run(spec: ProcessSpec): Promise<ProcessResult>
}

export interface Clock {
	now(): Date
	monotonicMs(): number
}
