import { strict as assert } from "node:assert"
import { test } from "node:test"
import { EventEmitter } from "node:events"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { RooCodeEventName, type ClineMessage, type RooCodeAPI, type RooCodeSettings } from "@alpha-code/types"

import {
	ExtensionWorkflowHost,
	isApprovedWorkflowCommand,
	readBoundedJson,
	WORKFLOW_DISABLED_TOOLS,
} from "./extensionWorkflowHost"
import { WORKFLOW_COMMANDS, workflowCommands } from "./prompts"
import { DEVELOPMENT_PHASES, DEVELOPMENT_SCENARIOS } from "./developmentCatalog"
import { WorkflowRequestBudget } from "./requestBudget"
import { WorkflowFailure } from "./contracts"

const workspace = process.cwd()
const history = (command: string, cwd: unknown = workspace) => [
	{
		role: "assistant",
		content: [{ type: "tool_use", id: "command-1", name: "execute_command", input: { command, cwd } }],
	},
]

test("blocked acceptance observes a resume boundary without approving it or accepting completed work", async () => {
	for (const boundary of ["resume_task", "completion_result", "api_req_failed"] as const) {
		const task = {
			taskId: "blocked-task",
			taskAsk: { ts: 1, type: "ask", ask: boundary } as ClineMessage,
			didComplete: false,
			approveAsk: () => assert.fail("blocked acceptance must not approve a boundary"),
		}
		const provider = Object.assign(new EventEmitter(), { getLiveTask: () => task })
		const api = Object.assign(new EventEmitter(), { sidebarProvider: provider, getConfiguration: () => ({}) })
		const host = new ExtensionWorkflowHost(
			api as unknown as RooCodeAPI,
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
			taskAsk: { ts: 1, type: "ask", ask, text: WORKFLOW_COMMANDS.test } as ClineMessage,
			apiConversationHistory: history(WORKFLOW_COMMANDS.test),
			approveAsk: () => assert.fail("cancellation must not approve the pending command"),
		}
		const provider = Object.assign(new EventEmitter(), { getLiveTask: () => task })
		const api = Object.assign(new EventEmitter(), {
			sidebarProvider: provider,
			getConfiguration: () => ({}),
		})
		const host = new ExtensionWorkflowHost(
			api as unknown as RooCodeAPI,
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

test("scenario policy excludes unrelated external and delegation tools", () => {
	for (const name of [
		"github_api",
		"use_mcp_tool",
		"generate_image",
		"spawn_agent",
		"new_task",
		"custom_tool",
	] as const) {
		assert.ok(WORKFLOW_DISABLED_TOOLS.includes(name))
	}
	assert.equal(WORKFLOW_DISABLED_TOOLS.includes("write_to_file"), false)
	assert.equal(WORKFLOW_DISABLED_TOOLS.includes("execute_command"), false)
})

test("command approval requires exact allowlisted text and matching structured workspace scope", () => {
	assert.equal(isApprovedWorkflowCommand(WORKFLOW_COMMANDS.test, history(WORKFLOW_COMMANDS.test), workspace), true)
	for (const command of [
		"git push",
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
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-workflow-evidence-"))
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
			api as unknown as RooCodeAPI,
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
		taskAsk: { ts: 1, type: "ask", ask: "resume_task" } as ClineMessage | undefined,
		clineMessages: [] as ClineMessage[],
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
		api as unknown as RooCodeAPI,
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
		api.emit(RooCodeEventName.Message, {
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
		assert.equal(provider.getLiveTask(taskId), task)
		assert.equal(api.listenerCount(RooCodeEventName.Message), 0)
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
		taskAsk: { ts: 1, type: "ask", ask: "resume_completed_task" } as ClineMessage,
		clineMessages: [] as ClineMessage[],
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
		setConfiguration: async (configuration: RooCodeSettings) => {
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
		api as unknown as RooCodeAPI,
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
		assert.equal(api.listenerCount(RooCodeEventName.Message), 0)
	} finally {
		await host.dispose()
	}
})
