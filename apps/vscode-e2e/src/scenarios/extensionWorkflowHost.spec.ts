import { strict as assert } from "node:assert"
import { test } from "node:test"
import { EventEmitter } from "node:events"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import {
	AlphaCodeEventName,
	type ApprovalMode,
	type AlphaMessage,
	type AlphaCodeAPI,
	type AlphaCodeSettings,
	type TaskApprovalModeUpdate,
	type TaskApprovalModeUpdateResult,
} from "@alpha-code/types"

import {
	ExtensionWorkflowHost,
	isApprovedProblemCommand,
	problemCommandRejectionReason,
	isApprovedProblemToolAsk,
	isOutsideWorkspaceProblemToolAsk,
	isApprovedWorkflowCommand,
	readBoundedJson,
	usageFromHistoryItem,
	WORKFLOW_DISABLED_TOOLS,
} from "./extensionWorkflowHost"
import { WORKFLOW_COMMANDS, workflowCommands } from "./prompts"
import { DEVELOPMENT_PHASES, DEVELOPMENT_SCENARIOS } from "./developmentCatalog"
import { WorkflowRequestBudget } from "./requestBudget"
import { WorkflowFailure } from "./contracts"

const workspace = process.cwd()

for (const [name, later, attributed] of [
	["current timeout", [], true],
	["a newer main request", [{ type: "model_request_started", purpose: "task" }], false],
	["a completed main request", [{ type: "request_usage", purpose: "task" }], false],
	["late auxiliary usage", [{ type: "request_usage", purpose: "reasoning-summary" }], true],
] as const) {
	test(`resume failure preserves ${name} attribution without changing its primary code`, async () => {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-timeout-attribution-")))
		const taskId = "timeout-task"
		const task = { taskId, taskAsk: { ts: 1, ask: "resume_task", partial: false }, apiConversationHistory: [] }
		const directory = path.join(root, taskId)
		await fs.mkdir(directory)
		await fs.writeFile(
			path.join(directory, "agent_turn_events.jsonl"),
			[
				{ type: "model_request_started", purpose: "task" },
				{ type: "model_request_failed", code: "ProviderTimeout", purpose: "task" },
				...later,
			]
				.map((event) => JSON.stringify({ event }))
				.join("\n") + "\n",
		)
		const provider = Object.assign(new EventEmitter(), {
			getLiveTask: () => task,
			getTaskWithId: async () => ({ taskDirPath: directory }),
		})
		const api = Object.assign(new EventEmitter(), { sidebarProvider: provider, getConfiguration: () => ({}) })
		const host = new ExtensionWorkflowHost(
			api as unknown as AlphaCodeAPI,
			workspace,
			"scripted",
			new WorkflowRequestBudget(10),
			5_000,
		)
		try {
			await assert.rejects(
				host.complete(taskId),
				(error: unknown) =>
					error instanceof WorkflowFailure &&
					error.category === "lifecycle" &&
					error.code === "unexpected_resume_task" &&
					error.providerCode === (attributed ? "request_timeout" : undefined),
			)
		} finally {
			await host.dispose()
			await fs.rm(root, { recursive: true, force: true })
		}
	})
}

test("post-compaction reopen replaces the task instance and preserves the summary before follow-up", async () => {
	const actions: string[] = []
	const saved = [{ role: "user", content: "summary", isSummary: true, condenseId: "saved-summary" }]
	const previous = {
		taskId: "reopen-task",
		apiConversationHistory: saved,
		flushApiConversationHistoryPersistence: async () => {
			actions.push("flush")
		},
	}
	const reopened = { ...previous, taskAsk: { ask: "resume_task" }, apiConversationHistory: structuredClone(saved) }
	let current: typeof previous | undefined = previous
	const provider = Object.assign(new EventEmitter(), {
		getLiveTask: () => current,
		closeTask: async () => {
			actions.push("close")
			current = undefined
		},
	})
	const api = Object.assign(new EventEmitter(), {
		sidebarProvider: provider,
		getConfiguration: () => ({}),
		setConfiguration: async () => {},
		isTaskInHistory: async () => true,
		resumeTask: async () => {
			actions.push("load")
			current = reopened
		},
		cancelCurrentTask: async () => {},
	})
	const host = new ExtensionWorkflowHost(
		api as unknown as AlphaCodeAPI,
		workspace,
		"live-copilot",
		new WorkflowRequestBudget(10),
		5_000,
	)
	host.followup = async (id, prompt, step) => {
		assert.equal(current, reopened)
		assert.equal(id, "reopen-task")
		assert.equal(prompt, "contextProbe")
		assert.equal(step, 13)
		actions.push("followup")
	}
	try {
		await host.resume("reopen-task", "contextProbe", 13, { reopen: true })
		assert.deepEqual(actions, ["flush", "close", "load", "followup"])
	} finally {
		await host.dispose()
	}
})

test("a rejected manual compaction is a failure rather than a timeout", async () => {
	const task = {
		taskId: "compaction-task",
		apiConversationHistory: [],
		condenseContext: async () => {
			throw new Error("summary rejected")
		},
	}
	const provider = Object.assign(new EventEmitter(), { getLiveTask: () => task })
	const api = Object.assign(new EventEmitter(), { sidebarProvider: provider, getConfiguration: () => ({}) })
	const host = new ExtensionWorkflowHost(
		api as unknown as AlphaCodeAPI,
		workspace,
		"scripted",
		new WorkflowRequestBudget(10),
		5_000,
	)
	try {
		await assert.rejects(
			host.condense(task.taskId),
			(error: unknown) =>
				error instanceof WorkflowFailure &&
				error.category === "lifecycle" &&
				error.code === "live_compaction_failed",
		)
	} finally {
		await host.dispose()
	}
})

