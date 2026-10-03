import { strict as assert } from "node:assert"
import { test } from "node:test"
import { assertWorkflowResult, MAX_WORKFLOW_CHECKS, MAX_WORKFLOW_TURNS, WorkflowFailure } from "./contracts"
import {
	DEVELOPMENT_PHASES,
	DEVELOPMENT_SCENARIOS,
	DEVELOPMENT_SCENARIO_IDS,
	RECOVERY_COMMANDS,
} from "./developmentCatalog"
import { inspectRecoveryTrace, isRecoveryPhase } from "./recoveryTrace"
import { inspectWorkflowTrace } from "./workflowTrace"

import {
	runWorkflowScenario,
	aggregateTaskUsage,
	type WorkflowCheckpoint,
	type WorkflowDependencies,
	type WorkflowOptions,
} from "./workflowDriver"

const options: WorkflowOptions = {
	runId: "workflow-driver-test",
	scenarioId: "review-edit-test-commit-followup",
	phase: "run",
	workspace: "/fixture",
	hostVersion: "1.125.0",
	providerMode: "scripted",
	model: { id: "fixture" },
	turns: 6,
}

test("unobserved task usage remains unknown, while independently observed zero remains zero", async () => {
	const { deps } = fakeDependencies()
	assert.deepEqual(await aggregateTaskUsage(deps.host, ["task-1"]), {
		inputTokens: null,
		outputTokens: null,
		cost: null,
	})
	assert.deepEqual(await aggregateTaskUsage(deps.host, []), { inputTokens: null, outputTokens: null, cost: null })
	deps.host.readProblemUsage = async (taskId) => ({
		inputTokens: taskId === "task-1" ? 10 : null,
		outputTokens: 0,
		cost: null,
	})
	assert.deepEqual(await aggregateTaskUsage(deps.host, ["task-1", "task-2"]), {
		inputTokens: null,
		outputTokens: 0,
		cost: null,
	})
	deps.host.readProblemUsage = async () => {
		throw new Error("unavailable")
	}
	assert.deepEqual(await aggregateTaskUsage(deps.host, ["task-1"]), {
		inputTokens: null,
		outputTokens: null,
		cost: null,
	})
})

function fakeDependencies() {
	const actions: string[] = []
	let completed = 0
	let cancelled = false
	let initialTest = true
	let checkpoint: WorkflowCheckpoint | undefined
	const deps: WorkflowDependencies = {
		host: {
			start: async (prompt) => {
				actions.push(`start:${prompt}`)
				return "task-1"
			},
			followup: async (id, prompt) => {
				actions.push(`followup:${id}:${prompt}`)
			},
			complete: async () => {
				completed++
			},
			waitForCommandApproval: async () => {
				actions.push("approval-pending")
			},
			cancel: async (id) => {
				cancelled = true
				actions.push(`cancel:${id}`)
			},
			resume: async (id, prompt) => {
				actions.push(`resume:${id}:${prompt}`)
			},
			assertUiTask: async () => {},
			inspect: async () => ({
				callCount: 1,
				resultCount: 1,
				completedTurns: completed,
				cancelledTurns: cancelled ? 1 : 0,
				failedTurns: 0,
				errors: [],
			}),
			requestsUsed: () => 5,
		},
		repository: {
			readCommit: async () => "a".repeat(40),
			verifyAccumulatedCases: async (step) => [{ name: `cases_${step}`, passed: true }],
			create: async () => {
				actions.push("create-fixture")
				return { initialCommit: "a".repeat(40) }
			},
			verify: async (expected) => [{ name: expected, passed: true }],
			test: async () => {
				const exitCode = initialTest ? 1 : 0
				initialTest = false
				return { exitCode }
			},
		},
		checkpoint: {
			read: async () => {
				if (!checkpoint) throw new Error("Missing checkpoint")
				return checkpoint
			},
			write: async (value) => {
				checkpoint = value
			},
		},
	}
	return {
		deps,
		actions,
		setCompleted: (count: number) => {
			completed = count
		},
	}
}

