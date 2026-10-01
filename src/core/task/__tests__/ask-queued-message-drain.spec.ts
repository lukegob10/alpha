import { Task } from "../Task"
import { createSubagentCommandApprovalPolicy } from "../../auto-approval/commands"
import type { AlphaMessage } from "@alpha-code/types"

// Keep this test focused: if a queued message arrives while Task.ask() is blocked,
// it should be consumed and used to fulfill the ask.

describe("Task.ask queued message drain", () => {
	const createAskOnlyTask = async () => {
		const task = Object.create(Task.prototype) as Task
		;(task as any).abort = false
		;(task as any).taskId = "task-1"
		;(task as any).clineMessages = []
		;(task as any).askResponse = undefined
		;(task as any).askResponseText = undefined
		;(task as any).askResponseImages = undefined
		;(task as any).lastMessageTs = undefined

		const { MessageQueueService } = await import("../../message-queue/MessageQueueService")
		;(task as any).messageQueueService = new MessageQueueService()
		;(task as any).addToAlphaMessages = vi.fn(async () => {})
		;(task as any).saveAlphaMessages = vi.fn(async () => {})
		;(task as any).updateAlphaMessage = vi.fn(async () => {})
		;(task as any).cancelAutoApprovalTimeout = vi.fn(() => {})
		;(task as any).checkpointSave = vi.fn(async () => {})
		;(task as any).emit = vi.fn()
		;(task as any).providerRef = { deref: () => undefined }
		return task
	}

	const inheritedCommandPolicy = {
		autoApprovalEnabled: true,
		alwaysAllowReadOnly: true,
		alwaysAllowReadOnlyOutsideWorkspace: false,
		alwaysAllowWrite: true,
		alwaysAllowWriteOutsideWorkspace: false,
		alwaysAllowWriteProtected: false,
		alwaysAllowExecute: true,
		alwaysAllowSubagents: true,
		commandApproval: createSubagentCommandApprovalPolicy(["git"], ["git push"], "7".repeat(64)),
	}

	it("accepts the first timestamp-correlated reply and rejects a second reply before polling consumes it", async () => {
		const task = await createAskOnlyTask()
		task["activeAsk"] = { type: "followup", ts: 101 }
		expect(task.handleWebviewAskResponse("messageResponse", "FIRST", [], undefined, 101)).toBe(true)
		expect(task.handleWebviewAskResponse("messageResponse", "SECOND", [], undefined, 101)).toBe(false)
		expect(task["askResponseText"]).toBe("FIRST")
		task["askResponse"] = undefined
		task["activeAsk"] = { type: "followup", ts: 102 }
		expect(task.handleWebviewAskResponse("messageResponse", "STALE", [], undefined, 101)).toBe(false)
		expect(task["askResponse"]).toBeUndefined()
	})

	it("binds durable ask feedback to the host tool call that opened the ask", async () => {
		const task = await createAskOnlyTask()
		const queue = task.messageQueueService
		const message = queue.addMessage("TOOL_FEEDBACK")!
		queue.claimMessage(message.id)
		const pending = task.withToolInputContext("call-with-question", () => task.ask("followup", "Question?", false))
		await vi.waitFor(() => expect(task["activeAsk"]?.toolCallId).toBe("call-with-question"))
		task.handleWebviewAskResponse("messageResponse", message.text, [], [message.id], task["activeAsk"]!.ts)
		await expect(pending).resolves.toMatchObject({ queuedMessageIds: [message.id] })
		expect(
			task["getQueuedInputReceipts"]([
				{ type: "tool_result", tool_use_id: "different-call", content: "feedback" },
			]),
		).toEqual([])
		expect(
			task["getQueuedInputReceipts"]([
				{ type: "tool_result", tool_use_id: "call-with-question", content: "feedback" },
			]),
		).toEqual([message.id])
	})

	it("marks a cancelled grouped follow-up ask answered in the transcript", async () => {
		const task = await createAskOnlyTask()
		;(task as any).taskKind = "primary"
		;(task as any).addToAlphaMessages = vi.fn(async (message: AlphaMessage) => {
			task.clineMessages.push(message)
		})

		const pending = task.ask(
			"followup",
			JSON.stringify({ requestUserInput: { questions: [{ id: "scope" }] } }),
			false,
		)
		await vi.waitFor(() => expect((task as any).activeAsk).toMatchObject({ type: "followup" }))

		task.handleWebviewAskResponse("noButtonClicked")
		await expect(pending).resolves.toMatchObject({ response: "noButtonClicked" })

		expect(task.clineMessages).toHaveLength(1)
		expect(task.clineMessages[0]).toMatchObject({ type: "ask", ask: "followup", isAnswered: true })
		expect(task["saveAlphaMessages"]).toHaveBeenCalledOnce()
	})

	it.each([
		{ taskKind: "primary", onScreen: true },
		{ taskKind: "primary", onScreen: false },
		{ taskKind: "subagent", onScreen: true },
		{ taskKind: "subagent", onScreen: false },
	])("honors command auto-approval for $taskKind tasks (on screen: $onScreen)", async ({ taskKind, onScreen }) => {
		const task = await createAskOnlyTask()
		Object.assign(task, {
			taskKind,
			subagentContextManifest: { runtimePolicy: { autoApproval: inheritedCommandPolicy } },
			providerRef: {
				deref: () => ({
					getState: async () => ({
						autoApprovalEnabled: true,
						alwaysAllowExecute: true,
						allowedCommands: ["*"],
					}),
					isTaskOnScreen: () => onScreen,
				}),
			},
		})
		const autoApprove = vi.spyOn(task, "approveAsk")
		const pending = task.ask("command", "git status", false)
		try {
			await vi.waitFor(() => expect(autoApprove).toHaveBeenCalledOnce())
			await expect(pending).resolves.toMatchObject({ response: "yesButtonClicked" })
		} finally {
			task.handleWebviewAskResponse("noButtonClicked")
			await pending
		}
	})

	it("preserves an explicit approval requirement despite wildcard auto-approval and retains the directory", async () => {
		const task = await createAskOnlyTask()
		Object.assign(task, {
			taskKind: "primary",
			providerRef: {
				deref: () => ({
					getState: async () => ({
						autoApprovalEnabled: true,
						alwaysAllowExecute: true,
						allowedCommands: ["*"],
					}),
					isTaskOnScreen: () => true,
				}),
			},
		})
		const autoApprove = vi.spyOn(task, "approveAsk")
		const pending = task.ask("command", "node script.js", false, { text: "../outside" }, false, true)
		await vi.waitFor(() => expect(task["addToAlphaMessages"]).toHaveBeenCalled())
		expect(autoApprove).not.toHaveBeenCalled()
		expect(task["addToAlphaMessages"]).toHaveBeenCalledWith(
			expect.objectContaining({ progressStatus: { text: "../outside" } }),
		)
		task.handleWebviewAskResponse("noButtonClicked")
		await expect(pending).resolves.toMatchObject({ response: "noButtonClicked" })
	})

	it("asks before a managed-child outside write in Auto despite a broad command allowlist", async () => {
		const task = await createAskOnlyTask()
		;(task as any).taskKind = "subagent"
		;(task as any).subagentContextManifest = { runtimePolicy: { autoApproval: inheritedCommandPolicy } }
		;(task as any).providerRef = {
			deref: () => ({
				getState: vi.fn(async () => ({
					...inheritedCommandPolicy,
					allowedCommands: ["*"],
					deniedCommands: [],
				})),
				isTaskOnScreen: vi.fn(() => true),
			}),
		}

		const autoApprove = vi.spyOn(task, "approveAsk")
		const pending = task.ask(
			"tool",
			JSON.stringify({ tool: "editedExistingFile", path: "protected.txt", isOutsideWorkspace: true }),
			false,
			undefined,
			true,
			true,
		)

		await vi.waitFor(() => expect(task["addToAlphaMessages"]).toHaveBeenCalled())
		expect(autoApprove).not.toHaveBeenCalled()
		task.handleWebviewAskResponse("yesButtonClicked")
		await expect(pending).resolves.toMatchObject({ response: "yesButtonClicked" })
	})

	it("keeps Ask review active even for a parent-authorized managed-child read", async () => {
		const task = await createAskOnlyTask()
		Object.assign(task, {
			taskApprovalMode: "ask",
			taskKind: "subagent",
			subagentAuthority: { role: "review", logicalWorkspace: "F:/workspace", approvalProvenance: "group" },
			subagentContextManifest: { runtimePolicy: { autoApproval: inheritedCommandPolicy } },
		})
		;(task as any).providerRef = {
			deref: () => ({
				getState: vi.fn(async () => ({ approvalMode: "ask" })),
				isTaskOnScreen: vi.fn(() => true),
			}),
		}

		const autoApprove = vi.spyOn(task, "approveAsk")
		const askPromise = task.ask("tool", JSON.stringify({ tool: "readFile", path: "src/index.ts" }), false)
		await vi.waitFor(() => expect(task["addToAlphaMessages"]).toHaveBeenCalled())
		expect(autoApprove).not.toHaveBeenCalled()
		task.handleWebviewAskResponse("yesButtonClicked")

		await expect(askPromise).resolves.toMatchObject({ response: "yesButtonClicked" })
	})

	it("asks before a managed-child command outside its captured allowlist in Auto", async () => {
		const task = await createAskOnlyTask()
		;(task as any).taskKind = "subagent"
		;(task as any).subagentContextManifest = { runtimePolicy: { autoApproval: inheritedCommandPolicy } }
		;(task as any).providerRef = {
			deref: () => ({
				getState: vi.fn(async () => ({ approvalMode: "auto", allowedCommands: ["*"], deniedCommands: [] })),
				isTaskOnScreen: vi.fn(() => true),
			}),
		}

		const autoApprove = vi.spyOn(task, "approveAsk")
		const pending = task.ask("command", "pnpm test", false, undefined, false, true)
		await vi.waitFor(() => expect(task["addToAlphaMessages"]).toHaveBeenCalled())
		expect(autoApprove).not.toHaveBeenCalled()
		task.handleWebviewAskResponse("yesButtonClicked")
		await expect(pending).resolves.toMatchObject({ response: "yesButtonClicked" })
	})

	it("fails closed for a retained managed child without a captured approval ceiling", async () => {
		const task = await createAskOnlyTask()
		;(task as any).taskKind = "subagent"
		;(task as any).subagentContextManifest = { runtimePolicy: {} }
		;(task as any).providerRef = {
			deref: () => ({
				getState: vi.fn(async () => ({
					autoApprovalEnabled: true,
					alwaysAllowExecute: true,
					allowedCommands: ["*"],
					deniedCommands: [],
				})),
				isTaskOnScreen: vi.fn(() => true),
			}),
		}

		const askPromise = task.ask("command", "pnpm test", false)
		setTimeout(() => {
			;(task as any).handleWebviewAskResponse("messageResponse", "legacy child requires approval")
		}, 0)

		await expect(askPromise).resolves.toMatchObject({
			response: "messageResponse",
			text: "legacy child requires approval",
		})
	})

	it.each(["followup", "tool", "command"] as const)(
		"does not consume queued messages while blocked on %s ask",
		async (askType) => {
			const task = await createAskOnlyTask()

			const askPromise = task.ask(askType, "Q?", false)
			;(task as any).messageQueueService.addMessage("queued next turn")

			setTimeout(() => {
				;(task as any).handleWebviewAskResponse("messageResponse", "manual response")
			}, 0)

			const result = await askPromise

			expect(result.response).toBe("messageResponse")
			expect(result.text).toBe("manual response")
			expect((task as any).messageQueueService.isEmpty()).toBe(false)
			expect((task as any).messageQueueService.messages[0]?.text).toBe("queued next turn")
		},
	)

	it("consumes queued message while blocked on completion ask", async () => {
		const task = await createAskOnlyTask()

		const askPromise = task.ask("completion_result", "Done", false)

		;(task as any).messageQueueService.addMessage("picked answer")

		const result = await askPromise
		expect(result.response).toBe("messageResponse")
		expect(result.text).toBe("picked answer")
	})

	it("announces an interactive question with its task identity despite queued next-turn input", async () => {
		vi.useFakeTimers()
		const task = await createAskOnlyTask()
		const postMessageToWebview = vi.fn()
		Object.assign(task, {
			addToAlphaMessages: vi.fn(async (message: AlphaMessage) => task.clineMessages.push(message)),
			providerRef: {
				deref: () => ({ getState: async () => ({}), isTaskOnScreen: () => true, postMessageToWebview }),
			},
		})
		task.messageQueueService.addMessage("Keep this for the next turn")
		const pending = task.ask("followup", "Which option?", false)
		try {
			await vi.advanceTimersByTimeAsync(2_100)
			expect(postMessageToWebview).toHaveBeenCalledWith({ type: "interactionRequired", taskId: "task-1" })
			expect(task.messageQueueService.messages[0]?.text).toBe("Keep this for the next turn")
		} finally {
			task.handleWebviewAskResponse("noButtonClicked")
			await vi.advanceTimersByTimeAsync(250)
			try {
				await pending
			} finally {
				vi.useRealTimers()
			}
		}
	})

	it("forwards a Worker's blocked approval even when later guidance is queued", async () => {
		const task = await createAskOnlyTask()
		const surfaceSubagentApproval = vi.fn(async () => undefined)
		Object.assign(task, {
			subagentRole: "worker",
			providerRef: {
				deref: () => ({
					getState: async () => ({}),
					isTaskOnScreen: () => true,
					surfaceSubagentApproval,
					clearSubagentApproval: async () => undefined,
				}),
			},
		})
		task.messageQueueService.addMessage("Then inspect the results")
		const pending = task.ask("command", "node script.js", false, undefined, false, true)
		try {
			await vi.waitFor(() =>
				expect(surfaceSubagentApproval).toHaveBeenCalledWith(task, "command", "node script.js"),
			)
			expect(task.messageQueueService.messages).toHaveLength(1)
		} finally {
			task.handleWebviewAskResponse("noButtonClicked")
			await pending
		}
	})

	it.each(["completion_result", "resume_task", "resume_completed_task"] as const)(
		"consumes exactly one pre-queued message in FIFO order for %s",
		async (askType) => {
			const task = await createAskOnlyTask()
			;(task as any).messageQueueService.addMessage("first queued turn")
			;(task as any).messageQueueService.addMessage("second queued turn")

			const result = await task.ask(askType, "Done", false)

			expect(result).toMatchObject({ response: "messageResponse", text: "first queued turn" })
			expect((task as any).messageQueueService.messages).toHaveLength(1)
			expect((task as any).messageQueueService.messages[0]?.text).toBe("second queued turn")
		},
	)

	it("retains host input sent before a restored task installs its resume ask", async () => {
		const task = await createAskOnlyTask()
		;(task as any).initialHistoryResumePending = true
		;(task as any).providerRef = {
			deref: () => ({
				getState: vi.fn(async () => undefined),
				isTaskOnScreen: vi.fn(() => true),
			}),
		}
		const handleResponseSpy = vi.spyOn(task, "handleWebviewAskResponse")

		await task.submitUserMessage("continue the restored task", ["image1.png"])

		expect(handleResponseSpy).not.toHaveBeenCalled()
		expect(task.messageQueueService.messages).toMatchObject([
			{ text: "continue the restored task", images: ["image1.png"] },
		])

		const result = await task.ask("resume_completed_task", "Resume?", false)

		expect(result).toMatchObject({
			response: "messageResponse",
			text: "continue the restored task",
			images: ["image1.png"],
		})
		expect(task.messageQueueService.isEmpty()).toBe(true)
	})

	it("settles a blocked ask when the task is aborted", async () => {
		const task = await createAskOnlyTask()
		const askPromise = task.ask("followup", "Q?", false)

		;(task as any).abort = true

		await expect(askPromise).rejects.toThrow("aborted")
		expect((task as any).activeAsk).toBeUndefined()
	})

	it("does not consume queued messages for command_output asks", async () => {
		const task = await createAskOnlyTask()

		const askPromise = task.ask("command_output", "command is still running...", false)
		;(task as any).messageQueueService.addMessage("1+1=?")

		setTimeout(() => {
			task.approveAsk()
		}, 0)

		const result = await askPromise

		expect(result.response).toBe("yesButtonClicked")
		expect(result.text).toBeUndefined()
		expect((task as any).messageQueueService.isEmpty()).toBe(false)
		expect((task as any).messageQueueService.messages[0]?.text).toBe("1+1=?")
	})

	it("auto-continues command output when the task is off-screen", async () => {
		const task = await createAskOnlyTask()
		;(task as any).providerRef = {
			deref: () => ({
				getState: vi.fn(async () => undefined),
				isTaskOnScreen: vi.fn(() => false),
			}),
		}

		const result = await task.ask("command_output", "command is still running...", false)

		expect(result.response).toBe("messageResponse")
		expect(result.text).toBeUndefined()
	})

	it("auto-feeds recovery guidance for off-screen mistake-limit asks", async () => {
		const task = await createAskOnlyTask()
		;(task as any).providerRef = {
			deref: () => ({
				getState: vi.fn(async () => undefined),
				isTaskOnScreen: vi.fn(() => false),
			}),
		}

		const result = await task.ask("mistake_limit_reached", "generic guidance", false)

		expect(result.response).toBe("messageResponse")
		expect(result.text).toContain("Continue independent authorized work where possible")
		expect(result.text).toContain("ordinary final answer")
		expect(result.text).toContain("spawn_agent by itself")
	})

	it("auto-answers off-screen follow-up asks with the first suggestion", async () => {
		const task = await createAskOnlyTask()
		;(task as any).providerRef = {
			deref: () => ({
				getState: vi.fn(async () => undefined),
				isTaskOnScreen: vi.fn(() => false),
			}),
		}

		const result = await task.ask(
			"followup",
			JSON.stringify({
				question: "Which path?",
				suggest: [{ answer: "Use option A" }, { answer: "Use option B" }],
			}),
			false,
		)

		expect(result.response).toBe("messageResponse")
		expect(result.text).toBe("Use option A")
	})

	it("auto-answers off-screen follow-up asks with guidance when no suggestion is available", async () => {
		const task = await createAskOnlyTask()
		;(task as any).providerRef = {
			deref: () => ({
				getState: vi.fn(async () => undefined),
				isTaskOnScreen: vi.fn(() => false),
			}),
		}

		const result = await task.ask("followup", JSON.stringify({ question: "Which path?", suggest: [] }), false)

		expect(result.response).toBe("messageResponse")
		expect(result.text).toContain("Continue without waiting for the user")
	})

	it("auto-approves off-screen completion asks so background tasks finalize", async () => {
		const task = await createAskOnlyTask()
		;(task as any).providerRef = {
			deref: () => ({
				getState: vi.fn(async () => undefined),
				isTaskOnScreen: vi.fn(() => false),
			}),
		}

		const result = await task.ask("completion_result", "Done", false)

		expect(result.response).toBe("yesButtonClicked")
		expect(result.text).toBeUndefined()
	})

	it.each(["resume_task", "resume_completed_task"] as const)(
		"does not auto-approve off-screen %s asks",
		async (askType) => {
			const task = await createAskOnlyTask()
			;(task as any).providerRef = {
				deref: () => ({
					getState: vi.fn(async () => undefined),
					isTaskOnScreen: vi.fn(() => false),
				}),
			}

			const askPromise = task.ask(askType, "Done", false)

			await new Promise((resolve) => setTimeout(resolve, 20))

			expect((task as any).askResponse).toBeUndefined()
			;(task as any).handleWebviewAskResponse("messageResponse", "manual response")

			const result = await askPromise

			expect(result.response).toBe("messageResponse")
			expect(result.text).toBe("manual response")
		},
	)

	it("keeps on-screen mistake-limit asks interactive", async () => {
		const task = await createAskOnlyTask()
		;(task as any).providerRef = {
			deref: () => ({
				getState: vi.fn(async () => undefined),
				isTaskOnScreen: vi.fn(() => true),
			}),
		}

		const askPromise = task.ask("mistake_limit_reached", "generic guidance", false)

		setTimeout(() => {
			;(task as any).handleWebviewAskResponse("messageResponse", "manual guidance")
		}, 0)

		const result = await askPromise

		expect(result.response).toBe("messageResponse")
		expect(result.text).toBe("manual guidance")
	})

	it("auto-approves off-screen delegation control asks", async () => {
		const task = await createAskOnlyTask()
		;(task as any).providerRef = {
			deref: () => ({
				getState: vi.fn(async () => undefined),
				isTaskOnScreen: vi.fn(() => false),
			}),
		}

		const result = await task.ask("tool", JSON.stringify({ tool: "newTask", mode: "Code" }), false)

		expect(result.response).toBe("yesButtonClicked")
	})

	it("auto-approves on-screen delegation control asks when auto-approval is enabled", async () => {
		const task = await createAskOnlyTask()
		;(task as any).providerRef = {
			deref: () => ({
				getState: vi.fn(async () => ({
					autoApprovalEnabled: true,
					alwaysAllowSubtasks: false,
				})),
				isTaskOnScreen: vi.fn(() => true),
			}),
		}

		const result = await task.ask("tool", JSON.stringify({ tool: "newTask", mode: "Architect" }), false)

		expect(result.response).toBe("yesButtonClicked")
	})

	it("auto-approves an on-screen sub-agent in Auto", async () => {
		const task = await createAskOnlyTask()
		;(task as any).providerRef = {
			deref: () => ({
				getState: vi.fn(async () => ({
					approvalMode: "auto",
					autoApprovalEnabled: true,
					alwaysAllowSubagents: true,
					alwaysAllowReadOnly: true,
				})),
				isTaskOnScreen: vi.fn(() => true),
			}),
		}

		const autoApprove = vi.spyOn(task, "approveAsk")
		const result = await task.ask("tool", JSON.stringify({ tool: "spawnAgent", agent: { role: "explore" } }), false)
		expect(autoApprove).toHaveBeenCalled()
		expect(result.response).toBe("yesButtonClicked")
	})

	it("does not auto-approve protected off-screen tool asks", async () => {
		const task = await createAskOnlyTask()
		;(task as any).providerRef = {
			deref: () => ({
				getState: vi.fn(async () => undefined),
				isTaskOnScreen: vi.fn(() => false),
			}),
		}

		const askPromise = task.ask("tool", JSON.stringify({ tool: "writeToFile" }), false, undefined, true)

		setTimeout(() => {
			task.approveAsk()
		}, 0)

		const result = await askPromise

		expect(result.response).toBe("yesButtonClicked")
	})
})