test("compaction evidence ties the latest measured receipt to the saved summary", async () => {
	const task = {
		taskId: "compaction-receipt",
		apiConversationHistory: [
			{ role: "user", content: "ALPHA-CONTEXT-ANCHOR-7f3a", isSummary: true, condenseId: "summary-1" },
		],
		clineMessages: [
			{
				say: "condense_context",
				contextCondense: {
					prevContextTokens: 900,
					newContextTokens: 450,
					outcome: "reduced",
					condenseId: "summary-1",
				},
			},
		],
	}
	const provider = Object.assign(new EventEmitter(), { getLiveTask: () => task })
	const api = Object.assign(new EventEmitter(), { sidebarProvider: provider, getConfiguration: () => ({}) })
	const host = new ExtensionWorkflowHost(
		api as unknown as AlphaCodeAPI,
		workspace,
		"scripted",
		new WorkflowRequestBudget(10),
		5_000,
	)
	try {
		assert.deepEqual(host.inspectCompactionEvidence(task.taskId, "ALPHA-CONTEXT-ANCHOR-7f3a"), {
			summaryId: "summary-1",
			receiptId: "summary-1",
			summaryRetainedFact: true,
			previousTokens: 900,
			currentTokens: 450,
		})
		task.clineMessages.push({
			say: "condense_context",
			contextCondense: {
				prevContextTokens: 450,
				newContextTokens: 450,
				outcome: "unchanged",
				condenseId: "summary-2",
			},
		})
		assert.deepEqual(host.inspectCompactionEvidence(task.taskId, "ALPHA-CONTEXT-ANCHOR-7f3a"), {
			summaryId: "summary-1",
			receiptId: "summary-2",
			summaryRetainedFact: true,
			previousTokens: 450,
			currentTokens: 450,
		})
	} finally {
		await host.dispose()
	}
})

test("late provider recovery waits for a new retry instead of counting earlier requests", async () => {
	const budget = new WorkflowRequestBudget(30)
	budget.used = 20
	let observations = 0
	let approvals = 0
	const task = {
		taskId: "late-fault",
		get taskAsk() {
			observations++
			return observations < 2 ? undefined : { ask: "api_req_failed", partial: false }
		},
		approveAsk: () => {
			approvals++
		},
	}
	const provider = Object.assign(new EventEmitter(), { getLiveTask: () => task })
	const api = Object.assign(new EventEmitter(), { sidebarProvider: provider, getConfiguration: () => ({}) })
	const host = new ExtensionWorkflowHost(api as unknown as AlphaCodeAPI, workspace, "scripted", budget, 5_000)
	try {
		await host.recoverProviderError(task.taskId, 19)
		assert.equal(approvals, 1)
		assert.ok(observations >= 2)
	} finally {
		await host.dispose()
	}
})

const history = (command: string, cwd: unknown = workspace, name: "shell" | "execute_command" = "execute_command") => [
	{
		role: "assistant",
		content: [{ type: "tool_use", id: "command-1", name, input: { command, cwd } }],
	},
]

test("completion is observed without an approval and retains its completed state for review", async () => {
	const task = {
		taskId: "review-task",
		didComplete: true,
		clineMessages: [
			{ ts: 1, type: "say", say: "completion_result", text: "Done", partial: false },
		] as AlphaMessage[],
		waitForTermination: async () => undefined,
		approveAsk: () => assert.fail("completion observation must not approve a boundary"),
	}
	const provider = Object.assign(new EventEmitter(), {
		getLiveTask: () => task,
		getStateToPostToWebview: async () => ({ currentTaskId: task.taskId }),
	})
	const api = Object.assign(new EventEmitter(), { sidebarProvider: provider, getConfiguration: () => ({}) })
	const host = new ExtensionWorkflowHost(
		api as unknown as AlphaCodeAPI,
		workspace,
		"scripted",
		new WorkflowRequestBudget(10),
		5_000,
	)
	try {
		api.emit(AlphaCodeEventName.TaskCompleted, task.taskId)
		await host.complete(task.taskId)
		const state = await host.captureCompletedTask(task.taskId)
		assert.equal(state.currentTaskId, task.taskId)
		assert.deepEqual(state.clineMessages, task.clineMessages)
	} finally {
		await host.dispose()
	}
})

test("blocked acceptance observes a resume boundary without approving it or accepting completed work", async () => {
	for (const boundary of ["resume_task", "completion_result", "api_req_failed"] as const) {
		const task = {
			taskId: "blocked-task",
			taskAsk: { ts: 1, type: "ask", ask: boundary } as AlphaMessage,
			didComplete: false,
			approveAsk: () => assert.fail("blocked acceptance must not approve a boundary"),
		}
		const provider = Object.assign(new EventEmitter(), { getLiveTask: () => task })
		const api = Object.assign(new EventEmitter(), { sidebarProvider: provider, getConfiguration: () => ({}) })
		const host = new ExtensionWorkflowHost(
			api as unknown as AlphaCodeAPI,
			workspace,
			"scripted",
			new WorkflowRequestBudget(10),
			5_000,
		)
		try {
			if (boundary === "resume_task") {
				await host.complete(task.taskId, "blocked")
				await assert.rejects(host.complete(task.taskId), /unexpected_resume_task/)
			} else
				await assert.rejects(
					host.complete(task.taskId, "blocked"),
					boundary === "completion_result" ? /unexpected_completed_verification/ : /api_req_failed/,
				)
		} finally {
			await host.dispose()
		}
	}
})