function developmentDependencies() {
	const fixture = fakeDependencies()
	const commands: Record<string, number> = {}
	let calls = 0
	let phase: keyof typeof DEVELOPMENT_PHASES | undefined
	const start = fixture.deps.host.start
	const followup = fixture.deps.host.followup
	fixture.deps.host.start = async (prompt) => {
		phase = prompt as keyof typeof DEVELOPMENT_PHASES
		return start(prompt)
	}
	fixture.deps.host.followup = async (taskId, prompt) => {
		phase = prompt as keyof typeof DEVELOPMENT_PHASES
		await followup(taskId, prompt)
	}
	const complete = fixture.deps.host.complete
	fixture.deps.host.complete = async (taskId, outcome) => {
		await complete(taskId, outcome)
		calls++
		for (const command of DEVELOPMENT_PHASES[phase!].requiredCommands)
			commands[command] = (commands[command] ?? 0) + 1
	}
	const inspect = fixture.deps.host.inspect
	fixture.deps.host.inspect = async (taskId) => ({
		...(await inspect(taskId)),
		callCount: calls,
		resultCount: calls,
		trace: { commandReceipts: { ...commands }, successfulCommandReceipts: { ...commands }, errorResults: 0 },
		...(phase && isRecoveryPhase(phase) ? { recoveryChecks: [{ name: "recovery_oracle", passed: true }] } : {}),
	})
	fixture.deps.development = {
		create: async (id) => {
			fixture.actions.push(`development:${id}`)
		},
		verify: async (_id, phase) => [{ name: `effect_${phase}`, passed: true }],
	}
	return fixture
}

test("every development scenario uses the shared driver and one task with fresh trace checks per phase", async () => {
	for (const scenarioId of DEVELOPMENT_SCENARIO_IDS) {
		const { deps, actions } = developmentDependencies()
		const result = await runWorkflowScenario({ ...options, scenarioId }, deps)
		assert.equal(result.status, "passed", `${scenarioId}: ${result.failure?.code}`)
		assert.deepEqual(result.taskIds, ["task-1"])
		assert.equal(actions.filter((item) => item.startsWith("start:")).length, 1)
		assert.equal(
			actions.filter((item) => item.startsWith("followup:")).length,
			DEVELOPMENT_SCENARIOS[scenarioId].phases.length - 1,
		)
		assert.equal(actions.includes("create-fixture"), false)
		assertWorkflowResult(result)
	}
})

test("unavailable verification completes the physical turn while requiring independent unverified evidence", async () => {
	const { deps } = developmentDependencies()
	const complete = deps.host.complete
	const inspect = deps.host.inspect
	deps.host.complete = async (taskId, outcome) => {
		assert.notEqual(outcome, "blocked", "An honest unverified handoff does not interrupt a completed turn")
		await complete(taskId, outcome)
	}
	deps.host.inspect = async (taskId, outcome) => {
		assert.notEqual(outcome, "blocked")
		return inspect(taskId, outcome)
	}
	const result = await runWorkflowScenario({ ...options, scenarioId: "dev-verification-unavailable" }, deps)
	assert.equal(result.status, "passed", result.failure?.code)
	assert.ok(
		result.checks.some((check) => check.name === "devVerificationUnavailable_recovery_oracle" && check.passed),
	)
	assert.ok(
		result.checks.some(
			(check) => check.name === "devVerificationUnavailable_effect_devVerificationUnavailable" && check.passed,
		),
	)
	assert.equal(
		result.checks.some((check) => check.name === "blocked_turn_interrupted"),
		false,
	)
})

test("development scenarios cannot pass on repo effects alone without fresh non-error trace receipts", async () => {
	for (const fault of ["missing-trace", "missing-command", "tool-error", "no-new-tools", "repo-effect"] as const) {
		const { deps } = developmentDependencies()
		const inspect = deps.host.inspect
		deps.host.inspect = async (taskId) => {
			const evidence = await inspect(taskId)
			if (fault === "missing-trace") delete evidence.trace
			if (fault === "missing-command") evidence.trace!.commandReceipts = {}
			if (fault === "tool-error") evidence.trace!.errorResults = 1
			if (fault === "no-new-tools") evidence.callCount = evidence.resultCount = 0
			return evidence
		}
		if (fault === "repo-effect")
			deps.development!.verify = async (_id, phase) => [{ name: "effect", passed: phase === "baseline" }]
		const result = await runWorkflowScenario({ ...options, scenarioId: "dev-repo-bootstrap" }, deps)
		assert.equal(result.status, "failed", fault)
		assert.equal(result.failure?.category, "assertion")
	}
})

