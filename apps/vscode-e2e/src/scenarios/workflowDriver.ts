import {
	WorkflowFailure,
	isWorkflowCheck,
	MAX_WORKFLOW_CHECKS,
	MAX_WORKFLOW_TURNS,
	type WorkflowCheck,
	type WorkflowPhase,
	type WorkflowResult,
	type WorkflowScenarioId,
} from "./contracts"
import type { WorkflowPromptName } from "./prompts"
import {
	DEVELOPMENT_PHASES,
	DEVELOPMENT_SCENARIOS,
	DEVELOPMENT_SCENARIO_IDS,
	type DevelopmentScenarioId,
	type DevelopmentPhaseId,
} from "./developmentCatalog"
import type { WorkflowTrace } from "./workflowTrace"
import { isRecoveryPhase } from "./recoveryTrace"
import type { LifecycleInspectionErrorCode, ToolTransactionErrorCode } from "./transactionAssertions"
import { isReliabilityScenario, type ReliabilityScenarioId } from "./reliabilityCatalog"

export interface WorkflowEvidence {
	trace?: WorkflowTrace
	recoveryChecks?: WorkflowCheck[]
	callCount: number
	resultCount: number
	completedTurns: number
	cancelledTurns: number
	failedTurns: number
	errors: Array<LifecycleInspectionErrorCode | ToolTransactionErrorCode>
}

export interface WorkflowHost {
	start(prompt: WorkflowPromptName): Promise<string>
	followup(taskId: string, prompt: WorkflowPromptName, step?: number): Promise<void>
	complete(taskId: string, outcome?: "completed" | "blocked"): Promise<void>
	waitForCommandApproval(taskId: string): Promise<void>
	cancel(taskId: string): Promise<void>
	resume(taskId: string, prompt: WorkflowPromptName): Promise<void>
	assertUiTask(taskId: string): Promise<void>
	inspect(taskId: string, outcome?: "completed" | "blocked"): Promise<WorkflowEvidence>
	requestsUsed(): number | null
}

export interface WorkflowCheckpoint {
	schemaVersion: 1
	scenarioId: "reload-continuation"
	taskId: string
	initialCommit: string
	workspace: string
	hostVersion: string
}

export interface WorkflowDependencies {
	host: WorkflowHost
	reliability?: (
		options: WorkflowOptions & { scenarioId: ReliabilityScenarioId },
		repository: WorkflowDependencies["repository"],
	) => Promise<WorkflowResult>
	development?: {
		create(scenarioId: DevelopmentScenarioId): Promise<void>
		verify(scenarioId: DevelopmentScenarioId, phase: "baseline" | DevelopmentPhaseId): Promise<WorkflowCheck[]>
	}
	repository: {
		create(): Promise<{ initialCommit: string }>
		verify(expected: "baseline" | "enhanced" | "committed" | "followup"): Promise<WorkflowCheck[]>
		test(): Promise<{ exitCode: number }>
		readCommit(): Promise<string>
		verifyAccumulatedCases(step: number): Promise<WorkflowCheck[]>
	}
	checkpoint: {
		read(): Promise<WorkflowCheckpoint>
		write(value: WorkflowCheckpoint): Promise<void>
	}
}

export interface WorkflowOptions {
	runId: string
	scenarioId: WorkflowScenarioId
	phase: WorkflowPhase
	workspace: string
	hostVersion: string
	providerMode: string
	model: WorkflowResult["model"]
	turns: number
}