test("cancellation waits for an actual scoped command approval and never approves it", async () => {
	for (const ask of ["command", "followup"] as const) {
		const task = {
			taskId: "pending-command-task",
			taskAsk: { ts: 1, type: "ask", ask, text: WORKFLOW_COMMANDS.test } as AlphaMessage,
			apiConversationHistory: history(WORKFLOW_COMMANDS.test),
			approveAsk: () => assert.fail("cancellation must not approve the pending command"),
		}
		const provider = Object.assign(new EventEmitter(), { getLiveTask: () => task })
		const api = Object.assign(new EventEmitter(), {
			sidebarProvider: provider,
			getConfiguration: () => ({}),
		})
		const host = new ExtensionWorkflowHost(
			api as unknown as AlphaCodeAPI,
			workspace,
			"scripted",
			new WorkflowRequestBudget(10),
			5_000,
		)
		try {
			if (ask === "command") await host.waitForCommandApproval(task.taskId)
			else
				await assert.rejects(host.waitForCommandApproval(task.taskId), (error: unknown) => {
					assert.ok(error instanceof WorkflowFailure)
					assert.equal(error.code, "expected_pending_command")
					return true
				})
		} finally {
			await host.dispose()
		}
	}
})

function approvalWorkflowFixture(updateResult?: (update: TaskApprovalModeUpdate) => TaskApprovalModeUpdateResult) {
	const taskId = "approval-workflow-task"
	const pending = {
		taskId,
		taskAsk: { ts: 1, type: "ask", ask: "command", text: WORKFLOW_COMMANDS.test } as AlphaMessage | undefined,
		apiConversationHistory: history(WORKFLOW_COMMANDS.test),
		clineMessages: [] as AlphaMessage[],
		didComplete: false,
		approveAsk: () => assert.fail("the cancellation hold must never approve its command"),
	}
	const resumed = {
		...pending,
		taskAsk: { ts: 2, type: "ask", ask: "resume_task" } as AlphaMessage | undefined,
	}
	let current = pending
	let taskApprovalMode: ApprovalMode = "auto"
	const configurations: AlphaCodeSettings[] = []
	const starts: AlphaCodeSettings[] = []
	const updates: TaskApprovalModeUpdate[] = []
	const guidance: string[] = []
	const actions: string[] = []
	let cancellations = 0
	const snapshot = (configuration: AlphaCodeSettings): AlphaCodeSettings => ({
		...configuration,
		deniedCommands: [...(configuration.deniedCommands ?? [])],
		disabledTools: [...(configuration.disabledTools ?? [])],
	})
	const provider = Object.assign(new EventEmitter(), {
		viewLaunched: true,
		getLiveTask: (id: string) => (id === taskId ? current : undefined),
		getStateToPostToWebview: async () => ({ currentTaskId: taskId }),
		createTaskWithHistoryItem: async () => assert.fail("cancel already rehydrated the saved task"),
		updateTaskApprovalMode: (update: TaskApprovalModeUpdate): TaskApprovalModeUpdateResult => {
			assert.equal(current, resumed)
			assert.equal(current.taskAsk?.ask, "resume_task")
			updates.push({ ...update })
			actions.push("task-policy")
			const result: TaskApprovalModeUpdateResult = updateResult?.(update) ?? { ...update, status: "applied" }
			if (
				result.status === "applied" &&
				result.requestId === update.requestId &&
				result.taskId === taskId &&
				result.approvalMode === update.approvalMode
			)
				taskApprovalMode = update.approvalMode
			return result
		},
	})
	const api = Object.assign(new EventEmitter(), {
		sidebarProvider: provider,
		getConfiguration: () => ({}),
		setConfiguration: async (configuration: AlphaCodeSettings) => {
			configurations.push(snapshot(configuration))
			actions.push(`configuration:${configuration.approvalMode}`)
		},
		startNewTask: async ({ configuration }: { configuration: AlphaCodeSettings }) => {
			starts.push(snapshot(configuration))
			taskApprovalMode = configuration.approvalMode ?? "auto"
			return taskId
		},
		isReady: () => true,
		isTaskInHistory: async () => true,
		getCurrentTaskStack: () => [taskId],
		resumeTask: async () => assert.fail("retain the already rehydrated task"),
		cancelCurrentTask: async () => {
			cancellations++
			actions.push("cancel")
			current = resumed
		},
		sendMessage: async (text: string) => {
			assert.equal(current, resumed)
			guidance.push(text)
			actions.push("guidance")
			current.taskAsk = undefined
			const message: AlphaMessage = { ts: 3, type: "say", say: "user_feedback", text }
			current.clineMessages.push(message)
			api.emit(AlphaCodeEventName.Message, { taskId, action: "created", message })
		},
	})
	const host = new ExtensionWorkflowHost(
		api as unknown as AlphaCodeAPI,
		workspace,
		"scripted",
		new WorkflowRequestBudget(10),
		5_000,
	)
	return {
		host,
		api,
		provider,
		taskId,
		pending,
		resumed,
		configurations,
		starts,
		updates,
		guidance,
		actions,
		get taskApprovalMode() {
			return taskApprovalMode
		},
		get cancellations() {
			return cancellations
		},
		async dispose() {
			pending.didComplete = true
			resumed.didComplete = true
			await host.dispose()
		},
	}
}