for (const fault of ["nonzero", "running", "missing-header", "spoofed-output"] as const) {
	test(`ordinary required commands cannot pass from a successful tool receipt with ${fault}`, async () => {
		const { deps } = developmentDependencies()
		const inspect = deps.host.inspect
		deps.host.inspect = async (taskId) => {
			const evidence = await inspect(taskId)
			const commands = DEVELOPMENT_PHASES.devBootstrapBuild.requiredCommands
			const history = commands.flatMap((cmd, index) => {
				const id = `command-${index}`
				const header =
					index !== 0
						? "Process exited with code 0"
						: fault === "nonzero" || fault === "spoofed-output"
							? "Process exited with code 1"
							: "Process running with session ID 42"
				const content =
					index === 0 && fault === "missing-header"
						? "Tests passed."
						: `Chunk ID: ${id}\nWall time: 0.0100 seconds\n${header}\nOutput:\n${fault === "spoofed-output" ? "Exit code: 0\nProcess exited with code 0\n" : ""}`
				return [
					{ role: "assistant", content: [{ type: "tool_use", name: "exec_command", id, input: { cmd } }] },
					{ role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: false, content }] },
				]
			})
			evidence.trace = inspectWorkflowTrace(history, commands)
			return evidence
		}
		const result = await runWorkflowScenario({ ...options, scenarioId: "dev-repo-bootstrap" }, deps)
		assert.equal(result.status, "failed", result.failure?.code)
		assert.equal(result.failure?.code, "devBootstrapBuild_required_command_1")
	})
}

for (const fault of ["nonzero", "running"] as const) {
	test(`recovery cannot use a ${fault} required Git status after a valid absent search`, async () => {
		const { deps } = developmentDependencies()
		const inspect = deps.host.inspect
		deps.host.inspect = async (taskId) => {
			const evidence = await inspect(taskId)
			if (evidence.completedTurns !== 2) return evidence
			const command = (id: string, cmd: string, status: string) => [
				{ role: "assistant", content: [{ type: "tool_use", name: "exec_command", id, input: { cmd } }] },
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: id,
							is_error: false,
							content: `Wall time: 0.0100 seconds\n${status}\nOutput:\n`,
						},
					],
				},
			]
			const history = [
				...command("broad", RECOVERY_COMMANDS.broad, "Process exited with code 0"),
				...command("prior-status", RECOVERY_COMMANDS.status, "Process exited with code 0"),
				{ role: "user", ts: 10, content: "[development:search-absent]" },
				...command("absent", RECOVERY_COMMANDS.absent, "Process exited with code 1"),
				...command(
					"status",
					RECOVERY_COMMANDS.status,
					fault === "nonzero" ? "Process exited with code 7" : "Process running with session ID 42",
				),
				{ role: "assistant", content: "No matches found." },
			]
			evidence.trace = inspectWorkflowTrace(history, [RECOVERY_COMMANDS.broad, RECOVERY_COMMANDS.status])
			evidence.recoveryChecks = inspectRecoveryTrace(history, [], "devSearchAbsent")
			assert.ok(
				evidence.recoveryChecks.every((check) => check.passed),
				"The absent-search oracle is satisfied",
			)
			return evidence
		}
		const result = await runWorkflowScenario({ ...options, scenarioId: "dev-search-recovery" }, deps)
		assert.equal(result.status, "failed")
		assert.equal(result.failure?.code, "devSearchAbsent_required_command_1")
	})
}

test("unverified recovery acceptance requires its oracle and a single completed physical turn", async () => {
	for (const fault of [
		"missing-oracle",
		"failed-oracle",
		"duplicate-completion",
		"failed-turn",
		"open-turn",
		"cancelled-turn",
	] as const) {
		const { deps } = developmentDependencies()
		const inspect = deps.host.inspect
		deps.host.inspect = async (taskId, outcome) => {
			const evidence = await inspect(taskId, outcome)
			if (fault === "missing-oracle") delete evidence.recoveryChecks
			if (fault === "failed-oracle") evidence.recoveryChecks = [{ name: "recovery_oracle", passed: false }]
			if (fault === "duplicate-completion") evidence.completedTurns = 2
			if (fault === "failed-turn") evidence.failedTurns = 1
			if (fault === "open-turn") evidence.completedTurns = 0
			if (fault === "cancelled-turn") evidence.cancelledTurns = 1
			return evidence
		}
		const result = await runWorkflowScenario({ ...options, scenarioId: "dev-verification-unavailable" }, deps)
		assert.equal(result.status, "failed", fault)
	}
})

