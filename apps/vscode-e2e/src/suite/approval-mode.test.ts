import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import * as vscode from "vscode"
import { alphaMessageSchema, type AlphaMessage } from "@alpha-code/types"
import { createCompletionReviewAcknowledger, withBoundedFixtureCleanup } from "./proportional-context-support"
import { waitFor } from "./utils"

interface ApprovalTask {
	taskId: string
	didComplete: boolean
	abort: boolean
	taskAsk?: AlphaMessage
	clineMessages: AlphaMessage[]
	approveAsk(): void
	denyAsk(): void
	handleWebviewAskResponse(response: "messageResponse", text: string): void
	waitForTermination(): Promise<void>
	getCommandExecutionEvidence(): Array<{ toolCallId: string; status: string; command: string; exitCode?: number }>
}

interface ApprovalModeHostProvider {
	getLiveTask(taskId: string): ApprovalTask | undefined
	updateTaskApprovalMode(update: { requestId: string; taskId: string; approvalMode: "ask" | "auto" | "bypass" }): {
		status: "applied" | "targetUnavailable" | "rejected"
		approvalMode?: string
	}
}

interface Observation {
	task?: ApprovalTask
	requests: number
	calls: Array<{ name: string; arguments: Record<string, unknown> }>
	modelInputs: unknown[][]
}

const observations = new WeakMap<object, Observation>()

function findRequestUserInputAnswerMap(value: unknown): Record<string, unknown> | undefined {
	if (typeof value === "string") {
		try {
			return findRequestUserInputAnswerMap(JSON.parse(value))
		} catch {
			return undefined
		}
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			const result = findRequestUserInputAnswerMap(item)
			if (result) return result
		}
		return undefined
	}
	if (!value || typeof value !== "object") return undefined

	const record = value as Record<string, unknown>
	const answers = record.answers
	if (
		answers &&
		typeof answers === "object" &&
		!Array.isArray(answers) &&
		"approach" in answers &&
		"validation" in answers
	) {
		return answers as Record<string, unknown>
	}
	for (const item of Object.values(record)) {
		const result = findRequestUserInputAnswerMap(item)
		if (result) return result
	}
	return undefined
}

class ApprovalModeAI {
	readonly id = "approval-mode-host"
	removeFromCache?: () => void
	private rootTaskId?: string
	constructor(
		observation: Observation,
		private readonly resolveTask: (id: string) => ApprovalTask,
	) {
		observations.set(this, observation)
	}
	async *createMessage(_system: string, messages: unknown[], metadata?: { taskId?: string }) {
		assert.ok(metadata?.taskId)
		this.rootTaskId ??= metadata.taskId
		if (metadata.taskId !== this.rootTaskId) {
			yield { type: "text" as const, text: "Child inspection complete." }
			return
		}
		const observation = observations.get(this)!
		observation.modelInputs.push(messages)
		observation.task = this.resolveTask(metadata.taskId)
		const index = observation.requests++
		if (index < observation.calls.length) {
			const call = observation.calls[index]!
			yield {
				type: "tool_call" as const,
				id: `approval-mode-${index}`,
				name: call.name,
				arguments: JSON.stringify(call.arguments),
			}
			return
		}
		assert.equal(index, observation.calls.length, "No unexpected model retries")
		yield { type: "text" as const, text: "Approval mode verified." }
	}
	getModel() {
		return { id: this.id, info: { contextWindow: 128_000, maxTokens: 8192, supportsPromptCache: false } }
	}
	async countTokens() {
		return 1
	}
	async completePrompt() {
		return ""
	}
}