test("cancellation hold captures Ask and restores Auto on the rehydrated task before guidance", async () => {
	const fixture = approvalWorkflowFixture()
	try {
		assert.equal(await fixture.host.start("hold"), fixture.taskId)
		assert.equal(fixture.configurations[0]?.approvalMode, "ask")
		assert.equal(fixture.starts[0]?.approvalMode, "ask")
		assert.equal(fixture.taskApprovalMode, "ask")
		await fixture.host.waitForCommandApproval(fixture.taskId)
		assert.equal(fixture.pending.taskAsk?.ask, "command")
		await fixture.host.cancel(fixture.taskId)
		assert.equal(fixture.cancellations, 1)
		assert.equal(fixture.taskApprovalMode, "ask", "changing profile defaults cannot restore saved task policy")
		await fixture.host.resume(fixture.taskId, "enhance")
		assert.equal(fixture.provider.getLiveTask(fixture.taskId), fixture.resumed)
		assert.equal(fixture.configurations[1]?.approvalMode, "auto")
		assert.equal(fixture.taskApprovalMode, "auto")
		assert.equal(fixture.updates.length, 1)
		assert.equal(fixture.updates[0]?.taskId, fixture.taskId)
		assert.equal(fixture.updates[0]?.approvalMode, "auto")
		assert.ok(fixture.updates[0]?.requestId)
		assert.deepEqual(fixture.actions, [
			"configuration:ask",
			"cancel",
			"configuration:auto",
			"task-policy",
			"guidance",
		])
		assert.equal(fixture.guidance.length, 1)
		assert.equal(fixture.host.admissionsAreUnique(fixture.taskId), true)
		const before = fixture.starts[0]
		const after = fixture.configurations[1]
		assert.ok(before && after)
		assert.deepEqual(after.deniedCommands, before.deniedCommands)
		assert.ok(after.deniedCommands?.includes("git push"))
		assert.deepEqual(after.disabledTools, WORKFLOW_DISABLED_TOOLS)
		assert.equal(after.alwaysAllowWriteOutsideWorkspace, false)
		assert.equal(after.alwaysAllowWriteProtected, false)
		assert.equal(after.mcpEnabled, false)
		assert.equal(after.alwaysAllowSubagents, false)
		assert.equal(fixture.api.listenerCount(AlphaCodeEventName.Message), 0)
	} finally {
		await fixture.dispose()
	}
})

test("cancellation resume rejects failed or mismatched task policy receipts before guidance", async () => {
	const results: Array<(update: TaskApprovalModeUpdate) => TaskApprovalModeUpdateResult> = [
		({ requestId, taskId }) => ({ requestId, taskId, status: "targetUnavailable" }),
		({ requestId, taskId }) => ({ requestId, taskId, status: "rejected", error: "notMutable" }),
		(update) => ({ ...update, status: "applied", requestId: "another-request" }),
		(update) => ({ ...update, status: "applied", taskId: "another-task" }),
		(update) => ({ ...update, status: "applied", approvalMode: "ask" }),
	]
	for (const result of results) {
		const fixture = approvalWorkflowFixture(result)
		try {
			await fixture.host.start("hold")
			await fixture.host.cancel(fixture.taskId)
			await assert.rejects(
				fixture.host.resume(fixture.taskId, "enhance"),
				(error: unknown) =>
					error instanceof WorkflowFailure &&
					error.category === "policy" &&
					error.code === "task_approval_mode_update_failed",
			)
			assert.equal(fixture.updates.length, 1)
			assert.equal(fixture.guidance.length, 0)
			assert.equal(fixture.provider.getLiveTask(fixture.taskId), fixture.resumed)
			assert.equal(fixture.resumed.taskAsk?.ask, "resume_task")
			assert.equal(fixture.taskApprovalMode, "ask")
			assert.equal(fixture.api.listenerCount(AlphaCodeEventName.Message), 0)
		} finally {
			await fixture.dispose()
		}
	}
})

test("ordinary workflow Auto start and resume do not request a task policy change", async () => {
	const fixture = approvalWorkflowFixture(() => assert.fail("ordinary Auto policy must stay unchanged"))
	try {
		await fixture.host.start("review")
		assert.equal(fixture.starts[0]?.approvalMode, "auto")
		await fixture.host.cancel(fixture.taskId)
		await fixture.host.resume(fixture.taskId, "enhance")
		assert.equal(fixture.taskApprovalMode, "auto")
		assert.equal(fixture.configurations[1]?.approvalMode, "auto")
		assert.equal(fixture.updates.length, 0)
		assert.equal(fixture.guidance.length, 1)
		assert.equal(fixture.host.admissionsAreUnique(fixture.taskId), true)
	} finally {
		await fixture.dispose()
	}
})

test("scenario policy excludes unrelated external and delegation tools", () => {
	for (const name of ["use_mcp_tool", "generate_image", "spawn_agent", "new_task", "custom_tool"] as const) {
		assert.ok(WORKFLOW_DISABLED_TOOLS.includes(name))
	}
	assert.equal(WORKFLOW_DISABLED_TOOLS.includes("write_to_file"), false)
	assert.equal(WORKFLOW_DISABLED_TOOLS.includes("shell"), false)
	assert.equal(WORKFLOW_DISABLED_TOOLS.includes("manage_command"), false)
	assert.equal(WORKFLOW_DISABLED_TOOLS.includes("execute_command"), false)
	assert.equal(WORKFLOW_DISABLED_TOOLS.includes("read_command_output"), false)
})

