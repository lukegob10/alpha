import { strict as assert } from "node:assert"
import { test } from "node:test"
import { assertWorkflowResult, MAX_WORKFLOW_CHECKS, MAX_WORKFLOW_TURNS } from "./contracts"
import { DEVELOPMENT_PHASES, DEVELOPMENT_SCENARIOS, DEVELOPMENT_SCENARIO_IDS } from "./developmentCatalog"

import {
	runWorkflowScenario,
	type WorkflowCheckpoint,
	type WorkflowDependencies,
	type WorkflowOptions,
} from "./workflowDriver"

const options: WorkflowOptions = {
	runId: "workflow-driver-test",
	scenarioId: "review-edit-test-commit-followup",
	phase: "run",
	workspace: "/fixture",
	hostVersion: "1.122.1",
	providerMode: "scripted",
	model: { id: "fixture" },
	turns: 6,
}

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
	fixture.deps.host.complete = async (taskId) => {
		await complete(taskId)
		calls++
		for (const command of DEVELOPMENT_PHASES[phase!].requiredCommands)
			commands[command] = (commands[command] ?? 0) + 1
	}
	const inspect = fixture.deps.host.inspect
	fixture.deps.host.inspect = async (taskId) => ({
		...(await inspect(taskId)),
		callCount: calls,
		resultCount: calls,
		trace: { commandReceipts: { ...commands }, errorResults: 0 },
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
