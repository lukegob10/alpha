import { DEVELOPMENT_SCENARIO_IDS } from "./developmentCatalog"
import { RELIABILITY_SCENARIO_IDS } from "./reliabilityCatalog"

export const WORKFLOW_SCENARIO_IDS = [
	"review-edit-test-commit-followup",
	"cancel-resume",
	"long-thread",
	"reload-continuation",
	...DEVELOPMENT_SCENARIO_IDS,
	...RELIABILITY_SCENARIO_IDS,
] as const

export type WorkflowScenarioId = (typeof WORKFLOW_SCENARIO_IDS)[number]
export const MAX_WORKFLOW_TURNS = 12
/** Resource budgets, not counts derived from today's fixture assertions. */
export const MAX_WORKFLOW_CHECKS = 1024
export const MAX_WORKFLOW_CHECK_NAME_LENGTH = 128
export const MAX_WORKFLOW_RESULT_BYTES = 1024 * 1024
export type WorkflowPhase = "run" | "prepare" | "continue"
export type WorkflowFailureCategory =
	| "configuration"
	| "provider"
	| "policy"
	| "tool"
	| "persistence"
	| "lifecycle"
	| "assertion"
	| "timeout"
	| "harness"

export interface WorkflowCheck {
	name: string
	passed: boolean
}

export interface WorkflowResult {
	schemaVersion: 1
	runId: string
	scenarioId: WorkflowScenarioId
	phase: WorkflowPhase
	status: "passed" | "failed" | "blocked" | "checkpointed"
	checks: WorkflowCheck[]
	taskIds: string[]
	hostVersion: string
	providerMode: string
	model: { id?: string; family?: string; vendor?: string; reasoningEffort?: string }
	requestsUsed: number | null
	failure?: { category: WorkflowFailureCategory; code: string }
}

export class WorkflowFailure extends Error {
	constructor(
		readonly category: WorkflowFailureCategory,
		readonly code: string,
		readonly blocked = false,
	) {
		super(`Workflow ${category}: ${code}`)
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)
const boundedText = (value: unknown, maximum = 128): value is string =>
	typeof value === "string" && value.length > 0 && value.length <= maximum
const validModel = (value: unknown): boolean =>
	isRecord(value) &&
	["id", "family", "vendor", "reasoningEffort"].every((key) => value[key] === undefined || boundedText(value[key]))

export function isWorkflowCheck(value: unknown): value is WorkflowCheck {
	return (
		isRecord(value) && boundedText(value.name, MAX_WORKFLOW_CHECK_NAME_LENGTH) && typeof value.passed === "boolean"
	)
}

/** Shared producer/consumer envelope validation; outcome assertions remain independent. */
export function assertWorkflowResult(value: unknown): asserts value is WorkflowResult {
	if (
		!isRecord(value) ||
		value.schemaVersion !== 1 ||
		!boundedText(value.runId) ||
		!WORKFLOW_SCENARIO_IDS.includes(value.scenarioId as WorkflowScenarioId) ||
		typeof value.phase !== "string" ||
		!["run", "prepare", "continue"].includes(value.phase) ||
		typeof value.status !== "string" ||
		!["passed", "failed", "blocked", "checkpointed"].includes(value.status) ||
		!boundedText(value.hostVersion) ||
		!boundedText(value.providerMode) ||
		!validModel(value.model) ||
		!Array.isArray(value.taskIds) ||
		value.taskIds.length > 100 ||
		!value.taskIds.every((id) => boundedText(id) && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(id)) ||
		(value.requestsUsed !== null &&
			(typeof value.requestsUsed !== "number" ||
				!Number.isSafeInteger(value.requestsUsed) ||
				value.requestsUsed < 0))
	)
		throw new WorkflowFailure("harness", "invalid_workflow_result")
	if (!Array.isArray(value.checks)) throw new WorkflowFailure("harness", "invalid_workflow_checks")
	if (value.checks.length > MAX_WORKFLOW_CHECKS) throw new WorkflowFailure("harness", "workflow_check_limit_exceeded")
	if (!value.checks.every(isWorkflowCheck)) throw new WorkflowFailure("harness", "invalid_workflow_check")
	if (value.failure !== undefined || value.status === "failed" || value.status === "blocked") {
		if (
			!isRecord(value.failure) ||
			typeof value.failure.category !== "string" ||
			![
				"configuration",
				"provider",
				"policy",
				"tool",
				"persistence",
				"lifecycle",
				"assertion",
				"timeout",
				"harness",
			].includes(value.failure.category) ||
			!boundedText(value.failure.code)
		)
			throw new WorkflowFailure("harness", "invalid_workflow_failure")
	}
}

export function readWorkflowSelection(env: NodeJS.ProcessEnv): {
	scenarioId: WorkflowScenarioId
	phase: WorkflowPhase
	turns: number
	requestCap: number
	timeoutMs: number
} {
	const scenarioId = env.ALPHA_E2E_SCENARIO_ID
	if (!WORKFLOW_SCENARIO_IDS.includes(scenarioId as WorkflowScenarioId)) {
		throw new WorkflowFailure("configuration", "unknown_scenario", true)
	}
	const phase = env.ALPHA_E2E_SCENARIO_PHASE ?? (scenarioId === "reload-continuation" ? "prepare" : "run")
	if (
		(scenarioId === "reload-continuation" && phase !== "prepare" && phase !== "continue") ||
		(scenarioId !== "reload-continuation" && phase !== "run")
	) {
		throw new WorkflowFailure("configuration", "invalid_phase", true)
	}
	const boundedInteger = (value: string | undefined, fallback: number, min: number, max: number): number => {
		if (value === undefined) return fallback
		if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
			throw new WorkflowFailure("configuration", "invalid_budget", true)
		}
		return Number(value)
	}
	return {
		scenarioId: scenarioId as WorkflowScenarioId,
		phase: phase as WorkflowPhase,
		turns: boundedInteger(env.ALPHA_E2E_SCENARIO_TURNS, 6, 4, MAX_WORKFLOW_TURNS),
		requestCap: boundedInteger(env.ALPHA_E2E_REQUEST_LIMIT, 60, 1, 200),
		timeoutMs: boundedInteger(env.ALPHA_E2E_SCENARIO_TIMEOUT_MS, 300_000, 1_000, 1_200_000),
	}
}