test("command approval requires exact allowlisted text and matching structured workspace scope", () => {
	assert.equal(isApprovedWorkflowCommand(WORKFLOW_COMMANDS.test, history(WORKFLOW_COMMANDS.test), workspace), true)
	assert.equal(
		isApprovedWorkflowCommand(
			WORKFLOW_COMMANDS.test,
			history(WORKFLOW_COMMANDS.test, workspace, "shell"),
			workspace,
		),
		true,
	)
	for (const command of [
		"git push",
		"gh pr list",
		"gh pr create --title test --body test",
		"gh api repos/owner/repo/issues",
		`${WORKFLOW_COMMANDS.test}; git push`,
		`echo hi && ${WORKFLOW_COMMANDS.test}`,
		"node --test",
	]) {
		assert.equal(isApprovedWorkflowCommand(command, history(command), workspace), false)
	}
	assert.equal(
		isApprovedWorkflowCommand(WORKFLOW_COMMANDS.test, history(WORKFLOW_COMMANDS.test, ".."), workspace),
		false,
	)
	assert.equal(isApprovedWorkflowCommand(WORKFLOW_COMMANDS.test, [], workspace), false)
	assert.equal(isApprovedWorkflowCommand(WORKFLOW_COMMANDS.test, history(WORKFLOW_COMMANDS.status), workspace), false)
	for (const role of ["user", "system", undefined]) {
		const forged = history(WORKFLOW_COMMANDS.test).map((message) => ({ ...message, role }))
		assert.equal(isApprovedWorkflowCommand(WORKFLOW_COMMANDS.test, forged, workspace), false)
		assert.equal(
			isApprovedWorkflowCommand(
				WORKFLOW_COMMANDS.test,
				[...history(WORKFLOW_COMMANDS.test), ...forged],
				workspace,
			),
			false,
		)
	}
})

test("development command approval is phase-scoped and never accepts injected shell or alternate cwd", () => {
	const inspection = workflowCommands(DEVELOPMENT_SCENARIOS["dev-git-inspect"].phases[0])
	const bootstrap = workflowCommands(DEVELOPMENT_SCENARIOS["dev-repo-bootstrap"].phases[0])
	const bootstrapOnly = bootstrap.find((command) => !inspection.includes(command))!
	assert.ok(bootstrapOnly)
	assert.equal(isApprovedWorkflowCommand(bootstrapOnly, history(bootstrapOnly), workspace, inspection), false)
	for (const phase of Object.values(DEVELOPMENT_PHASES)) {
		for (const command of phase.commands) {
			assert.equal(isApprovedWorkflowCommand(command, history(command), workspace, phase.commands), true)
			assert.equal(isApprovedWorkflowCommand(command, history(command, ".."), workspace, phase.commands), false)
			assert.equal(
				isApprovedWorkflowCommand(
					`${command}; git push`,
					history(`${command}; git push`),
					workspace,
					phase.commands,
				),
				false,
			)
		}
	}
})

test("approves each scoped call in the latest assistant batch, never a stale or forged call", () => {
	const commands = DEVELOPMENT_PHASES.devInspectReadOnly.commands
	const assistantBatch = {
		role: "assistant",
		content: commands.flatMap((command) => history(command).flatMap((message) => message.content)),
	}
	const batch = [assistantBatch]
	for (const command of commands) {
		assert.equal(isApprovedWorkflowCommand(command, batch, workspace, commands), true)
	}
	assert.equal(
		isApprovedWorkflowCommand(commands[0], [...batch, ...history(commands[1])], workspace, commands),
		false,
	)
	assert.equal(
		isApprovedWorkflowCommand(commands[0], [...batch, { role: "assistant", content: [] }], workspace, commands),
		false,
	)
	assert.equal(
		isApprovedWorkflowCommand(commands[0], [{ ...assistantBatch, role: "user" }], workspace, commands),
		false,
	)
	const conflicting = [
		{
			...assistantBatch,
			content: [...assistantBatch.content, ...history(commands[0], "..").flatMap((message) => message.content)],
		},
	]
	assert.equal(isApprovedWorkflowCommand(commands[0], conflicting, workspace, commands), false)
})

test("workspace comparison follows the host path semantics without accepting siblings", () => {
	const command = WORKFLOW_COMMANDS.test
	const caseVariant = workspace.toUpperCase()
	assert.equal(
		isApprovedWorkflowCommand(command, history(command, caseVariant), workspace),
		process.platform === "win32" || caseVariant === workspace,
	)
	assert.equal(isApprovedWorkflowCommand(command, history(command, `${workspace}-outside`), workspace), false)
	if (process.platform === "win32") {
		assert.equal(
			isApprovedWorkflowCommand(
				command,
				history(command, workspace.replace(/\\/g, "/").toLowerCase()),
				workspace,
			),
			true,
		)
	}
})

async function withEvidenceDirectory(run: (directory: string) => Promise<void>): Promise<void> {
	const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-workflow-evidence-")))
	try {
		await run(directory)
	} finally {
		const canonical = await fs.realpath(directory)
		assert.equal(await fs.realpath(path.dirname(directory)), path.dirname(canonical))
		assert.match(path.basename(canonical), /^alpha-workflow-evidence-/)
		assert.equal((await fs.lstat(directory)).isSymbolicLink(), false)
		await fs.rm(canonical, { recursive: true, force: true })
	}
}

