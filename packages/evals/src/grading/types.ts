import type { HarnessClock, HarnessProcessRunner } from "../orchestration/index"

export const graderTypes = [
	"command",
	"filesystem",
	"diff-policy",
	"trace-assertion",
	"static-analysis",
	"usage-policy",
] as const
export type GraderType = (typeof graderTypes)[number]
export type GraderStatus = "passed" | "failed" | "error"
export type GraderFailureClass = "outcome" | "safety"

export type GraderDiagnostic = {
	code: string
	message: string
	path?: string
	severity: "info" | "warning" | "error"
}

export type GraderEvidence = {
	id: string
	kind: "stdout" | "stderr" | "file" | "diff" | "trace" | "report"
	mediaType: string
	digest: string
	byteLength: number
	metadata?: Record<string, unknown>
}

type BaseGraderSpec = {
	id: string
	version: number
	type: GraderType
	hardGate: boolean
	failureClass: GraderFailureClass
}

export type CommandGraderSpec = BaseGraderSpec & {
	type: "command"
	commands: Array<{ command: string; args: string[] }>
	cwd: "workspace" | "hidden"
	timeoutMs: number
	maxOutputBytes: number
}

export type FilesystemAssertion =
	| { kind: "exists"; path: string }
	| { kind: "absent"; path: string }
	| { kind: "content-equals"; path: string; expected: string }
	| { kind: "content-matches"; path: string; pattern: string; flags?: string }

export type FilesystemGraderSpec = BaseGraderSpec & {
	type: "filesystem"
	assertions: FilesystemAssertion[]
}

export type DiffPolicyGraderSpec = BaseGraderSpec & {
	type: "diff-policy"
	allowed?: string[]
	forbidden?: string[]
	maxChangedFiles?: number
}

export type TraceAssertion =
	| { kind: "present"; eventType: string }
	| { kind: "absent"; eventType: string }
	| { kind: "ordered"; before: string; after: string }
	| { kind: "count-max"; eventType: string; max: number }

export type TraceAssertionGraderSpec = BaseGraderSpec & {
	type: "trace-assertion"
	assertions: TraceAssertion[]
}

export type StaticAnalysisGraderSpec = BaseGraderSpec & {
	type: "static-analysis"
	files?: Array<{
		path: string
		parseAs?: "text" | "json"
		requiredPatterns?: string[]
		forbiddenPatterns?: string[]
	}>
	scanChangedFiles?: { extensions: string[]; forbiddenPatterns: string[] }
}

export type UsagePolicyGraderSpec = BaseGraderSpec & {
	type: "usage-policy"
	maxModelCalls: number
	maxToolCalls: number
	maxCostUsd: number
}

export type GraderSpec =
	| CommandGraderSpec
	| FilesystemGraderSpec
	| DiffPolicyGraderSpec
	| TraceAssertionGraderSpec
	| StaticAnalysisGraderSpec
	| UsagePolicyGraderSpec

export type GraderResult = {
	graderId: string
	graderVersion: number
	type: GraderType
	status: GraderStatus
	hardGate: boolean
	failureClass: GraderFailureClass
	startedAt: string
	finishedAt: string
	durationMs: number
	diagnostics: GraderDiagnostic[]
	evidence: GraderEvidence[]
	error?: string
}

export type EvalTraceEvent = {
	sequence: number
	type: string
	timestamp: string
	payload?: unknown
}

export type GraderContext = {
	workspaceRoot: string
	hiddenRoot?: string
	changedPaths: string[]
	trace: EvalTraceEvent[]
	usage?: unknown
	environment?: Record<string, unknown>
	processRunner: HarnessProcessRunner
	clock: HarnessClock
	evidenceSink?: (
		id: string,
		kind: GraderEvidence["kind"],
		value: string,
		mediaType: string,
	) => Promise<GraderEvidence>
}

export interface GraderPlugin<TSpec extends GraderSpec = GraderSpec> {
	readonly type: TSpec["type"]
	execute(spec: TSpec, context: GraderContext): Promise<Omit<GraderResult, "startedAt" | "finishedAt" | "durationMs">>
}

export type GraderRunResult = {
	decision: "passed" | "outcome_failed" | "safety_failed" | "grader_error"
	results: GraderResult[]
}