test("development fixture setup failures and invalid phases admit no task", async () => {
	for (const fault of ["setup", "phase", "missing-fixture"] as const) {
		const { deps, actions } = developmentDependencies()
		if (fault === "setup")
			deps.development!.create = async () => {
				throw new Error("fixture unavailable")
			}
		if (fault === "missing-fixture") delete deps.development
		const result = await runWorkflowScenario(
			{ ...options, scenarioId: "dev-git-inspect", phase: fault === "phase" ? "continue" : "run" },
			deps,
		)
		assert.notEqual(result.status, "passed")
		assert.deepEqual(result.taskIds, [])
		assert.equal(actions.filter((item) => item.startsWith("start:")).length, 0)
	}
})

test("a follow-up cannot reuse prior command receipts as proof that it reran the migration", async () => {
	const { deps } = developmentDependencies()
	const inspect = deps.host.inspect
	let firstCommands: Record<string, number> | undefined
	deps.host.inspect = async (taskId) => {
		const evidence = await inspect(taskId)
		firstCommands ??= evidence.trace!.commandReceipts
		evidence.trace!.commandReceipts = firstCommands
		return evidence
	}
	const result = await runWorkflowScenario({ ...options, scenarioId: "dev-local-migration" }, deps)
	assert.equal(result.status, "failed")
	assert.match(result.failure!.code, /devMigrationRerun_required_command_/)
})

test("fresh migration invocations cannot reuse prior successful-process receipts", async () => {
	const { deps } = developmentDependencies()
	const inspect = deps.host.inspect
	let firstSuccesses: Record<string, number> | undefined
	deps.host.inspect = async (taskId) => {
		const evidence = await inspect(taskId)
		firstSuccesses ??= evidence.trace!.successfulCommandReceipts
		evidence.trace!.successfulCommandReceipts = firstSuccesses
		return evidence
	}
	const result = await runWorkflowScenario({ ...options, scenarioId: "dev-local-migration" }, deps)
	assert.equal(result.status, "failed")
	assert.match(result.failure!.code, /devMigrationRerun_required_command_/)
})

test("workflow checks effects, one same-task chain and bounded long-thread turns", async () => {
	const { deps, actions } = fakeDependencies()
	const result = await runWorkflowScenario({ ...options, scenarioId: "long-thread" }, deps)
	assert.equal(result.status, "passed")
	assert.deepEqual(result.taskIds, ["task-1"])
	assert.equal(actions.filter((action) => action.startsWith("start:")).length, 1)
	assert.equal(actions.filter((action) => action.startsWith("followup:")).length, 5)
	assert.equal(result.requestsUsed, 5)
})

test("producer overflow returns a bounded failure receipt with room for suite cleanup", async () => {
	for (const boundary of ["repository", "integrity"] as const) {
		const { deps } = fakeDependencies()
		if (boundary === "repository")
			deps.repository.verify = async () =>
				Array.from({ length: MAX_WORKFLOW_CHECKS }, () => ({ name: "check", passed: true }))
		else {
			const inspect = deps.host.inspect
			deps.host.inspect = async (taskId) => ({
				...(await inspect(taskId)),
				errors: Array.from({ length: MAX_WORKFLOW_CHECKS }, () => "missing_tool_result" as const),
			})
		}
		const result = await runWorkflowScenario(options, deps)
		assert.equal(result.status, "failed")
		assert.equal(result.failure?.code, "workflow_check_limit_exceeded")
		assert.equal(result.requestsUsed, 5)
		assert.equal(result.checks.length, MAX_WORKFLOW_CHECKS - 1)
		result.checks.push({ name: "scenario_cleanup", passed: false })
		assertWorkflowResult(result)
		assert.equal(result.checks.length, MAX_WORKFLOW_CHECKS)
		assert.throws(() =>
			assertWorkflowResult({ ...result, checks: [...result.checks, { name: "extra", passed: true }] }),
		)
	}
})

test("direct driver callers cannot bypass the supported turn boundary", async () => {
	for (const turns of [3, MAX_WORKFLOW_TURNS + 1, Number.NaN, 4.5]) {
		const { deps, actions } = fakeDependencies()
		const result = await runWorkflowScenario({ ...options, turns }, deps)
		assert.equal(result.status, "blocked")
		assert.equal(result.failure?.code, "invalid_budget")
		assert.deepEqual(actions, [])
		assertWorkflowResult(result)
	}
})