test("evidence reads distinguish missing, malformed and oversized data without leaking contents", async () => {
	await withEvidenceDirectory(async (directory) => {
		const file = path.join(directory, "evidence.json")
		const expectCode = (code: string) => (error: unknown) => error instanceof WorkflowFailure && error.code === code
		await assert.rejects(readBoundedJson(file), expectCode("evidence_unreadable"))
		await fs.writeFile(file, "private-secret:{invalid")
		await assert.rejects(readBoundedJson(file), expectCode("evidence_invalid_json"))
		await fs.writeFile(file, '{"one":1}\n{"two":2}\n')
		assert.deepEqual(await readBoundedJson(file, true), [{ one: 1 }, { two: 2 }])
		await fs.truncate(file, 16 * 1024 * 1024 + 1)
		await assert.rejects(readBoundedJson(file), expectCode("evidence_size_limit"))
	})
})

test("host joins the owned durability boundary and reports a duplicate terminal without polling it away", async () => {
	await withEvidenceDirectory(async (directory) => {
		const taskId = "owned-task"
		const taskDirectory = path.join(directory, "custom-storage", "tasks", taskId)
		await fs.mkdir(taskDirectory, { recursive: true })
		const events = [
			{ taskId, runId: "run-1", turnId: "turn-1", type: "turn_started" },
			{ taskId, runId: "run-1", turnId: "turn-1", type: "turn_status_changed", payload: { status: "completed" } },
			{ taskId, runId: "run-1", turnId: "turn-1", type: "turn_status_changed", payload: { status: "completed" } },
		]
		let joins = 0
		const task = {
			taskId,
			globalStoragePath: directory,
			waitForTermination: async () => {
				joins++
				await fs.writeFile(
					path.join(taskDirectory, "agent_lifecycle_events.jsonl"),
					events.map((event) => JSON.stringify(event)).join("\n"),
				)
			},
			flushApiConversationHistoryPersistence: async () => {
				await fs.writeFile(
					path.join(taskDirectory, "api_conversation_history.json"),
					JSON.stringify(history(WORKFLOW_COMMANDS.test)),
				)
			},
		}
		const provider = Object.assign(new EventEmitter(), {
			getLiveTask: (id: string) => (id === taskId ? task : undefined),
			getTaskWithId: async () => ({ historyItem: {}, taskDirPath: taskDirectory }),
		})
		const api = Object.assign(new EventEmitter(), { sidebarProvider: provider, getConfiguration: () => ({}) })
		const host = new ExtensionWorkflowHost(
			api as unknown as AlphaCodeAPI,
			directory,
			"scripted",
			new WorkflowRequestBudget(10),
			5_000,
		)
		try {
			const evidence = await host.inspect(taskId)
			assert.equal(joins, 1)
			assert.ok(evidence.errors.includes("lifecycle_duplicate_turn_terminal"))
			assert.ok(evidence.errors.includes("missing_tool_result"))
			assert.equal(evidence.completedTurns, 1)
			await assert.rejects(
				host.inspect("another-task"),
				(error: unknown) => error instanceof WorkflowFailure && error.code === "task_identity_lost",
			)
		} finally {
			await host.dispose()
		}
		assert.equal(provider.listenerCount("taskCreated"), 0)
	})
})

test("resume retains its instance and waits for same-task guidance admission after webview dispatch", async () => {
	const taskId = "retained-task"
	const task = {
		taskId,
		taskAsk: { ts: 1, type: "ask", ask: "resume_task" } as AlphaMessage | undefined,
		clineMessages: [] as AlphaMessage[],
		didComplete: true,
	}
	let submissions = 0
	let sentText = ""
	let dispatched!: () => void
	const sent = new Promise<void>((resolve) => {
		dispatched = resolve
	})
	const provider = Object.assign(new EventEmitter(), {
		viewLaunched: true,
		getLiveTask: (id: string) => (id === taskId ? task : undefined),
		getStateToPostToWebview: async () => ({ currentTaskId: taskId }),
		createTaskWithHistoryItem: async () => assert.fail("must not rehydrate twice"),
	})
	const api = Object.assign(new EventEmitter(), {
		sidebarProvider: provider,
		getConfiguration: () => ({}),
		setConfiguration: async () => {},
		isReady: () => true,
		isTaskInHistory: async () => true,
		getCurrentTaskStack: () => [taskId],
		resumeTask: async () => assert.fail("must not reopen the live resumable task"),
		sendMessage: async (text: string) => {
			submissions++
			sentText = text
			dispatched()
		},
	})
	const host = new ExtensionWorkflowHost(
		api as unknown as AlphaCodeAPI,
		workspace,
		"scripted",
		new WorkflowRequestBudget(10),
		5_000,
	)
	let returned = false
	const resuming = host.resume(taskId, "enhance").then(() => {
		returned = true
	})
	const admit = (id = taskId, text = sentText) =>
		api.emit(AlphaCodeEventName.Message, {
			taskId: id,
			action: "created",
			message: { ts: 2, type: "say", say: "user_feedback", text },
		})
	try {
		await sent
		// Yield one event-loop turn, not a timing sleep: dispatch is complete but
		// the controlled webview->Task admission has deliberately not happened.
		await new Promise<void>((resolve) => setImmediate(resolve))
		assert.equal(returned, false, "posting to the webview must not complete resume admission")
		admit("other-task")
		admit(taskId, "unrelated guidance")
		await new Promise<void>((resolve) => setImmediate(resolve))
		assert.equal(returned, false, "unrelated feedback cannot satisfy this task's admission")
		task.taskAsk = undefined
		admit()
		await resuming
		assert.equal(submissions, 1)
		assert.equal(host.admissionsAreUnique(taskId), false, "an event alone does not prove persisted admission")
		task.clineMessages.push({ ts: 2, type: "say", say: "user_feedback", text: sentText })
		assert.equal(host.admissionsAreUnique(taskId), true)
		task.clineMessages.push({ ts: 3, type: "say", say: "user_feedback", text: sentText })
		assert.equal(host.admissionsAreUnique(taskId), false, "duplicate admissions must fail acceptance")
		assert.equal(provider.getLiveTask(taskId), task)
		assert.equal(api.listenerCount(AlphaCodeEventName.Message), 0)
	} finally {
		task.taskAsk = undefined
		admit()
		await resuming.catch(() => undefined)
		await host.dispose()
	}
})