/** The host drives Alpha; repository and transcript checks independently judge its effects. */
export async function runWorkflowScenario(
	options: WorkflowOptions,
	{ host, repository, checkpoint, development, reliability }: WorkflowDependencies,
): Promise<WorkflowResult> {
	if (isReliabilityScenario(options.scenarioId) && reliability)
		return reliability({ ...options, scenarioId: options.scenarioId }, repository)
	const result: WorkflowResult = {
		schemaVersion: 1,
		runId: options.runId,
		scenarioId: options.scenarioId,
		phase: options.phase,
		status: "failed",
		checks: [],
		taskIds: [],
		hostVersion: options.hostVersion,
		providerMode: options.providerMode,
		model: options.model,
		requestsUsed: null,
	}
	const recordCheck = (item: WorkflowCheck) => {
		// The suite can append one cleanup failure after this driver returns.
		if (result.checks.length >= MAX_WORKFLOW_CHECKS - 1)
			throw new WorkflowFailure("harness", "workflow_check_limit_exceeded")
		if (!isWorkflowCheck(item)) throw new WorkflowFailure("harness", "invalid_workflow_check")
		result.checks.push(item)
	}
	const check = (name: string, passed: boolean) => {
		recordCheck({ name, passed })
		if (!passed) throw new WorkflowFailure("assertion", name)
	}
	const verify = async (expected: "baseline" | "enhanced" | "committed" | "followup") => {
		const checks = await repository.verify(expected)
		check(`${expected}_checks_present`, checks.length > 0)
		for (const item of checks) check(`${expected}_${item.name}`, item.passed)
	}
	const inspect = async (taskId: string, minimumCompleted: number, requireCancellation = false, blocked = false) => {
		const evidence = await host.inspect(taskId, blocked ? "blocked" : "completed")
		if (evidence.errors.length > 0) {
			for (const code of evidence.errors) recordCheck({ name: code, passed: false })
			const code = evidence.errors[0]!
			throw new WorkflowFailure(code.startsWith("lifecycle_") ? "lifecycle" : "persistence", code)
		}
		check("tool_transactions_complete", evidence.errors.length === 0)
		check("actual_tool_calls_present", evidence.callCount > 0)
		check("all_calls_have_receipts", evidence.callCount === evidence.resultCount)
		check("required_turns_completed", evidence.completedTurns >= minimumCompleted)
		check("no_unexpected_failed_turn", evidence.failedTurns === 0)
		if (blocked) {
			check("blocked_turn_interrupted", evidence.cancelledTurns === 1)
			check("blocked_task_not_completed", evidence.completedTurns === minimumCompleted)
		}
		if (requireCancellation) check("cancelled_turn_recorded", evidence.cancelledTurns > 0)
		return evidence
	}
	const finish = async (taskId: string, expected: "baseline" | "enhanced" | "committed" | "followup") => {
		await host.complete(taskId)
		await host.assertUiTask(taskId)
		await verify(expected)
	}
	try {
		if (isReliabilityScenario(options.scenarioId))
			throw new WorkflowFailure("configuration", "reliability_driver_unavailable", true)
		if (!Number.isInteger(options.turns) || options.turns < 4 || options.turns > MAX_WORKFLOW_TURNS)
			throw new WorkflowFailure("configuration", "invalid_budget", true)
		if (DEVELOPMENT_SCENARIO_IDS.includes(options.scenarioId as DevelopmentScenarioId)) {
			if (options.phase !== "run") throw new WorkflowFailure("configuration", "invalid_phase", true)
			if (!development) throw new WorkflowFailure("configuration", "development_fixture_unavailable", true)
			const scenarioId = options.scenarioId as DevelopmentScenarioId
			const plan = DEVELOPMENT_SCENARIOS[scenarioId]
			const verifyPhase = async (phase: "baseline" | DevelopmentPhaseId) => {
				const checks = await development.verify(scenarioId, phase)
				check(`${phase}_checks_present`, checks.length > 0)
				for (const item of checks) check(`${phase}_${item.name}`, item.passed)
			}
			await development.create(scenarioId)
			await verifyPhase("baseline")
			check("development_phases_present", plan.phases.length > 0)
			let taskId: string | undefined
			let previousCalls = 0
			let previousCommands: Record<string, number> = {}
			for (const [index, phase] of plan.phases.entries()) {
				const blocked = phase === "devVerificationUnavailable"
				if (!taskId) {
					taskId = await host.start(phase)
					result.taskIds.push(taskId)
				} else await host.followup(taskId, phase)
				await host.complete(taskId, blocked ? "blocked" : "completed")
				await host.assertUiTask(taskId)
				// Inspect joins Task's durable terminal boundary before grading repository effects.
				const evidence = await inspect(taskId, blocked ? index : index + 1, false, blocked)
				check(`${phase}_new_tool_calls`, evidence.callCount > previousCalls)
				check(`${phase}_trace_present`, evidence.trace !== undefined)
				const trace = evidence.trace!
				if (isRecoveryPhase(phase)) {
					check(`${phase}_recovery_checks_present`, (evidence.recoveryChecks?.length ?? 0) > 0)
					for (const item of evidence.recoveryChecks ?? []) check(`${phase}_${item.name}`, item.passed)
				} else check(`${phase}_no_unexpected_tool_errors`, trace.errorResults === 0)
				for (const [commandIndex, command] of DEVELOPMENT_PHASES[phase].requiredCommands.entries())
					check(
						`${phase}_required_command_${commandIndex + 1}`,
						(trace.commandReceipts[command] ?? 0) > (previousCommands[command] ?? 0),
					)
				await verifyPhase(phase)
				previousCommands = trace.commandReceipts
				previousCalls = evidence.callCount
			}
			result.status = "passed"
			return result
		}
		if (options.scenarioId === "reload-continuation" && options.phase === "continue") {
			const retained = await checkpoint.read()
			check("checkpoint_version", retained.schemaVersion === 1)
			check("checkpoint_scenario", retained.scenarioId === options.scenarioId)
			check("checkpoint_workspace", retained.workspace === options.workspace)
			check("checkpoint_host", retained.hostVersion === options.hostVersion)
			check("checkpoint_task_id", /^[a-zA-Z0-9_-]{1,128}$/.test(retained.taskId))
			result.taskIds.push(retained.taskId)
			// Never create/reset a repository or a task when continuation evidence is missing.
			await verify("baseline")
			check("checkpoint_initial_commit", (await repository.readCommit()) === retained.initialCommit)
			await host.resume(retained.taskId, "enhance")
			await finish(retained.taskId, "enhanced")
			check("resumed_tests_pass", (await repository.test()).exitCode === 0)
			await inspect(retained.taskId, 2)
			result.status = "passed"
			return result
		}

		const fixture = await repository.create()
		await verify("baseline")
		check("baseline_regression_fails", (await repository.test()).exitCode !== 0)
		const cancelling = options.scenarioId === "cancel-resume"
		const taskId = await host.start(cancelling ? "hold" : "review")
		result.taskIds.push(taskId)
		await host.assertUiTask(taskId)
		if (cancelling) {
			await host.waitForCommandApproval(taskId)
			await host.cancel(taskId)
			await verify("baseline")
			await host.resume(taskId, "enhance")
			await finish(taskId, "enhanced")
			check("resumed_tests_pass", (await repository.test()).exitCode === 0)
			await inspect(taskId, 1, true)
			result.status = "passed"
			return result
		}

		await finish(taskId, "baseline")
		await inspect(taskId, 1)
		if (options.scenarioId === "reload-continuation") {
			await checkpoint.write({
				schemaVersion: 1,
				scenarioId: "reload-continuation",
				taskId,
				initialCommit: fixture.initialCommit,
				workspace: options.workspace,
				hostVersion: options.hostVersion,
			})
			result.status = "checkpointed"
			return result
		}

		await host.followup(taskId, "enhance")
		await finish(taskId, "enhanced")
		check("enhanced_tests_pass", (await repository.test()).exitCode === 0)
		await host.followup(taskId, "commit")
		await finish(taskId, "committed")
		await host.followup(taskId, "followup")
		await finish(taskId, "followup")
		check("followup_tests_pass", (await repository.test()).exitCode === 0)
		const turns = options.scenarioId === "long-thread" ? options.turns : 4
		for (let turn = 4; turn < turns; turn++) {
			await host.followup(taskId, "extend", turn - 3)
			await finish(taskId, "followup")
			const cases = await repository.verifyAccumulatedCases(turn - 3)
			check(`turn_${turn + 1}_dependent_checks_present`, cases.length > 0)
			for (const item of cases) check(item.name, item.passed)
			check(`turn_${turn + 1}_tests_pass`, (await repository.test()).exitCode === 0)
		}
		await inspect(taskId, turns)
		result.status = "passed"
	} catch (error) {
		const failure =
			error instanceof WorkflowFailure ? error : new WorkflowFailure("harness", "unclassified_failure")
		result.status = failure.blocked ? "blocked" : "failed"
		result.failure = { category: failure.category, code: failure.code }
	} finally {
		result.requestsUsed = host.requestsUsed()
	}
	return result
}