async function runScriptedApproval(options: {
	approvalMode: "ask" | "auto" | "bypass"
	mode?: "code" | "architect"
	requestText?: string
	calls: Observation["calls"]
	onAsk?: (task: ApprovalTask, ask: AlphaMessage, provider: ApprovalModeHostProvider) => void
}): Promise<{
	asks: string[]
	workspace: string
	outside: string
	commandEvidence: ReturnType<ApprovalTask["getCommandExecutionEvidence"]>
	modelInputs: unknown[][]
	messages: AlphaMessage[]
}> {
	assert.equal(vscode.version, "1.125.0")
	const workspace = process.env.ALPHA_E2E_WORKSPACE
	const artifacts = process.env.ALPHA_E2E_ARTIFACTS_DIR
	assert.ok(workspace && artifacts)
	const outside = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-approval-mode-"))
	const configuration = globalThis.api.getConfiguration()
	const provider = (
		globalThis.api as unknown as {
			sidebarProvider: ApprovalModeHostProvider
		}
	).sidebarProvider
	const observation: Observation = { requests: 0, calls: options.calls, modelInputs: [] }
	const scripted = new ApprovalModeAI(observation, (id) => {
		const task = provider.getLiveTask(id)
		assert.ok(task)
		return task
	})
	const acknowledgeCompletion = createCompletionReviewAcknowledger()
	const handled = new Set<number>()
	const asks: string[] = []
	let commandEvidence: ReturnType<ApprovalTask["getCommandExecutionEvidence"]> = []
	let messages: AlphaMessage[] = []
	await withBoundedFixtureCleanup(async () => {
		await globalThis.api.startNewTask({
			text: options.requestText ?? "Exercise the session approval dial.",
			configuration: {
				...configuration,
				apiProvider: "fake-ai",
				fakeAi: scripted,
				mode: options.mode ?? "code",
				approvalMode: options.approvalMode,
				subagentDelegationPolicy: "explicit-only",
				deniedCommands: ["rm"],
				terminalShellIntegrationDisabled: true,
				enableCheckpoints: false,
				requestDelaySeconds: 0,
				writeDelayMs: 0,
			},
		})
		await waitFor(
			async () => {
				const task = observation.task
				const error = task?.clineMessages.find((message) => message.say === "error")
				assert.equal(error, undefined, error?.text)
				const ask = task?.taskAsk
				if (ask && !ask.partial && !handled.has(ask.ts)) {
					handled.add(ask.ts)
					asks.push(ask.ask ?? "")
					options.onAsk?.(task!, ask, provider)
				}
				acknowledgeCompletion(task)
				return task?.didComplete === true
			},
			{ description: `${options.approvalMode} approval-mode host`, timeout: 150_000 },
		)
		await observation.task!.waitForTermination()
		commandEvidence = observation.task!.getCommandExecutionEvidence()
		messages = [...observation.task!.clineMessages]
	}, [
		() => globalThis.api.clearCurrentTask(),
		() => scripted.removeFromCache?.(),
		() => globalThis.api.setConfiguration(configuration),
		() => fs.rm(outside, { recursive: true, force: true }),
	])
	return { asks, workspace, outside, commandEvidence, modelInputs: observation.modelInputs, messages }
}