test("reload applies scenario policy before saved-task construction and reports a new read approval", async () => {
	const taskId = "reload-task"
	const task = {
		taskId,
		taskAsk: { ts: 1, type: "ask", ask: "resume_completed_task" } as AlphaMessage,
		clineMessages: [] as AlphaMessage[],
		didComplete: true,
	}
	let live = false
	let configured = false
	const provider = Object.assign(new EventEmitter(), {
		viewLaunched: true,
		getLiveTask: () => (live ? task : undefined),
		getStateToPostToWebview: async () => ({ currentTaskId: taskId }),
		getTaskWithId: async () => ({ historyItem: { id: taskId }, taskDirPath: workspace }),
		createTaskWithHistoryItem: async () => {
			assert.ok(configured, "reload must establish policy before constructing the saved task")
			live = true
		},
	})
	const api = Object.assign(new EventEmitter(), {
		sidebarProvider: provider,
		getConfiguration: () => ({ autoApprovalEnabled: false, enableCheckpoints: true }),
		setConfiguration: async (configuration: AlphaCodeSettings) => {
			assert.equal(configuration.autoApprovalEnabled, true)
			assert.equal(configuration.alwaysAllowReadOnly, true)
			assert.equal(configuration.alwaysAllowWrite, true)
			assert.equal(configuration.alwaysAllowExecute, false)
			assert.equal(configuration.enableCheckpoints, false)
			assert.deepEqual(configuration.disabledTools, WORKFLOW_DISABLED_TOOLS)
			configured = true
		},
		isReady: () => true,
		isTaskInHistory: async () => true,
		getCurrentTaskStack: () => [taskId],
		sendMessage: async () => {
			// A genuinely new ask is not the old resume boundary in transit.
			task.taskAsk = {
				ts: 2,
				type: "ask",
				ask: "tool",
				text: JSON.stringify({ tool: "readFile", content: "private" }),
			}
		},
	})
	const host = new ExtensionWorkflowHost(
		api as unknown as AlphaCodeAPI,
		workspace,
		"scripted",
		new WorkflowRequestBudget(10),
		5_000,
	)
	try {
		await assert.rejects(host.resume(taskId, "enhance"), (error: unknown) => {
			assert.ok(error instanceof WorkflowFailure)
			assert.equal(error.category, "policy")
			assert.equal(error.code, "unexpected_read_approval")
			assert.equal(error.message.includes("private"), false)
			return true
		})
		assert.equal(api.listenerCount(AlphaCodeEventName.Message), 0)
	} finally {
		await host.dispose()
	}
})

test("problem solving denies an outside read and continues to completion", async () => {
	let phase: "outside" | "completion" = "outside"
	const denied: string[] = []
	const task = {
		taskId: "problem-task",
		didComplete: false,
		apiConversationHistory: [],
		clineMessages: [],
		get taskAsk(): AlphaMessage {
			return phase === "outside"
				? {
						ts: 1,
						type: "ask",
						ask: "tool",
						text: JSON.stringify({
							tool: "readFile",
							path: "F:/elsewhere/notes.md",
							isOutsideWorkspace: true,
						}),
					}
				: { ts: 2, type: "ask", ask: "completion_result" }
		},
		denyAsk(response?: { text?: string }) {
			denied.push(response?.text ?? "")
			phase = "completion"
		},
		approveAsk() {
			assert.equal(phase, "completion")
			task.didComplete = true
			api.emit(AlphaCodeEventName.TaskCompleted, task.taskId)
		},
	}
	const provider = Object.assign(new EventEmitter(), {
		getLiveTask: (id: string) => (id === task.taskId ? task : undefined),
	})
	const api = Object.assign(new EventEmitter(), {
		sidebarProvider: provider,
		getConfiguration: () => ({}),
		setConfiguration: async () => {},
		startNewTask: async () => task.taskId,
		cancelCurrentTask: async () => {},
	})
	const host = new ExtensionWorkflowHost(
		api as unknown as AlphaCodeAPI,
		workspace,
		"scripted",
		new WorkflowRequestBudget(10),
		5_000,
	)
	try {
		assert.equal(await host.startProblem("Repair the cache invalidation."), task.taskId)
		await host.complete(task.taskId)
		assert.deepEqual(denied, ["Outside the task workspace."])
	} finally {
		await host.dispose()
	}
})