test("assistant completion cannot pass without real repository effects or tool receipts", async () => {
	for (const broken of ["repository", "receipts", "lifecycle"] as const) {
		const { deps } = fakeDependencies()
		if (broken === "repository")
			deps.repository.verify = async (expected) => [{ name: "effect", passed: expected === "baseline" }]
		if (broken === "receipts")
			deps.host.inspect = async () => ({
				callCount: 1,
				resultCount: 0,
				completedTurns: 1,
				cancelledTurns: 0,
				failedTurns: 0,
				errors: ["missing_tool_result"],
			})
		if (broken === "lifecycle")
			deps.host.inspect = async () => ({
				callCount: 1,
				resultCount: 1,
				completedTurns: 0,
				cancelledTurns: 0,
				failedTurns: 0,
				errors: [],
			})
		const result = await runWorkflowScenario(options, deps)
		assert.equal(result.status, "failed", broken)
		assert.equal(result.failure?.category, broken === "receipts" ? "persistence" : "assertion")
	}
})

test("cancel-resume cancels a known pending command then resumes the same task", async () => {
	const { deps, actions } = fakeDependencies()
	const result = await runWorkflowScenario({ ...options, scenarioId: "cancel-resume" }, deps)
	assert.equal(result.status, "passed")
	assert.deepEqual(actions, [
		"create-fixture",
		"start:hold",
		"approval-pending",
		"cancel:task-1",
		"resume:task-1:enhance",
	])
})

test("reload preparation is checkpointed, not passed; continuation cannot silently reset missing state", async () => {
	const { deps, actions } = fakeDependencies()
	const prepared = await runWorkflowScenario(
		{ ...options, scenarioId: "reload-continuation", phase: "prepare" },
		deps,
	)
	assert.equal(prepared.status, "checkpointed")
	const checkpoint = await deps.checkpoint.read()
	assert.equal(checkpoint.taskId, "task-1")
	actions.length = 0
	const continued = await runWorkflowScenario(
		{ ...options, scenarioId: "reload-continuation", phase: "continue" },
		deps,
	)
	assert.equal(continued.status, "passed")
	assert.deepEqual(actions, ["resume:task-1:enhance"])

	const missing = fakeDependencies()
	const failed = await runWorkflowScenario(
		{ ...options, scenarioId: "reload-continuation", phase: "continue" },
		missing.deps,
	)
	assert.equal(failed.status, "failed")
	assert.deepEqual(missing.actions, [])
})

test("failure result never copies arbitrary exception data", async () => {
	const { deps } = fakeDependencies()
	deps.host.start = async () => {
		throw new Error("Authorization: secret-token private prompt")
	}
	const result = await runWorkflowScenario(options, deps)
	assert.equal(result.status, "failed")
	assert.equal(JSON.stringify(result).includes("secret-token"), false)
	assert.deepEqual(result.failure, { category: "harness", code: "unclassified_failure" })
})

test("timeout attribution supplements the primary workflow failure", async () => {
	const { deps } = fakeDependencies()
	deps.host.complete = async () => {
		throw new WorkflowFailure("lifecycle", "unexpected_resume_task", false, "request_timeout")
	}
	const result = await runWorkflowScenario(options, deps)
	assert.deepEqual(result.failure, {
		category: "lifecycle",
		code: "unexpected_resume_task",
		providerCode: "request_timeout",
	})
})

test("reload rejects changed repository identity before any model dispatch", async () => {
	const { deps, actions } = fakeDependencies()
	await runWorkflowScenario({ ...options, scenarioId: "reload-continuation", phase: "prepare" }, deps)
	deps.repository.readCommit = async () => "b".repeat(40)
	actions.length = 0
	const result = await runWorkflowScenario({ ...options, scenarioId: "reload-continuation", phase: "continue" }, deps)
	assert.equal(result.status, "failed")
	assert.equal(result.failure?.code, "checkpoint_initial_commit")
	assert.deepEqual(actions, [])
})

test("long-thread cannot pass without dependent case evidence", async () => {
	const { deps } = fakeDependencies()
	deps.repository.verifyAccumulatedCases = async () => []
	const result = await runWorkflowScenario({ ...options, scenarioId: "long-thread" }, deps)
	assert.equal(result.status, "failed")
	assert.equal(result.failure?.code, "turn_5_dependent_checks_present")
})