suite("Ask / Auto / Full Access in the extension host", function () {
	this.timeout(180_000)

	for (const approvalMode of ["ask", "auto", "bypass"] as const) {
		for (const viaCommand of [false, true]) {
			test(`${approvalMode} saves a tiny patch to a large file after a skill request (command: ${viaCommand})`, async () => {
				const workspace = process.env.ALPHA_E2E_WORKSPACE
				assert.ok(workspace)
				const relativeFile = `src/approval-large-${approvalMode}-${Date.now()}.txt`
				const target = path.join(workspace, relativeFile)
				const original = "before\n" + "unchanged context\n".repeat(4_000)
				const final = original.replace("before", "after")
				const patch = `*** Begin Patch\n*** Update File: ${relativeFile}\n@@\n-before\n+after\n*** End Patch`
				assert.ok(patch.length < 200)
				await fs.mkdir(path.dirname(target), { recursive: true })
				await fs.writeFile(target, original)
				try {
					const { asks, messages } = await runScriptedApproval({
						approvalMode,
						requestText: "Use the api-export skill to retrieve the export and save the document.",
						calls: [
							viaCommand
								? { name: "exec_command", arguments: { cmd: `apply_patch <<'PATCH'\n${patch}\nPATCH` } }
								: { name: "apply_patch", arguments: { patch } },
						],
						onAsk: (task, ask) => {
							if (ask.ask === "tool") task.approveAsk()
						},
					})
					assert.equal((await fs.readFile(target, "utf8")).replaceAll("\r\n", "\n"), final)
					assert.deepEqual(
						asks.filter((ask) => ask !== "completion_result"),
						approvalMode === "ask" ? ["tool"] : [],
					)
					const message = messages.find(
						(item) => item.ask === "tool" && !item.partial && item.text?.includes(relativeFile),
					)
					assert.ok(message?.text)
					assert.ok(message.text.length > 100_000)
					assert.ok((message.toolApprovalRequest?.description?.length ?? Infinity) < 100_000)
					assert.ok(alphaMessageSchema.safeParse(message).success)
					const details = JSON.parse(message.text)
					assert.equal(details.originalContent, original)
					assert.equal(details.finalContent, final)
				} finally {
					await fs.rm(target, { force: true })
				}
			})
		}
	}

	test("Auto writes inside the opened workspace without asking", async () => {
		const relativeFile = `src/approval-inside-${Date.now()}.txt`
		const { asks, workspace, messages } = await runScriptedApproval({
			approvalMode: "auto",
			calls: [
				{
					name: "apply_patch",
					arguments: { patch: `*** Begin Patch\n*** Add File: ${relativeFile}\n+inside\n*** End Patch` },
				},
			],
		})
		assert.deepEqual(
			asks.filter((ask) => ask !== "completion_result"),
			[],
		)
		assert.equal(
			(await fs.readFile(path.join(workspace, relativeFile), "utf8")).replaceAll("\r\n", "\n"),
			"inside\n",
		)
		const patchMessage = messages.find(
			(message) =>
				message.type === "ask" &&
				message.ask === "tool" &&
				!message.partial &&
				message.text?.includes(relativeFile),
		)
		assert.ok(patchMessage?.text, "apply_patch must project a file-change message")
		assert.equal(patchMessage.isAnswered, true)
		const patchPayload = JSON.parse(patchMessage.text) as {
			tool: string
			diffStats?: { added: number; removed: number }
		}
		assert.equal(patchPayload.tool, "newFileCreated")
		assert.deepEqual(patchPayload.diffStats, { added: 1, removed: 0 })
	})

	test("Auto routes a standalone apply_patch heredoc through the patch tool", async () => {
		const relativeFile = `src/approval-intercepted-${Date.now()}.txt`
		const patch = `*** Begin Patch\n*** Add File: ${relativeFile}\n+intercepted\n*** End Patch`
		const { asks, workspace, commandEvidence } = await runScriptedApproval({
			approvalMode: "auto",
			calls: [{ name: "exec_command", arguments: { cmd: `apply_patch <<'PATCH'\n${patch}\nPATCH` } }],
		})

		assert.deepEqual(
			asks.filter((ask) => ask !== "completion_result"),
			[],
		)
		assert.equal(
			(await fs.readFile(path.join(workspace, relativeFile), "utf8")).replaceAll("\r\n", "\n"),
			"intercepted\n",
		)
		assert.equal(
			commandEvidence.some((evidence) => evidence.toolCallId === "approval-mode-0"),
			false,
		)
	})

	test("Auto runs a workspace Git command without a saved prefix", async () => {
		const { asks, commandEvidence } = await runScriptedApproval({
			approvalMode: "auto",
			calls: [{ name: "exec_command", arguments: { cmd: "git --version" } }],
		})
		assert.equal(asks.includes("command"), false)
		assert.ok(
			commandEvidence.some(
				(evidence) =>
					evidence.toolCallId === "approval-mode-0" &&
					evidence.status === "succeeded" &&
					evidence.exitCode === 0,
			),
			`the command must run without review: ${JSON.stringify({ asks, commandEvidence })}`,
		)
	})

	test("Auto still asks for a true-outside write", async () => {
		let rejected = false
		const outsideFile = path.join(os.tmpdir(), `alpha-approval-outside-${Date.now()}.txt`)
		const { asks } = await runScriptedApproval({
			approvalMode: "auto",
			calls: [
				{
					name: "apply_patch",
					arguments: {
						patch: `*** Begin Patch\n*** Add File: ${outsideFile.replace(/\\/g, "/")}\n+outside\n*** End Patch`,
					},
				},
			],
			onAsk: (task, ask) => {
				if (ask.ask === "tool") {
					rejected = true
					task.denyAsk()
				}
			},
		})
		assert.equal(rejected, true)
		assert.ok(asks.includes("tool"))
		await assert.rejects(fs.access(outsideFile))
	})

	test("Full Access auto-approves an outside write while the deny-list still denies", async () => {
		const outsideFile = path.join(os.tmpdir(), `alpha-approval-bypass-${Date.now()}.txt`)
		const { asks, commandEvidence } = await runScriptedApproval({
			approvalMode: "bypass",
			calls: [
				{
					name: "apply_patch",
					arguments: {
						patch: `*** Begin Patch\n*** Add File: ${outsideFile.replace(/\\/g, "/")}\n+bypass\n*** End Patch`,
					},
				},
				{ name: "exec_command", arguments: { cmd: "rm --help" } },
			],
			onAsk: (task, ask) => {
				if (ask.ask === "command") task.denyAsk()
			},
		})
		assert.equal((await fs.readFile(outsideFile, "utf8")).replaceAll("\r\n", "\n"), "bypass\n")
		assert.ok(!asks.includes("tool"))
		assert.equal(asks.includes("command"), false, "deny-list must auto-deny rm without a human click")
		assert.ok(
			commandEvidence.some(
				(evidence) => evidence.toolCallId === "approval-mode-1" && evidence.status === "denied",
			),
			"the visible exec_command call must reach the command policy and be denied",
		)
		await fs.rm(outsideFile, { force: true })
	})

	test("Ask asks for an in-workspace write", async () => {
		let approved = false
		const relativeFile = `src/approval-ask-${Date.now()}.txt`
		const { asks, workspace } = await runScriptedApproval({
			approvalMode: "ask",
			calls: [
				{
					name: "apply_patch",
					arguments: { patch: `*** Begin Patch\n*** Add File: ${relativeFile}\n+ask\n*** End Patch` },
				},
			],
			onAsk: (task, ask) => {
				if (ask.ask === "tool") {
					approved = true
					task.approveAsk()
				}
			},
		})
		assert.equal(approved, true)
		assert.ok(asks.includes("tool"))
		assert.equal((await fs.readFile(path.join(workspace, relativeFile), "utf8")).replaceAll("\r\n", "\n"), "ask\n")
	})

	test("a task approval change during a pending Ask affects the next step only", async () => {
		const firstFile = "src/approval-pending-ask-" + Date.now() + ".txt"
		const nextFile = "src/approval-next-step-" + Date.now() + ".txt"
		let changedMode = false
		const { asks, workspace } = await runScriptedApproval({
			approvalMode: "ask",
			calls: [
				{
					name: "apply_patch",
					arguments: {
						patch:
							"*** Begin Patch\n*** Add File: " +
							firstFile +
							"\n+approved-under-original-ask\n*** End Patch",
					},
				},
				{
					name: "apply_patch",
					arguments: {
						patch: "*** Begin Patch\n*** Add File: " + nextFile + "\n+auto-next-step\n*** End Patch",
					},
				},
			],
			onAsk: (task, ask, provider) => {
				if (ask.ask !== "tool") return
				if (!changedMode) {
					const result = provider.updateTaskApprovalMode({
						requestId: "pending-ask-to-auto",
						taskId: task.taskId,
						approvalMode: "auto",
					})
					assert.deepEqual(result, {
						requestId: "pending-ask-to-auto",
						taskId: task.taskId,
						status: "applied",
						approvalMode: "auto",
					})
					changedMode = true
					task.approveAsk()
					return
				}
				task.denyAsk()
			},
		})
		assert.equal(changedMode, true)
		assert.equal(asks.filter((ask) => ask === "tool").length, 1)
		assert.equal(
			(await fs.readFile(path.join(workspace, firstFile), "utf8")).replaceAll("\r\n", "\n"),
			"approved-under-original-ask\n",
		)
		assert.equal(
			(await fs.readFile(path.join(workspace, nextFile), "utf8")).replaceAll("\r\n", "\n"),
			"auto-next-step\n",
		)
	})

	for (const approvalMode of ["auto", "bypass"] as const) {
		test(`${approvalMode} authorizes an explicit-only sub-agent without a spawn dialog`, async () => {
			const { asks, messages, modelInputs } = await runScriptedApproval({
				approvalMode,
				calls: [
					{
						name: "spawn_agent",
						arguments: {
							task_name: `approval_explore_${approvalMode}`,
							fork_turns: "none",
							objective: "Inspect the opened workspace only.",
							agent_kind: "explore",
							write_scope: null,
							expected_output: null,
						},
					},
					{ name: "wait_agent", arguments: { timeout_ms: 60_000, until_terminal: true } },
				],
			})
			assert.equal(asks.includes("tool"), false, `${approvalMode} must not open a spawn dialog`)
			const spawnResult = (
				modelInputs[1] as Array<{ content?: Array<{ type?: string; is_error?: boolean }> }> | undefined
			)
				?.flatMap((message) => message.content ?? [])
				.find((block) => block.type === "tool_result")
			assert.ok(spawnResult, "The parent must receive a spawn tool result")
			assert.equal(spawnResult.is_error, false, "The child launch must succeed")
			assert.ok(
				messages.some((message) => message.type === "ask" && message.ask === "tool" && message.isAnswered),
				"The spawn decision must be recorded as resolved",
			)
		})
	}

	for (const mode of ["architect", "code"] as const) {
		test(`${mode} request_user_input asks once for all questions and returns structured answers to the model`, async () => {
			let pendingGroupedRequests = 0
			const { asks, modelInputs } = await runScriptedApproval({
				approvalMode: "auto",
				mode,
				calls: [
					{
						name: "request_user_input",
						arguments: {
							questions: [
								{
									id: "approach",
									header: "Approach",
									question: "Which implementation approach should the plan use?",
									options: [
										{
											label: "Focused (Recommended)",
											description: "Keep the implementation narrow.",
										},
										{ label: "Broad", description: "Cover adjacent behavior too." },
									],
								},
								{
									id: "validation",
									header: "Testing",
									question: "Which validation should the plan include?",
									options: [
										{ label: "Focused tests", description: "Run tests for the changed behavior." },
										{ label: "Full suite", description: "Run the complete test suite." },
									],
								},
							],
						},
					},
				],
				onAsk: (task, ask) => {
					if (ask.ask !== "followup") return
					const payload = JSON.parse(ask.text ?? "{}")
					assert.deepEqual(
						payload.requestUserInput.questions.map((question: { id: string }) => question.id),
						["approach", "validation"],
					)
					pendingGroupedRequests = task.clineMessages.filter(
						(message) => message.type === "ask" && message.ask === "followup" && !message.isAnswered,
					).length
					task.handleWebviewAskResponse(
						"messageResponse",
						JSON.stringify({
							answers: {
								approach: { answers: ["Focused (Recommended)"] },
								validation: { answers: ["Focused tests"] },
							},
						}),
					)
				},
			})
			assert.equal(asks.filter((ask) => ask === "followup").length, 1)
			assert.equal(pendingGroupedRequests, 1, "one grouped request should be pending while the user answers")
			const returnedAnswers = findRequestUserInputAnswerMap(modelInputs.at(-1))
			assert.deepEqual(returnedAnswers, {
				approach: { answers: ["Focused (Recommended)"] },
				validation: { answers: ["Focused tests"] },
			})
		})
	}
})