test("problem solving approves workspace commands and rejects deny-list, escape, and outside tools", () => {
	const history = [
		{
			role: "assistant",
			content: [{ type: "tool_use", name: "execute_command", input: { command: "npm test", cwd: workspace } }],
		},
	]
	for (const command of [
		"npm test",
		"pnpm test",
		"pytest",
		"node --test test/behavior.test.js",
		"git status --short",
	]) {
		assert.equal(isApprovedProblemCommand(command, history, workspace), true, command)
	}
	for (const command of [
		"npm install",
		"pnpm install left",
		"git push origin main",
		"npm test && curl example",
		"node ../outside.js",
	]) {
		assert.equal(isApprovedProblemCommand(command, [], workspace), false, command)
	}
	assert.equal(
		isApprovedProblemCommand(
			"npm test",
			[
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							name: "execute_command",
							input: { command: "npm test", cwd: path.resolve(workspace, "..") },
						},
					],
				},
			],
			workspace,
		),
		false,
	)
	assert.equal(
		isApprovedProblemToolAsk(JSON.stringify({ tool: "readFile", path: "src/cache.js", isOutsideWorkspace: false })),
		true,
	)
	assert.equal(
		isApprovedProblemToolAsk(
			JSON.stringify({ tool: "readFile", path: "src/assets/skills/debug/SKILL.md", isOutsideWorkspace: true }),
		),
		false,
	)
	assert.equal(
		isOutsideWorkspaceProblemToolAsk(
			JSON.stringify({ tool: "readFile", path: "notes/other.md", isOutsideWorkspace: true }),
		),
		true,
	)
	assert.equal(
		isOutsideWorkspaceProblemToolAsk(
			JSON.stringify({ tool: "appliedDiff", path: "notes/other.md", isOutsideWorkspace: true }),
		),
		true,
	)
	assert.equal(
		isOutsideWorkspaceProblemToolAsk(
			JSON.stringify({ tool: "browser", path: "notes/other.md", isOutsideWorkspace: true }),
		),
		false,
	)
	assert.equal(isApprovedProblemToolAsk(JSON.stringify({ tool: "readFile", path: "src/cache.js" })), false)
	assert.deepEqual(usageFromHistoryItem({ tokensIn: 28000, tokensOut: 1200, totalCost: 0 }), {
		inputTokens: 28000,
		outputTokens: 1200,
		cost: 0,
	})
})

test("problem command rejection reasons are content-free and preserve the approval boundary", () => {
	assert.equal(problemCommandRejectionReason("  ", [], workspace), "empty_command")
	assert.equal(problemCommandRejectionReason("npm test && curl example", [], workspace), "shell_operator")
	// This test gate uses a deliberately conservative text rule: metacharacters are denied even when quoted.
	assert.equal(problemCommandRejectionReason('node --test "test/name;value.cjs"', [], workspace), "shell_operator")
	assert.equal(problemCommandRejectionReason("npm install package", [], workspace), "denied_prefix")
	assert.equal(problemCommandRejectionReason("node ../outside.js", [], workspace), "outside_workspace_argument")
	assert.equal(
		problemCommandRejectionReason("npm test", history("npm test", path.resolve(workspace, "..")), workspace),
		"outside_workspace_cwd",
	)
	assert.equal(problemCommandRejectionReason("npm test", history("npm test"), workspace), null)
})

test("E2E approval identity hashes effective settings without binding to workspace paths", async () => {
	const createHost = (workspacePath: string, requestLimit: number) => {
		let effectiveConfiguration: AlphaCodeSettings | undefined
		const provider = Object.assign(new EventEmitter(), { getLiveTask: () => undefined })
		const api = Object.assign(new EventEmitter(), {
			sidebarProvider: provider,
			getConfiguration: () => ({}),
			setConfiguration: async (configuration: AlphaCodeSettings) => {
				effectiveConfiguration = configuration
			},
			startNewTask: async () => "policy-identity-task",
			cancelCurrentTask: async () => {},
		})
		const host = new ExtensionWorkflowHost(
			api as unknown as AlphaCodeAPI,
			workspacePath,
			"live-copilot",
			new WorkflowRequestBudget(requestLimit),
			900_000,
		)
		return { host, getConfiguration: () => effectiveConfiguration }
	}
	const first = createHost(path.join(workspace, "first"), 40)
	const samePolicy = createHost(path.join(workspace, "second"), 40)
	const differentRequestLimit = createHost(path.join(workspace, "third"), 41)
	try {
		assert.equal(
			first.host.e2eApprovalPolicySha256(),
			null,
			"identity is absent before the problem-solving policy applies",
		)
		await Promise.all([
			first.host.startProblem("Run the workspace task."),
			samePolicy.host.startProblem("Run the workspace task."),
			differentRequestLimit.host.startProblem("Run the workspace task."),
		])
		const firstDigest = first.host.e2eApprovalPolicySha256()
		assert.match(firstDigest ?? "", /^[a-f0-9]{64}$/)
		assert.equal(samePolicy.host.e2eApprovalPolicySha256(), firstDigest)
		assert.notEqual(differentRequestLimit.host.e2eApprovalPolicySha256(), firstDigest)
		assert.equal(first.getConfiguration()?.alwaysAllowExecute, true)
		assert.deepEqual(first.getConfiguration()?.allowedCommands, [])
		assert.equal(first.getConfiguration()?.alwaysAllowWriteOutsideWorkspace, false)
	} finally {
		await Promise.all([first.host.dispose(), samePolicy.host.dispose(), differentRequestLimit.host.dispose()])
	}
})
