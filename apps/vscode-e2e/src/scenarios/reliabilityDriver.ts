import { performance } from "node:perf_hooks"
import { setTimeout as delay } from "node:timers/promises"
import { WorkflowFailure, type WorkflowResult } from "./contracts"
import type { ExtensionWorkflowHost } from "./extensionWorkflowHost"
import { LiveResponseFaultController } from "./liveResponseFault"
import type { WorkflowRequestBudget } from "./requestBudget"
import type { WorkflowDependencies, WorkflowOptions } from "./workflowDriver"
import type { ReliabilityScenarioId } from "./reliabilityCatalog"

type Observation = { phase: string; elapsedMs: number; requestsBefore: number; requestsAfter: number; heapUsed: number }

/** Live acceptance orchestration only. All effects still pass through the existing Alpha task API. */
export async function runReliabilityScenario(
	options: WorkflowOptions & { scenarioId: ReliabilityScenarioId },
	host: ExtensionWorkflowHost,
	budget: WorkflowRequestBudget,
	repository: WorkflowDependencies["repository"],
	writeEvidence: (name: string, value: unknown) => Promise<void>,
): Promise<WorkflowResult> {
	const result: WorkflowResult = {
		schemaVersion: 1,
		runId: options.runId,
		scenarioId: options.scenarioId,
		phase: "run",
		status: "failed",
		checks: [],
		taskIds: [],
		hostVersion: options.hostVersion,
		providerMode: options.providerMode,
		model: options.model,
		requestsUsed: null,
	}
	const observations: Observation[] = []
	const fault = new LiveResponseFaultController()
	const check = (name: string, passed: boolean) => {
		result.checks.push({ name, passed })
		if (!passed) throw new WorkflowFailure("assertion", name)
	}
	const measure = async (phase: string, run: () => Promise<void>) => {
		const began = performance.now()
		const requestsBefore = budget.used
		try {
			await run()
		} finally {
			observations.push({
				phase,
				elapsedMs: Math.round(performance.now() - began),
				requestsBefore,
				requestsAfter: budget.used,
				heapUsed: process.memoryUsage().heapUsed,
			})
		}
	}
	const inspect = async (id: string, cancelled = false) => {
		const trace = await host.inspect(id)
		check("admitted_messages_exactly_once", host.admissionsAreUnique(id))
		check("tool_transactions_valid", trace.errors.length === 0 && trace.callCount === trace.resultCount)
		check("completed_turn_present", trace.completedTurns > 0)
		if (cancelled) check("cancelled_turn_present", trace.cancelledTurns > 0)
	}
	let taskId: string | undefined
	try {
		if (options.providerMode !== "live-copilot")
			throw new WorkflowFailure("configuration", "reliability_requires_live_copilot", true)
		await repository.create()
		for (const item of await repository.verify("baseline")) check(`baseline_${item.name}`, item.passed)
		if (options.scenarioId === "background-isolation") {
			fault.arm("pause")
			budget.transformResponse = (response) => fault.wrap(response)
			taskId = await host.start("review")
			result.taskIds.push(taskId)
			await host.waitForFault(() => fault.injected)
			const backgroundId = await host.startBackgroundReview()
			result.taskIds.push(backgroundId)
			check("distinct_background_task", backgroundId !== taskId)
			await measure("background_while_foreground_held", () => host.complete(backgroundId))
			await inspect(backgroundId)
			await host.assertUiTask(taskId)
			check("background_reached_real_model", budget.used > 1)
			fault.release()
			await host.complete(taskId)
			await inspect(taskId)
			for (const item of await repository.verify("baseline")) check(`concurrent_${item.name}`, item.passed)
		} else if (
			["stream-cancel-recovery", "provider-error-recovery", "provider-empty-recovery"].includes(
				options.scenarioId,
			)
		) {
			fault.arm(
				options.scenarioId === "stream-cancel-recovery"
					? "pause"
					: options.scenarioId === "provider-error-recovery"
						? "error"
						: "empty",
			)
			budget.transformResponse = (response) => fault.wrap(response)
			taskId = await host.start("review")
			result.taskIds.push(taskId)
			await measure("real_response_fault", () => host.waitForFault(() => fault.injected))
			check("real_provider_part_observed", fault.observedParts > 0 && budget.used > 0)
			if (options.scenarioId === "stream-cancel-recovery") {
				try {
					await measure("cancel_held_stream", () => host.cancelAtStreamBoundary(taskId!))
				} finally {
					fault.release()
				}
				await host.waitForResumeBoundary(taskId)
				await measure("resume_after_cancel", () => host.resume(taskId!, "enhance"))
			} else {
				await measure("provider_recovery", () => host.recoverProviderError(taskId!))
			}
			await measure("recovered_completion", () => host.complete(taskId!))
			await inspect(taskId, options.scenarioId === "stream-cancel-recovery")
			check("recovery_reached_real_provider", budget.used > 1)
			const expected = options.scenarioId === "stream-cancel-recovery" ? "enhanced" : "baseline"
			for (const item of await repository.verify(expected)) check(`recovered_${item.name}`, item.passed)
		} else if (options.scenarioId === "task-cycle-soak") {
			for (let cycle = 0; cycle < options.turns; cycle++) {
				await measure(`cycle_${cycle}`, async () => {
					taskId = await host.start("review")
					result.taskIds.push(taskId)
					await host.complete(taskId)
					await inspect(taskId)
					await host.assertUiTask(taskId)
				})
			}
			check("fresh_task_per_cycle", new Set(result.taskIds).size === options.turns)
			for (const item of await repository.verify("baseline")) check(`soak_${item.name}`, item.passed)
		} else {
			taskId = await host.start("review")
			result.taskIds.push(taskId)
			await host.complete(taskId, "review")
			for (const phase of ["enhance", "commit", "followup", "completionIdle"] as const) {
				await measure(phase, async () => {
					await host.followup(taskId!, phase)
					await host.complete(taskId!, "review")
				})
			}
			for (const item of await repository.verify("followup")) check(`implementation_${item.name}`, item.passed)
			check("implementation_tests_pass", (await repository.test()).exitCode === 0)
			const before = await host.captureCompletionReview(taskId)
			const requestsAtReview = budget.used
			const began = performance.now()
			if (options.scenarioId === "completion-idle") await measure("idle_review", () => delay(35_000))
			const after = await host.captureCompletionReview(taskId)
			await writeEvidence("completion-idle.json", {
				schemaVersion: 1,
				runId: options.runId,
				hostVersion: options.hostVersion,
				provider: options.providerMode,
				model: budget.model,
				taskId,
				elapsedMs: Math.round(performance.now() - began),
				requestsAtReview,
				requestsAfterIdle: budget.used,
				states: [before, after],
			})
			check("idle_makes_no_requests", budget.used === requestsAtReview)
			check("host_waits_for_review", after.liveTasksById[taskId]?.isWaitingForInput === true)
			await measure("review_followup", () => host.followup(taskId!, "verify"))
			await host.complete(taskId)
			await inspect(taskId)
			if (options.scenarioId === "context-compaction") {
				const requestsBefore = budget.used
				await measure("manual_compaction", async () =>
					check("new_summary_persisted", await host.condense(taskId!)),
				)
				check("compaction_used_real_model", budget.used > requestsBefore)
				await measure("post_compaction_followup", () => host.followup(taskId!, "verify"))
				await host.complete(taskId)
				await inspect(taskId)
				for (const item of await repository.verify("followup")) check(`compacted_${item.name}`, item.passed)
				check("post_compaction_tests_pass", (await repository.test()).exitCode === 0)
			}
			if (options.scenarioId === "completion-admission") {
				await measure("accepted_completion_followup", () => host.followup(taskId!, "verify"))
				await host.complete(taskId)
				await inspect(taskId)
			}
			check("followup_reaches_provider", budget.used > requestsAtReview)
		}
		result.status = "passed"
	} catch (error) {
		const failure =
			error instanceof WorkflowFailure
				? error
				: new WorkflowFailure("harness", "reliability_unclassified_failure")
		result.status = failure.blocked ? "blocked" : "failed"
		result.failure = { category: failure.category, code: failure.code }
		if (taskId) {
			try {
				await writeEvidence("reliability-failure-state.json", await host.captureTaskState(taskId))
			} catch {
				result.checks.push({ name: "failure_state_capture", passed: false })
			}
		}
	} finally {
		fault.release()
		budget.transformResponse = undefined
		result.requestsUsed = budget.used
		await writeEvidence("reliability-observations.json", {
			schemaVersion: 1,
			runId: options.runId,
			model: budget.model,
			observations,
			fault: { injected: fault.injected, observedParts: fault.observedParts },
		})
	}
	return result
}
